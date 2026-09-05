import { EventHandler, EventQueue } from "../events";
import { actorKey, bucket, neverSampled, shouldSend } from "../sampling";

const withActor = (identity: string) => ({
  context: { identity_key: identity },
});

describe("protected types", () => {
  it("never samples errors", () => {
    // A general error tracker samples errors because volume is its problem.
    // This product's value is the rare event, and dropping nine errors in ten
    // would be dropping the thing it exists to find.
    for (const type of [
      "error",
      "critical",
      "fatal",
      "warning",
      "warn",
      "exception",
    ]) {
      expect(shouldSend(type, withActor("u1"), 0.01)).toBe(true);
    }
  });

  it("never samples security signals", () => {
    const signals = [
      "auth.anomaly.detected",
      "account.takeover.suspected",
      "security.threat.detected",
      "access.privilege_escalation.detected",
      "data.exfiltration.suspected",
      "secret.exposed",
      "incident.opened",
      "fraud.rule.matched",
      "payment.declined",
      "compliance.violation",
      "api.abuse.detected",
      "dependency_scan.completed",
    ];
    for (const signal of signals) {
      expect(shouldSend(signal, withActor("u1"), 0.001)).toBe(true);
    }
  });

  it("always sends anything carrying a stacktrace", () => {
    // Unambiguous evidence that something threw, whatever it was labelled.
    expect(
      shouldSend("info", { context: { stacktrace: ["File ..."] } }, 0.001),
    ).toBe(true);
  });

  it("leaves volume traffic eligible", () => {
    // Without this, sampling does nothing at all.
    for (const type of [
      "log",
      "info",
      "debug",
      "metric",
      "http_request",
      "system_metrics",
    ]) {
      expect(neverSampled(type)).toBe(false);
    }
  });

  it("is not defeated by case or whitespace", () => {
    expect(neverSampled("  ERROR  ")).toBe(true);
    expect(neverSampled("Auth.Anomaly.Detected")).toBe(true);
  });
});

describe("rates", () => {
  it("sends everything at a full rate", () => {
    for (const type of ["log", "http_request", "error"]) {
      expect(shouldSend(type, withActor("u1"), 1.0)).toBe(true);
    }
  });

  it("still sends what matters at a rate of zero", () => {
    // The difference between "quiet" and "blind".
    expect(shouldSend("error", withActor("u1"), 0)).toBe(true);
    expect(shouldSend("log", withActor("u1"), 0)).toBe(false);
  });

  it("honours the rate across actors", () => {
    for (const rate of [0.1, 0.25, 0.5, 0.9]) {
      let kept = 0;
      const actors = 20000;
      for (let i = 0; i < actors; i++) {
        if (shouldSend("http_request", withActor(`user-${i}`), rate)) kept++;
      }
      expect(Math.abs(kept / actors - rate)).toBeLessThan(0.02);
    }
  });

  it("does not lose events to a nonsense rate", () => {
    for (const rate of [NaN, Infinity, undefined as any, "abc" as any]) {
      expect(shouldSend("log", withActor("u1"), rate)).toBe(true);
    }
  });
});

describe("per-actor consistency", () => {
  it("decides the same actor the same way every time", () => {
    // Several detectors read a sequence. A uniform one-in-ten sample leaves
    // every sequence with holes, so a scan of two hundred ids arrives as
    // twenty scattered requests and nothing fires.
    const first = shouldSend("http_request", withActor("user-42"), 0.5);
    for (let i = 0; i < 500; i++) {
      expect(shouldSend("http_request", withActor("user-42"), 0.5)).toBe(first);
    }
  });

  it("keeps a sampled-in actor's whole sequence", () => {
    const observed: Record<string, number> = {};
    for (let actor = 0; actor < 200; actor++) {
      const key = `user-${actor}`;
      for (let request = 0; request < 50; request++) {
        if (shouldSend("http_request", withActor(key), 0.3)) {
          observed[key] = (observed[key] ?? 0) + 1;
        }
      }
    }

    expect(Object.keys(observed).length).toBeGreaterThan(0);
    for (const count of Object.values(observed)) {
      expect(count).toBe(50);
    }
  });

  it("gives different actors different decisions", () => {
    const decisions = new Set<boolean>();
    for (let i = 0; i < 1000; i++) {
      decisions.add(shouldSend("http_request", withActor(`user-${i}`), 0.5));
    }
    expect(decisions).toEqual(new Set([true, false]));
  });
});

describe("actorKey", () => {
  it("prefers the most specific identifier", () => {
    expect(
      actorKey({
        context: {
          identity_key: "u1",
          user_id: "u1",
          session_id: "s",
          ip_address: "1.2.3.4",
        },
      }),
    ).toBe("identity_key:u1");
    expect(
      actorKey({ context: { session_id: "s", ip_address: "1.2.3.4" } }),
    ).toBe("session_id:s");
    expect(actorKey({ context: { ip_address: "1.2.3.4" } })).toBe(
      "ip_address:1.2.3.4",
    );
  });

  it("does not treat placeholders as actors", () => {
    // The SDK fills these in when it knows nothing. Treating them as an actor
    // would put every anonymous request in one bucket.
    expect(
      actorKey({
        context: { identity_key: "anonymous", ip_address: "unknown" },
      }),
    ).toBe("");
  });

  it("finds a root-level field too", () => {
    expect(actorKey({ user_id: "u9" })).toBe("user_id:u9");
  });

  it("yields nothing when there is nothing usable", () => {
    for (const payload of [
      {},
      null,
      undefined,
      { context: "not an object" } as any,
    ]) {
      expect(actorKey(payload)).toBe("");
    }
  });
});

describe("bucket", () => {
  it("is stable and in range", () => {
    expect(bucket("identity_key:user-1")).toBe(bucket("identity_key:user-1"));
    for (let i = 0; i < 1000; i++) {
      const value = bucket(`identity_key:user-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("spreads evenly", () => {
    const deciles = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++)
      deciles[Math.floor(bucket(`identity_key:user-${i}`) * 10)]++;
    for (const count of deciles) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });

  it("matches the other implementations", () => {
    // Pinned. An actor bucketed differently by different services would be
    // sampled in by one and out by another.
    expect(bucket("identity_key:user-1")).toBeCloseTo(0.682777636917308, 12);
  });
});

describe("the event boundary", () => {
  function handlerWith(rate: number) {
    const queue = new EventQueue(1000);
    return {
      queue,
      handler: new EventHandler(queue, undefined, undefined, rate),
    };
  }

  it("actually applies sampling now", () => {
    // It was documented, defaulted, stored - and never read. Setting 0.1 sent
    // everything.
    const { queue, handler } = handlerWith(0);
    for (let i = 0; i < 50; i++) {
      handler.sendEvent("log", {
        message: `line ${i}`,
        context: { identity_key: `u${i}` },
      });
    }

    expect(queue.size()).toBe(0);
    expect(handler.sampledCount()).toBe(50);
  });

  it("still lets errors through at any rate", () => {
    const { queue, handler } = handlerWith(0);
    handler.sendEvent("error", {
      message: "boom",
      context: { identity_key: "u1" },
    });

    expect(queue.size()).toBe(1);
    expect(handler.sampledCount()).toBe(0);
  });

  it("changes nothing at a full rate", () => {
    const { queue, handler } = handlerWith(1.0);
    for (let i = 0; i < 20; i++)
      handler.sendEvent("log", { message: `line ${i}` });
    expect(queue.size()).toBe(20);
  });

  it("counts drops rather than losing them silently", () => {
    const { handler } = handlerWith(0.5);
    for (let i = 0; i < 200; i++) {
      handler.sendEvent("log", {
        message: "x",
        context: { identity_key: `u${i}` },
      });
    }
    expect(handler.sampledCount()).toBeGreaterThan(0);
  });
});
