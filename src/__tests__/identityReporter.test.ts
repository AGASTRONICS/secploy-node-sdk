import axios from "axios";

import { hashSessionId } from "../scrubbing";
import { IdentityReporter, IdentityReporterOptions } from "../identityReporter";
import { SecurityGateAuthContext } from "../types";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const AUTH: SecurityGateAuthContext = {
  identityKey: "user-1",
  userId: "user-1",
  email: "a@example.com",
  sessionId: "sess-1",
  ipAddress: "1.2.3.4",
  isAuthenticated: true,
};

function reporter(options: Partial<IdentityReporterOptions> = {}) {
  return new IdentityReporter({
    apiUrl: "https://api.secploy.com",
    headersCallback: () => ({}),
    ...options,
  });
}

function sentIdentities() {
  return mockedAxios.post.mock.calls[0][1] as { identities: Record<string, any>[] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.post.mockResolvedValue({ status: 202 });
});

describe("deduplication", () => {
  it("queues a first sighting", () => {
    const r = reporter();
    expect(r.record(AUTH)).toBe(true);
    expect(r.pendingCount).toBe(1);
  });

  it("suppresses repeat sightings", () => {
    const r = reporter();
    r.record(AUTH);
    // The property that matters: steady traffic from a known user must not
    // produce one report per request.
    for (let i = 0; i < 500; i += 1) {
      expect(r.record(AUTH)).toBe(false);
    }
    expect(r.pendingCount).toBe(1);
  });

  it("re-reports a changed identity", () => {
    const r = reporter();
    r.record(AUTH);
    expect(r.record({ ...AUTH, ipAddress: "9.9.9.9" })).toBe(true);
  });

  it("re-reports a changed session", () => {
    const r = reporter();
    r.record(AUTH);
    expect(r.record({ ...AUTH, sessionId: "sess-2" })).toBe(true);
  });

  it("re-reports once the interval lapses", () => {
    const r = reporter({ reportInterval: 0 });
    r.record(AUTH);
    expect(r.record(AUTH)).toBe(true);
  });

  it("tracks distinct identities separately", () => {
    const r = reporter();
    r.record(AUTH);
    r.record({ ...AUTH, identityKey: "user-2", userId: "user-2" });
    expect(r.pendingCount).toBe(2);
  });

  it("ignores anonymous and empty identities", () => {
    const r = reporter();
    expect(r.record(null)).toBe(false);
    expect(r.record({})).toBe(false);
    expect(r.record({ identityKey: "anonymous" })).toBe(false);
    expect(r.record({ identityKey: "   " })).toBe(false);
    expect(r.pendingCount).toBe(0);
  });

  it("uses userId when identityKey is absent", () => {
    expect(reporter().record({ userId: "user-9" })).toBe(true);
  });

  it("bounds the tracking table", () => {
    // A high-cardinality identity key must not grow memory without bound.
    const r = reporter({ maxTracked: 10, maxBatch: 10_000 });
    for (let i = 0; i < 50; i += 1) r.record({ identityKey: `user-${i}` });
    expect((r as any).seen.size).toBeLessThanOrEqual(10);
  });
});

describe("merging", () => {
  it("merges a sparse sighting into the richer one", async () => {
    const r = reporter();
    r.record(AUTH);
    r.record({ identityKey: "user-1", name: "Ada L." });
    await r.flush();

    const [record] = sentIdentities().identities;
    // Regression: the sparse sighting used to replace the whole record.
    expect(record.name).toBe("Ada L.");
    expect(record.email).toBe("a@example.com");
    expect(record.ip_address).toBe("1.2.3.4");
    expect(record.session_id).toBe(hashSessionId("sess-1"));
  });

  it("omits absent fields instead of sending nulls", async () => {
    const r = reporter();
    r.record({ identityKey: "user-9" });
    await r.flush();

    const [record] = sentIdentities().identities;
    // Sending nulls would let a sparse sighting blank fields server-side.
    expect(record).not.toHaveProperty("email");
    expect(record).not.toHaveProperty("name");
  });

  it("carries an explicit false", async () => {
    const r = reporter();
    r.record({ identityKey: "user-9", isAuthenticated: false });
    await r.flush();

    const [record] = sentIdentities().identities;
    expect(record).toHaveProperty("is_authenticated");
    expect(record.is_authenticated).toBe(false);
  });
});

describe("flush", () => {
  it("sends pending identities in the wire format", async () => {
    const r = reporter();
    r.record(AUTH);
    expect(await r.flush()).toBe(1);

    const [record] = sentIdentities().identities;
    expect(record.identity_key).toBe("user-1");
    expect(record.session_id).toBe(hashSessionId("sess-1"));
    expect(record).toHaveProperty("last_seen_at");
    expect(r.pendingCount).toBe(0);
  });

  it("makes no request with nothing pending", async () => {
    expect(await reporter().flush()).toBe(0);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("requeues on a network failure", async () => {
    mockedAxios.post.mockRejectedValue(new Error("boom"));
    const r = reporter();
    r.record(AUTH);
    expect(await r.flush()).toBe(0);
    expect(r.pendingCount).toBe(1);
  });

  it("requeues on a server error", async () => {
    mockedAxios.post.mockResolvedValue({ status: 503 });
    const r = reporter();
    r.record(AUTH);
    await r.flush();
    expect(r.pendingCount).toBe(1);
  });

  it("does not requeue on a client error", async () => {
    mockedAxios.post.mockResolvedValue({ status: 401 });
    const r = reporter();
    r.record(AUTH);
    await r.flush();
    // Retrying a rejected batch forever would just leak memory.
    expect(r.pendingCount).toBe(0);
  });

  it("never rejects into the caller", async () => {
    const r = reporter({
      headersCallback: () => {
        throw new Error("no creds");
      },
    });
    r.record(AUTH);
    await expect(r.flush()).resolves.toBeDefined();
  });
});
