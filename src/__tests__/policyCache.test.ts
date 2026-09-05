import axios from "axios";

import { PolicySnapshot, SecurityPolicyCache } from "../policyCache";
import { hashSessionId } from "../scrubbing";
import { BlockedEndpointRule, ControlAction, PolicyPayload } from "../types";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

function rule(
  overrides: Partial<BlockedEndpointRule> = {},
): BlockedEndpointRule {
  return {
    id: "r1",
    method: "POST",
    path_pattern: "^/admin",
    reason: "manual block",
    is_active: true,
    ...overrides,
  };
}

function control(overrides: Partial<ControlAction> = {}): ControlAction {
  return {
    id: "c1",
    action_type: "block_identity",
    target_type: "identity",
    target: "user-1",
    reason: "risk",
    status: "applied",
    source: "automated",
    identity_key: "user-1",
    risk_score: 90,
    expires_at: null,
    metadata: {},
    ...overrides,
  };
}

function payload(
  rules: BlockedEndpointRule[] = [],
  controls: ControlAction[] = [],
  version = "v1",
): PolicyPayload {
  return {
    version,
    generated_at: new Date().toISOString(),
    ttl_seconds: 300,
    blocked_endpoints: rules,
    controls,
  };
}

function cacheWith(body: PolicyPayload): SecurityPolicyCache {
  const cache = new SecurityPolicyCache({
    apiUrl: "https://api.secploy.com",
    headersCallback: () => ({}),
  });
  (cache as any).snapshotRef = new PolicySnapshot(body);
  return cache;
}

describe("rule matching", () => {
  it("blocks on a matching rule", () => {
    const result = cacheWith(payload([rule()])).evaluate(
      "POST",
      "/admin/users",
    )!;
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("blocked_by_endpoint_rule");
    expect(result.rule!.id).toBe("r1");
  });

  it("treats the method as part of the match", () => {
    expect(
      cacheWith(payload([rule()])).evaluate("GET", "/admin/users")!.blocked,
    ).toBe(false);
  });

  it("allows a non-matching path", () => {
    const result = cacheWith(payload([rule()])).evaluate(
      "POST",
      "/public/health",
    )!;
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("takes the first rule in snapshot order", () => {
    // The API orders rules newest-first and takes the first match, so snapshot
    // order decides which rule is reported.
    const cache = cacheWith(
      payload([
        rule({ id: "newer", path_pattern: "^/admin" }),
        rule({ id: "older", path_pattern: "^/admin/users" }),
      ]),
    );
    expect(cache.evaluate("POST", "/admin/users")!.rule!.id).toBe("newer");
  });

  it("falls back to exact match on an invalid pattern", () => {
    const cache = cacheWith(payload([rule({ path_pattern: "[unclosed" })]));
    expect(cache.evaluate("POST", "[unclosed")!.blocked).toBe(true);
    expect(cache.evaluate("POST", "/admin")!.blocked).toBe(false);
  });

  it("does not let a compiled pattern go stateful across calls", () => {
    // A RegExp built with the g flag carries lastIndex between tests, which
    // would make the same request alternate between blocked and allowed.
    const cache = cacheWith(payload([rule({ path_pattern: "admin" })]));
    for (let i = 0; i < 5; i += 1) {
      expect(cache.evaluate("POST", "/admin/users")!.blocked).toBe(true);
    }
  });
});

describe("control matching", () => {
  it("matches an identity control on identityKey", () => {
    const result = cacheWith(payload([], [control()])).evaluate("GET", "/x", {
      identityKey: "user-1",
    })!;
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("blocked_by_control_action");
  });

  it("matches an identity control on userId", () => {
    expect(
      cacheWith(payload([], [control()])).evaluate("GET", "/x", {
        userId: "user-1",
      })!.blocked,
    ).toBe(true);
  });

  it("matches a session control", () => {
    const cache = cacheWith(
      // The target is the hashed session, because that is what the SDK
      // reported and therefore what the control was created against. A raw
      // session identifier never reaches the API to be targeted.
      payload(
        [],
        [control({ target_type: "session", target: hashSessionId("sess-9") })],
      ),
    );
    expect(cache.evaluate("GET", "/x", { sessionId: "sess-9" })!.blocked).toBe(
      true,
    );
  });

  it("matches an ip control on either address field", () => {
    const cache = cacheWith(
      payload([], [control({ target_type: "ip", target: "1.2.3.4" })]),
    );
    expect(cache.evaluate("GET", "/x", { ipAddress: "1.2.3.4" })!.blocked).toBe(
      true,
    );
    expect(
      cache.evaluate("GET", "/x", { remoteAddr: "1.2.3.4" })!.blocked,
    ).toBe(true);
  });

  it("matches an api_key control on the project or environment key", () => {
    const cache = cacheWith(
      payload([], [control({ target_type: "api_key", target: "pk-1" })]),
    );
    expect(cache.evaluate("GET", "/x", {}, "pk-1")!.blocked).toBe(true);

    const envCache = cacheWith(
      payload([], [control({ target_type: "api_key", target: "ek-1" })]),
    );
    expect(envCache.evaluate("GET", "/x", {}, "", "ek-1")!.blocked).toBe(true);
  });

  it("does not look up controls without an identity", () => {
    expect(
      cacheWith(payload([], [control()])).evaluate("GET", "/x")!.blocked,
    ).toBe(false);
  });

  it("ignores an inactive control", () => {
    const cache = cacheWith(payload([], [control({ status: "expired" })]));
    expect(
      cache.evaluate("GET", "/x", { identityKey: "user-1" })!.blocked,
    ).toBe(false);
  });

  it("ignores a control that expired while still in the snapshot", () => {
    // A snapshot can outlive a control's expiry, so expiry is re-checked
    // locally. Enforcing a lapsed control blocks a request that should pass.
    const past = new Date(Date.now() - 5 * 60_000).toISOString();
    const cache = cacheWith(payload([], [control({ expires_at: past })]));
    expect(
      cache.evaluate("GET", "/x", { identityKey: "user-1" })!.blocked,
    ).toBe(false);
  });

  it("still applies an unexpired control", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const cache = cacheWith(payload([], [control({ expires_at: future })]));
    expect(
      cache.evaluate("GET", "/x", { identityKey: "user-1" })!.blocked,
    ).toBe(true);
  });

  it("returns a control matched twice only once", () => {
    const result = cacheWith(payload([], [control()])).evaluate("GET", "/x", {
      identityKey: "user-1",
      userId: "user-1",
    })!;
    expect(result.controls).toHaveLength(1);
  });
});

describe("endpoint scoping", () => {
  const scoped = (scope: Record<string, any>) =>
    cacheWith(payload([], [control({ metadata: { endpoint_scope: scope } })]));

  it("applies on a matching path", () => {
    const cache = scoped({ method: "POST", path_pattern: "^/pay" });
    expect(
      cache.evaluate("POST", "/pay/charge", { identityKey: "user-1" })!.blocked,
    ).toBe(true);
  });

  it("is skipped on another path", () => {
    const cache = scoped({ method: "POST", path_pattern: "^/pay" });
    expect(
      cache.evaluate("POST", "/profile", { identityKey: "user-1" })!.blocked,
    ).toBe(false);
  });

  it("is skipped on another method", () => {
    const cache = scoped({ method: "POST", path_pattern: "^/pay" });
    expect(
      cache.evaluate("GET", "/pay/charge", { identityKey: "user-1" })!.blocked,
    ).toBe(false);
  });

  it("applies to every path when the scope is method-only", () => {
    const cache = scoped({ method: "DELETE" });
    expect(
      cache.evaluate("DELETE", "/anything", { identityKey: "user-1" })!.blocked,
    ).toBe(true);
  });

  it("stays project-wide without a scope", () => {
    const cache = cacheWith(payload([], [control()]));
    expect(
      cache.evaluate("GET", "/anything", { identityKey: "user-1" })!.blocked,
    ).toBe(true);
  });
});

describe("snapshot", () => {
  it("buckets rules by method and compiles them once", () => {
    const snap = new PolicySnapshot(
      payload([rule(), rule({ id: "r2", method: "GET" })]),
    );
    expect([...snap.rulesByMethod.keys()].sort()).toEqual(["GET", "POST"]);
    expect(snap.ruleCount).toBe(2);
    expect(snap.rulesByMethod.get("POST")![0].regex).not.toBeNull();
  });

  it("drops inactive controls at build time", () => {
    const snap = new PolicySnapshot(
      payload(
        [],
        [control({ id: "a" }), control({ id: "b", status: "expired" })],
      ),
    );
    expect(snap.controlCount).toBe(1);
  });

  it("returns null from evaluate without a snapshot", () => {
    const cache = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => ({}),
    });
    expect(cache.evaluate("GET", "/x")).toBeNull();
  });
});

describe("fetch", () => {
  let cache: SecurityPolicyCache;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => ({}),
    });
  });

  it("installs a snapshot on success", async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: payload([rule()]) });
    const snap = await cache.fetch();
    expect(snap!.version).toBe("v1");
    expect(cache.isLoaded).toBe(true);
  });

  it("sends If-None-Match once a version is known", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: payload([], [], "v7"),
    });
    await cache.fetch();
    mockedAxios.get.mockResolvedValue({ status: 304, data: null });
    await cache.fetch();
    expect(mockedAxios.get.mock.calls[1][1]!.headers!["If-None-Match"]).toBe(
      '"v7"',
    );
  });

  it("keeps the existing snapshot on 304", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: payload([], [], "v1"),
    });
    const first = await cache.fetch();
    mockedAxios.get.mockResolvedValue({ status: 304, data: null });
    expect(await cache.fetch()).toBe(first);
  });

  it("keeps enforcing the last snapshot through a network failure", async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: payload([rule()]) });
    await cache.fetch();

    mockedAxios.get.mockRejectedValue(new Error("boom"));
    await cache.fetch();

    // An outage must not disarm the gate; that is the point of caching.
    expect(cache.isLoaded).toBe(true);
    expect(cache.evaluate("POST", "/admin")!.blocked).toBe(true);
  });

  it("keeps the previous snapshot on an error status", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: payload([], [], "good"),
    });
    await cache.fetch();
    mockedAxios.get.mockResolvedValue({ status: 500, data: null });
    await cache.fetch();
    expect(cache.version).toBe("good");
  });

  it("keeps the previous snapshot on a non-object body", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: payload([], [], "good"),
    });
    await cache.fetch();
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: ["not", "a", "dict"],
    });
    await cache.fetch();
    expect(cache.version).toBe("good");
  });

  it("skips malformed rows rather than losing the whole policy", async () => {
    const body: any = payload([rule()], [], "v2");
    body.blocked_endpoints.push("not an object");
    body.controls = ["also not an object", control()];
    mockedAxios.get.mockResolvedValue({ status: 200, data: body });

    await cache.fetch();
    expect(cache.version).toBe("v2");
    expect(cache.snapshot!.ruleCount).toBe(1);
    expect(cache.snapshot!.controlCount).toBe(1);
  });

  it("survives a failing headers callback", async () => {
    const failing = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => {
        throw new Error("no creds");
      },
    });
    await expect(failing.fetch()).resolves.toBeNull();
  });

  it("shares one request between concurrent callers", async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: payload() });
    await Promise.all([cache.fetch(), cache.fetch(), cache.fetch()]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});
