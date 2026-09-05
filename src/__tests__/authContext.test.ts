import { hashSessionId } from "../scrubbing";
import { normalizeAuthContext } from "../authContext";
import { PolicySnapshot, SecurityPolicyCache } from "../policyCache";

describe("normalizeAuthContext", () => {
  it("accepts camelCase", () => {
    // The session comes back hashed - see the session-hashing test below - so
    // this compares against that rather than the raw input.
    expect(
      normalizeAuthContext({ identityKey: "u1", sessionId: "s1" }),
    ).toEqual({
      identityKey: "u1",
      sessionId: hashSessionId("s1"),
    });
  });

  it("accepts snake_case", () => {
    expect(
      normalizeAuthContext({ identity_key: "u1", session_id: "s1" }),
    ).toEqual({
      identityKey: "u1",
      sessionId: hashSessionId("s1"),
    });
  });

  it("prefers camelCase when both are given", () => {
    expect(
      normalizeAuthContext({ identityKey: "camel", identity_key: "snake" }),
    ).toEqual({
      identityKey: "camel",
    });
  });

  it("keeps an explicit false", () => {
    expect(normalizeAuthContext({ is_authenticated: false })).toEqual({
      isAuthenticated: false,
    });
  });

  it("drops absent and null fields", () => {
    expect(normalizeAuthContext({ identityKey: "u1", email: null })).toEqual({
      identityKey: "u1",
    });
  });

  it("accepts the avater misspelling", () => {
    // The Python SDK's public register_identity accepts both spellings.
    expect(normalizeAuthContext({ avater: "http://x/a.png" }).avatar).toBe(
      "http://x/a.png",
    );
  });

  it("handles null and non-objects", () => {
    expect(normalizeAuthContext(null)).toEqual({});
    expect(normalizeAuthContext(undefined)).toEqual({});
    expect(normalizeAuthContext("nope" as any)).toEqual({});
  });
});

describe("snake_case callers still get enforcement", () => {
  const policy = {
    version: "v1",
    ttl_seconds: 300,
    blocked_endpoints: [],
    controls: [
      {
        id: "c1",
        action_type: "block_identity",
        target_type: "identity",
        target: "user-1",
        status: "applied",
        metadata: {},
      },
    ],
  };

  function cache() {
    const c = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => ({}),
    });
    (c as any).snapshotRef = new PolicySnapshot(policy);
    return c;
  }

  it("blocks on camelCase auth", () => {
    expect(
      cache().evaluate("GET", "/x", { identityKey: "user-1" })!.blocked,
    ).toBe(true);
  });

  it("blocks on snake_case auth", () => {
    // An unrecognized spelling would match no controls and silently let the
    // request through, which is the worst possible way for a gate to fail.
    expect(
      cache().evaluate("GET", "/x", { identity_key: "user-1" })!.blocked,
    ).toBe(true);
  });

  it("blocks on snake_case session and ip too", () => {
    const sessionPolicy = {
      ...policy,
      // Targeted on the hashed session, because that is what the SDK reported
      // and therefore what the control was created against.
      controls: [
        {
          ...policy.controls[0],
          target_type: "session",
          target: hashSessionId("s-1"),
        },
      ],
    };
    const c = new SecurityPolicyCache({
      apiUrl: "https://api.secploy.com",
      headersCallback: () => ({}),
    });
    (c as any).snapshotRef = new PolicySnapshot(sessionPolicy);
    expect(c.evaluate("GET", "/x", { session_id: "s-1" })!.blocked).toBe(true);
  });
});

describe("session hashing", () => {
  it("hashes the session identifier on the way out", () => {
    // A session cookie is a live credential: whoever reads one out of an event
    // store can replay it. The hash keeps what the product needs - a stable,
    // unique handle for the session - and removes what it never needed.
    const normalized = normalizeAuthContext({
      sessionId: "django-sessionid-abc123",
    });

    expect(normalized.sessionId).not.toBe("django-sessionid-abc123");
    expect(normalized.sessionId).toMatch(/^sess_[0-9a-f]{32}$/);
  });

  it("is stable, so a session is recognisable across events", () => {
    const first = normalizeAuthContext({ sessionId: "abc" }).sessionId;
    const second = normalizeAuthContext({ session_id: "abc" }).sessionId;
    expect(first).toBe(second);
  });

  it("keeps different sessions distinct", () => {
    expect(normalizeAuthContext({ sessionId: "a" }).sessionId).not.toBe(
      normalizeAuthContext({ sessionId: "b" }).sessionId,
    );
  });

  it("is idempotent", () => {
    // Auth context is normalised at more than one layer - the gate does it and
    // the policy cache does it again. Hashing twice would produce a value that
    // matches no control, and the gate would silently stop enforcing.
    const once = normalizeAuthContext({ sessionId: "abc" });
    const twice = normalizeAuthContext(once);
    expect(twice.sessionId).toBe(once.sessionId);
  });

  it("leaves an absent session absent", () => {
    expect(normalizeAuthContext({ identityKey: "u1" })).not.toHaveProperty(
      "sessionId",
    );
  });
});
