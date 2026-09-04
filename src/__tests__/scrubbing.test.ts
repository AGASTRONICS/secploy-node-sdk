import { EventHandler, EventQueue } from "../events";
import {
  MAX_ITEMS,
  REDACTED,
  Scrubber,
  hashSessionId,
  normalizeKey,
  scrubString,
} from "../scrubbing";

const scrubber = new Scrubber();

describe("denied keys", () => {
  it("redacts credentials whatever the naming style", () => {
    // "API-Key", "api_key" and "apiKey" are one rule, not three.
    for (const key of ["password", "API_KEY", "apiKey", "Authorization", "x-api-key", "Set-Cookie"]) {
      const out = scrubber.scrub({ [key]: "hunter2" }) as Record<string, unknown>;
      expect(out[key]).toBe(REDACTED);
    }
  });

  it("catches a credential under a prefixed key", () => {
    // Without substring matching, every framework's naming convention would
    // have to be enumerated.
    const out = scrubber.scrub({
      user_password: "x",
      stripe_api_key: "y",
      x_auth_token: "z",
      db_password: "w",
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  it("leaves ordinary fields alone", () => {
    // The other half of the promise: over-redaction makes the product worse at
    // its job for no security benefit.
    const out = scrubber.scrub({
      user_id: "42",
      order_id: "A-1001",
      email: "someone@example.com",
      ip_address: "203.0.113.9",
      path: "/api/orders",
      status_code: 500,
    }) as Record<string, unknown>;

    expect(out).toEqual({
      user_id: "42",
      order_id: "A-1001",
      email: "someone@example.com",
      ip_address: "203.0.113.9",
      path: "/api/orders",
      status_code: 500,
    });
  });

  it("does not redact the session identifier", () => {
    // It normalises to "sessionid", which the denylist would otherwise catch -
    // and it must not, because it is how a session is recognised across events.
    // It arrives already hashed.
    const hashed = hashSessionId("abc");
    const out = scrubber.scrub({ session_id: hashed }) as Record<string, unknown>;
    expect(out.session_id).toBe(hashed);
  });

  it("accepts extra denied keys", () => {
    const custom = new Scrubber({ denyKeys: ["internal_ref"] });
    const out = custom.scrub({ internal_ref: "abc", user_id: "1" }) as Record<string, unknown>;
    expect(out.internal_ref).toBe(REDACTED);
    expect(out.user_id).toBe("1");
  });

  it("can be turned off wholesale", () => {
    const off = new Scrubber({ enabled: false });
    expect((off.scrub({ password: "x" }) as any).password).toBe("x");
  });
});

describe("value patterns", () => {
  it("removes a JWT wherever it appears", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(scrubString(`token=${jwt} rest`)).toContain(REDACTED);
    expect(scrubString(`token=${jwt} rest`)).not.toContain(jwt);
  });

  it("removes provider keys by their prefixes", () => {
    const secrets = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "xoxb-123456789012-abcdefghijkl",
      "sk_live_abcdefghij1234567890",
      "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
      "glpat-abcdefghij1234567890",
    ];
    for (const secret of secrets) {
      expect(scrubString(`value ${secret} end`)).not.toContain(secret);
    }
  });

  it("removes a private key block entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nlines\n-----END RSA PRIVATE KEY-----";
    const out = scrubString(`config: ${pem}`);
    expect(out).not.toContain("MIIEow");
  });

  it("removes credentials embedded in a URL", () => {
    const out = scrubString("connecting to postgres://admin:s3cret@db.internal:5432/app");
    expect(out).not.toContain("s3cret");
    expect(out).toContain("db.internal");
  });

  it("removes an Authorization value found in free text", () => {
    const out = scrubString("upstream said: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("card numbers", () => {
  it("redacts a real card number", () => {
    for (const card of ["4111111111111111", "4111 1111 1111 1111", "5500-0000-0000-0004"]) {
      expect(scrubString(`paid with ${card}`)).toContain(REDACTED);
    }
  });

  it("leaves numbers that are not cards alone", () => {
    // Luhn is what keeps this from redacting order numbers, timestamps and
    // database ids - which would make the product worse at its job for nothing.
    for (const value of ["4111111111111112", "1234567890123", "1700000000000000"]) {
      expect(scrubString(`ref ${value}`)).toContain(value);
    }
  });

  it("does not touch short numbers", () => {
    expect(scrubString("order 4821 total 1999")).toBe("order 4821 total 1999");
  });
});

describe("walking a payload", () => {
  it("reaches nested values", () => {
    const out = scrubber.scrub({
      request: { headers: { authorization: "Bearer abc" }, body: { password: "x" } },
    }) as any;

    expect(out.request.headers.authorization).toBe(REDACTED);
    expect(out.request.body.password).toBe(REDACTED);
  });

  it("reaches inside arrays", () => {
    const out = scrubber.scrub({ users: [{ name: "a", password: "x" }] }) as any;
    expect(out.users[0].password).toBe(REDACTED);
    expect(out.users[0].name).toBe("a");
  });

  it("survives a cycle", () => {
    // A request object graph or a self-referencing logger context. This must
    // end in a truncated event, not a stack overflow inside the SDK.
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(() => scrubber.scrub(node)).not.toThrow();
    expect(JSON.stringify(scrubber.scrub(node))).toContain("circular");
  });

  it("stops at a depth limit", () => {
    let deep: Record<string, unknown> = { password: "x" };
    for (let i = 0; i < 30; i++) deep = { nested: deep };

    expect(() => scrubber.scrub(deep)).not.toThrow();
    expect(JSON.stringify(scrubber.scrub(deep))).toContain("max-depth");
  });

  it("caps how many items it walks", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ITEMS + 50; i++) wide[`k${i}`] = i;

    const out = scrubber.scrub(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBeLessThanOrEqual(MAX_ITEMS + 1);
    // toHaveProperty would read the brackets as an array path.
    expect(Object.keys(out)).toContain("[secploy:truncated]");
  });

  it("survives a getter that throws", () => {
    // Property access runs arbitrary code, and this is the last place that
    // should be able to fail.
    const hostile = {
      get boom() {
        throw new Error("nope");
      },
      safe: "kept",
    };

    const out = scrubber.scrub(hostile) as Record<string, unknown>;
    expect(out.safe).toBe("kept");
    expect(out.boom).toBe(REDACTED);
  });

  it("keeps an Error's shape", () => {
    // Stringifying would collapse it to "Error: message" and lose the stack the
    // report is built on.
    const error = new Error("boom");
    const out = scrubber.scrub({ error }) as any;
    expect(out.error.name).toBe("Error");
    expect(out.error.message).toBe("boom");
    expect(out.error.stack).toContain("boom");
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [undefined, null, Symbol("x"), BigInt(1), () => 1, new Map()]) {
      expect(() => scrubber.scrub(value)).not.toThrow();
    }
  });
});

describe("normalizeKey", () => {
  it("erases naming style", () => {
    for (const key of ["API_KEY", "api-key", "apiKey", "Api Key"]) {
      expect(normalizeKey(key)).toBe("apikey");
    }
  });
});

describe("hashSessionId", () => {
  it("produces a stable, unique, non-reversible handle", () => {
    expect(hashSessionId("abc")).toBe(hashSessionId("abc"));
    expect(hashSessionId("abc")).not.toBe(hashSessionId("abd"));
    expect(hashSessionId("abc")).not.toContain("abc");
    expect(hashSessionId("abc")).toMatch(/^sess_[0-9a-f]{32}$/);
  });

  it("is idempotent", () => {
    const once = hashSessionId("abc");
    expect(hashSessionId(once)).toBe(once);
  });

  it("leaves an empty value empty", () => {
    expect(hashSessionId("")).toBe("");
    expect(hashSessionId(null)).toBe("");
    expect(hashSessionId(undefined)).toBe("");
  });
});

describe("the event boundary", () => {
  function handlerWith(options: { beforeSend?: any; scrubber?: Scrubber } = {}) {
    const queue = new EventQueue(100);
    const handler = new EventHandler(queue, options.scrubber, options.beforeSend);
    return { queue, handler };
  }

  it("scrubs every event, whatever produced it", () => {
    // Scrubbing lives here rather than at each call site, because redacting
    // per call site guarantees the next payload someone adds is the one that
    // leaks.
    const { queue, handler } = handlerWith();
    handler.sendEvent("error", { context: { password: "hunter2", user_id: "1" } });

    const event = queue.dequeue()!;
    expect((event.payload as any).context.password).toBe(REDACTED);
    expect((event.payload as any).context.user_id).toBe("1");
  });

  it("lets a hook drop an event", () => {
    const { queue, handler } = handlerWith({ beforeSend: () => null });
    expect(handler.sendEvent("error", { message: "x" })).toBe(false);
    expect(queue.size()).toBe(0);
    expect(handler.filteredCount()).toBe(1);
  });

  it("lets a hook see the real values", () => {
    // The hook runs first so it can decide from them - drop this event,
    // annotate it, redact something only this codebase knows is sensitive.
    let seen: any = null;
    const { handler } = handlerWith({
      beforeSend: (payload: any) => {
        seen = payload;
        return payload;
      },
    });
    handler.sendEvent("error", { context: { password: "hunter2" } });

    expect(seen.context.password).toBe("hunter2");
  });

  it("scrubs after the hook, so nothing it adds escapes", () => {
    const { queue, handler } = handlerWith({
      beforeSend: (payload: any) => ({ ...payload, extra: { api_key: "leaked" } }),
    });
    handler.sendEvent("error", { message: "x" });

    const event = queue.dequeue()!;
    expect((event.payload as any).extra.api_key).toBe(REDACTED);
  });

  it("keeps the event when the hook throws", () => {
    // A broken filter should cost visibility into the filter, not into the
    // application.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { queue, handler } = handlerWith({
      beforeSend: () => {
        throw new Error("hook is broken");
      },
    });

    expect(handler.sendEvent("error", { message: "x" })).toBe(true);
    expect(queue.size()).toBe(1);
    spy.mockRestore();
  });

  it("keeps the event when the hook returns nonsense", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { queue, handler } = handlerWith({ beforeSend: () => "not an object" as any });

    expect(handler.sendEvent("error", { message: "x" })).toBe(true);
    expect(queue.size()).toBe(1);
    spy.mockRestore();
  });

  it("still stamps an event id after scrubbing", () => {
    const { queue, handler } = handlerWith();
    handler.sendEvent("error", { message: "x" });
    expect((queue.dequeue()!.payload as any).event_id).toBeTruthy();
  });
});
