import axios from "axios";

import { hashSessionId } from "../scrubbing";
import { SecployGate, SecurityGateBlocked, normalizeEndpoint } from "../gate";
import { IdentityReporter } from "../identityReporter";
import { PolicySnapshot, SecurityPolicyCache } from "../policyCache";
import { GateMode, PolicyPayload } from "../types";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const BLOCK_RULE = {
  id: "r1",
  method: "POST",
  path_pattern: "^/admin",
  reason: "manual block",
  is_active: true,
};

function policy(rules: any[] = [], controls: any[] = []): PolicyPayload {
  return { version: "v1", ttl_seconds: 300, blocked_endpoints: rules, controls };
}

function buildGate(mode: GateMode, snapshot: PolicyPayload | null, sendEvent = jest.fn()) {
  const cache = new SecurityPolicyCache({
    apiUrl: "https://api.secploy.com",
    headersCallback: () => ({}),
  });
  if (snapshot) (cache as any).snapshotRef = new PolicySnapshot(snapshot);

  const identities = new IdentityReporter({
    apiUrl: "https://api.secploy.com",
    headersCallback: () => ({}),
  });

  const gate = new SecployGate({
    apiUrl: "https://api.secploy.com",
    apiKey: "pk-1",
    environmentKey: "ek-1",
    headersCallback: () => ({}),
    policyCache: cache,
    identityReporter: identities,
    gateMode: mode,
    sendEvent,
  });

  return { gate, cache, identities, sendEvent };
}

/** The API replying "allowed". */
function remoteAllows() {
  mockedAxios.get.mockResolvedValue({
    status: 200,
    data: { blocked: false, method: "POST", endpoint: "/admin" },
  });
}

beforeEach(() => jest.clearAllMocks());

describe("normalizeEndpoint", () => {
  it("keeps a plain path", () => {
    expect(normalizeEndpoint("/admin/users")).toBe("/admin/users");
  });

  it("strips scheme and host", () => {
    expect(normalizeEndpoint("https://app.example.com/admin/users")).toBe("/admin/users");
  });

  it("drops query and fragment", () => {
    expect(normalizeEndpoint("/search?q=1#top")).toBe("/search");
  });

  it("adds a leading slash", () => {
    expect(normalizeEndpoint("admin")).toBe("/admin");
  });

  it("returns empty for empty input", () => {
    expect(normalizeEndpoint("")).toBe("");
  });
});

describe("gate modes", () => {
  it("always calls the API in remote mode", async () => {
    remoteAllows();
    const { gate } = buildGate("remote", policy([BLOCK_RULE]));
    await gate.inspect({ method: "POST", endpoint: "/admin" });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("makes no network call in cached mode", async () => {
    const { gate } = buildGate("cached", policy([BLOCK_RULE]));
    const decision = await gate.inspect({ method: "POST", endpoint: "/admin" });

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("blocked_by_endpoint_rule");
  });

  it("falls back to the API while the snapshot is still loading", async () => {
    remoteAllows();
    const { gate } = buildGate("cached", null);
    await gate.inspect({ method: "POST", endpoint: "/admin" });
    // Falling back keeps early requests correct rather than waving them through.
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("returns the remote decision in shadow mode", async () => {
    remoteAllows();
    const { gate } = buildGate("shadow", policy([BLOCK_RULE]));
    const decision = await gate.inspect({ method: "POST", endpoint: "/admin" });

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(decision.blocked).toBe(false); // remote said allow, and it wins
  });

  it("reports a shadow mismatch", async () => {
    remoteAllows();
    const { gate, sendEvent } = buildGate("shadow", policy([BLOCK_RULE]));
    await gate.inspect({ method: "POST", endpoint: "/admin" });

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const [eventType, body] = sendEvent.mock.calls[0];
    expect(eventType).toBe("secploy.gate.shadow_mismatch");
    expect(body.local.blocked).toBe(true);
    expect(body.remote.blocked).toBe(false);
  });

  it("stays quiet in shadow mode when both agree", async () => {
    remoteAllows();
    const { gate, sendEvent } = buildGate("shadow", policy());
    await gate.inspect({ method: "POST", endpoint: "/admin" });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("does not report a mismatch when the remote lookup failed", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network down"));
    const { gate, sendEvent } = buildGate("shadow", policy([BLOCK_RULE]));
    await gate.inspect({ method: "POST", endpoint: "/admin" });
    // A failed lookup is not evidence that the cache is wrong.
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe("fail open", () => {
  it("allows the request when the API is unreachable", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network down"));
    const { gate } = buildGate("remote", null);
    const decision = await gate.inspect({ method: "GET", endpoint: "/x" });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("lookup_unavailable");
  });

  it("keeps enforcing from cache when the API is unreachable", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network down"));
    const { gate } = buildGate("cached", policy([BLOCK_RULE]));
    const decision = await gate.inspect({ method: "POST", endpoint: "/admin" });

    // The cached gate is strictly safer during an outage: it still blocks.
    expect(decision.blocked).toBe(true);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe("check", () => {
  it("throws SecurityGateBlocked on a blocked request", async () => {
    const { gate } = buildGate("cached", policy([BLOCK_RULE]));
    await expect(gate.check({ method: "POST", endpoint: "/admin" })).rejects.toBeInstanceOf(
      SecurityGateBlocked,
    );
  });

  it("returns the decision when allowed", async () => {
    const { gate } = buildGate("cached", policy());
    const decision = await gate.check({ method: "GET", endpoint: "/x" });
    expect(decision.allowed).toBe(true);
  });

  it("carries the control detail onto the error", async () => {
    const control = {
      id: "c1",
      action_type: "revoke_session",
      target_type: "session",
      target: hashSessionId("sess-1"),
      status: "applied",
      metadata: {},
    };
    const { gate } = buildGate("cached", policy([], [control]));
    try {
      await gate.check({ method: "GET", endpoint: "/x" }, { sessionId: "sess-1" });
      throw new Error("should have thrown");
    } catch (error) {
      const blocked = error as SecurityGateBlocked;
      expect(blocked.actionType).toBe("revoke_session");
      expect(blocked.target).toBe(hashSessionId("sess-1"));
      expect(blocked.reason).toBe("blocked_by_control_action");
    }
  });
});

describe("identity resolution", () => {
  it("reads user, session and ip off an express-style request", () => {
    const { gate } = buildGate("cached", policy());
    const auth = gate.resolveAuth({
      method: "GET",
      url: "/x",
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      user: { id: 42, email: "a@example.com", name: "Ada" },
      session: { id: "sess-1" },
      socket: { remoteAddress: "10.0.0.1" },
    });

    expect(auth.userId).toBe("42");
    expect(auth.identityKey).toBe("42");
    // Hashed on the way out: a session cookie read from an event store can be
    // replayed, so the value that leaves is one that identifies without
    // granting.
    expect(auth.sessionId).toBe(hashSessionId("sess-1"));
    expect(auth.sessionId).not.toBe("sess-1");
    expect(auth.ipAddress).toBe("203.0.113.7"); // first hop, not the proxy
    expect(auth.email).toBe("a@example.com");
    expect(auth.isAuthenticated).toBe(true);
  });

  it("marks an anonymous request unauthenticated", () => {
    const { gate } = buildGate("cached", policy());
    const auth = gate.resolveAuth({ method: "GET", url: "/x", headers: {} });
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.userId).toBeUndefined();
  });

  it("honours a custom identityResolver", async () => {
    const cache = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => ({}),
    });
    (cache as any).snapshotRef = new PolicySnapshot(policy());
    const gate = new SecployGate({
      apiUrl: "https://api.secploy.com",
      apiKey: "pk-1",
      environmentKey: "ek-1",
      headersCallback: () => ({}),
      policyCache: cache,
      identityReporter: new IdentityReporter({
        apiUrl: "https://api.secploy.com",
        headersCallback: () => ({}),
      }),
      gateMode: "cached",
      identityResolver: () => ({ identityKey: "custom-1" }),
    });

    expect(gate.resolveAuth({}).identityKey).toBe("custom-1");
  });

  it("falls back to defaults when identityResolver throws", () => {
    const cache = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => ({}),
    });
    const gate = new SecployGate({
      apiUrl: "https://api.secploy.com",
      apiKey: "pk-1",
      environmentKey: "ek-1",
      headersCallback: () => ({}),
      policyCache: cache,
      identityReporter: new IdentityReporter({
        apiUrl: "https://api.secploy.com",
        headersCallback: () => ({}),
      }),
      gateMode: "cached",
      identityResolver: () => {
        throw new Error("bad resolver");
      },
    });

    // A broken resolver must not take the application down.
    expect(() => gate.resolveAuth({ headers: {} })).not.toThrow();
  });
});

describe("identity reporting on the cached path", () => {
  it("records the identity when no API call would", async () => {
    const { gate, identities } = buildGate("cached", policy());
    const spy = jest.spyOn(identities, "record");
    await gate.inspect({ method: "GET", endpoint: "/x" }, { identityKey: "user-1" });
    // Without this, caching the gate would silently stop identity telemetry.
    expect(spy).toHaveBeenCalledWith({ identityKey: "user-1" });
  });
});

describe("express middleware", () => {
  function res() {
    const out: any = {};
    out.status = jest.fn().mockReturnValue(out);
    out.json = jest.fn().mockReturnValue(out);
    return out;
  }

  it("calls next when allowed", async () => {
    const { gate } = buildGate("cached", policy());
    const next = jest.fn();
    const response = res();

    await new Promise<void>((resolve) => {
      gate.express()({ method: "GET", url: "/x", headers: {} }, response, () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("returns 403 and never reaches the route when blocked", async () => {
    const { gate } = buildGate("cached", policy([BLOCK_RULE]));
    const next = jest.fn();
    const response = res();
    response.json.mockImplementation(() => response);

    gate.express()({ method: "POST", url: "/admin/users", headers: {} }, response, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next on a non-block error so an outage cannot take the app down", async () => {
    const { gate } = buildGate("cached", policy());
    jest.spyOn(gate, "check").mockRejectedValue(new Error("unexpected"));
    const next = jest.fn();

    gate.express()({ method: "GET", url: "/x", headers: {} }, res(), next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
