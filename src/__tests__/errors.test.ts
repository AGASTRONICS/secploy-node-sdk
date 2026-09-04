import {
  culpritFrom,
  formatStack,
  normalizeError,
  parseError,
  parseStack,
} from "../errors";
import { GlobalErrorHandlers } from "../instrument";
import {
  expressErrorHandler,
  fastifyErrorHandler,
  koaErrorHandler,
} from "../errorHandlers";

const ROOT = "/srv/app";

const V8_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at loadOrder (/srv/app/orders/service.js:31:21)",
  "    at /srv/app/node_modules/express/lib/router/route.js:149:13",
  "    at Object.handler (/srv/app/api/routes.js:44:9)",
].join("\n");

describe("normalizeError", () => {
  it("reads a real Error", () => {
    const error = new TypeError("bad thing");
    const normalized = normalizeError(error);
    expect(normalized.type).toBe("TypeError");
    expect(normalized.value).toBe("bad thing");
    expect(normalized.stack).toContain("bad thing");
  });

  it("accepts a thrown string", () => {
    // `throw "nope"` is legal and happens. Reporting it as undefined would lose
    // exactly the failures nobody expected.
    expect(normalizeError("nope")).toMatchObject({ type: "Error", value: "nope" });
  });

  it("accepts a rejected error-shaped object", () => {
    // Plenty of libraries reject with something that has a message but is not
    // an Error.
    const normalized = normalizeError({ name: "HttpError", message: "502 upstream", stack: "at x" });
    expect(normalized.type).toBe("HttpError");
    expect(normalized.value).toBe("502 upstream");
  });

  it("accepts null and undefined", () => {
    expect(normalizeError(null).value).toContain("null");
    expect(normalizeError(undefined).value).toContain("undefined");
  });

  it("survives a circular object", () => {
    // Describing a failure must never become a second failure.
    const circular: Record<string, unknown> = { code: 500 };
    circular.self = circular;
    expect(() => normalizeError(circular)).not.toThrow();
    expect(normalizeError(circular).value).toContain("Non-error");
  });

  it("survives an object whose getter throws", () => {
    const hostile = {
      get message() {
        throw new Error("nope");
      },
    };
    expect(() => normalizeError(hostile)).not.toThrow();
  });

  it("accepts numbers and booleans", () => {
    expect(normalizeError(42).value).toContain("42");
    expect(normalizeError(false).value).toContain("false");
  });
});

describe("parseStack", () => {
  it("reads V8 frames", () => {
    const frames = parseStack(V8_STACK, ROOT);
    expect(frames).toHaveLength(3);
  });

  it("returns frames innermost last", () => {
    // The convention both SDKs and the ingest share. V8 writes the failing call
    // first; Python writes it last, and everything downstream reads the last
    // frame as the culprit and truncates from the front.
    const frames = parseStack(V8_STACK, ROOT);
    expect(frames[frames.length - 1].function).toBe("loadOrder");
    expect(frames[0].function).toBe("Object.handler");
  });

  it("makes paths relative to the application root", () => {
    // An absolute path differs between a laptop, CI and a container and says
    // nothing about the bug.
    const frames = parseStack(V8_STACK, ROOT);
    const inner = frames[frames.length - 1];
    expect(inner.module).toBe("orders/service.js");
  });

  it("marks node_modules as not in-app", () => {
    // A dependency upgrade moves every line inside it. If those frames counted,
    // upgrading express would re-group every issue in the project.
    const frames = parseStack(V8_STACK, ROOT);
    const vendor = frames.filter((frame) => !frame.in_app);
    expect(vendor).toHaveLength(1);
    expect(vendor[0].filename).toContain("node_modules");
  });

  it("reads a frame with no function name", () => {
    const frames = parseStack("Error: x\n    at /srv/app/index.js:12:3", ROOT);
    expect(frames).toHaveLength(1);
    expect(frames[0].function).toBe("");
    expect(frames[0].lineno).toBe(12);
  });

  it("strips async and new qualifiers", () => {
    // They vary between invocations and are noise for grouping.
    const frames = parseStack(
      "Error: x\n    at async loadOrder (/srv/app/a.js:1:1)\n    at new Widget (/srv/app/b.js:2:2)",
      ROOT,
    );
    expect(frames.map((f) => f.function).sort()).toEqual(["Widget", "loadOrder"]);
  });

  it("ignores lines that are not frames", () => {
    // A message can itself contain newlines, so lines are classified by shape.
    const frames = parseStack(
      "Error: line one\nline two\nnot a frame\n    at go (/srv/app/a.js:1:1)",
      ROOT,
    );
    expect(frames).toHaveLength(1);
  });

  it("caps an enormous stack", () => {
    const lines = ["RangeError: Maximum call stack size exceeded"];
    for (let i = 0; i < 500; i++) lines.push(`    at recurse (/srv/app/a.js:${i}:1)`);
    expect(parseStack(lines.join("\n"), ROOT).length).toBeLessThanOrEqual(50);
  });

  it("keeps the innermost frames when capping", () => {
    // Truncating the wrong end would discard the frames that identify the bug.
    const lines = ["Error: x", "    at innermost (/srv/app/deep.js:1:1)"];
    for (let i = 0; i < 200; i++) lines.push(`    at outer${i} (/srv/app/a.js:${i}:1)`);

    const frames = parseStack(lines.join("\n"), ROOT);
    expect(frames[frames.length - 1].function).toBe("innermost");
  });

  it("returns nothing for an empty stack", () => {
    expect(parseStack("", ROOT)).toEqual([]);
    expect(parseStack("Error: no frames at all", ROOT)).toEqual([]);
  });
});

describe("culpritFrom", () => {
  it("picks the innermost application frame", () => {
    // "Where is this bug" means our deepest line, not the framework internals
    // underneath it.
    expect(culpritFrom(parseStack(V8_STACK, ROOT))).toBe("orders/service.js in loadOrder");
  });

  it("falls back to the innermost frame when nothing is in-app", () => {
    const stack = [
      "Error: x",
      "    at connect (/srv/app/node_modules/pg/lib/client.js:9:1)",
    ].join("\n");
    expect(culpritFrom(parseStack(stack, ROOT))).toContain("client.js");
  });

  it("is empty when there are no frames", () => {
    expect(culpritFrom([])).toBe("");
  });
});

describe("parseError", () => {
  it("carries both the structured frames and the formatted text", () => {
    // Both shapes travel: frames for grouping and display, strings so an ingest
    // that predates them still understands the event.
    const error = new Error("boom");
    error.stack = V8_STACK;

    const parsed = parseError(error, ROOT);
    expect(parsed.frames.length).toBe(3);
    expect(parsed.stacktrace.length).toBeGreaterThan(0);
    expect(parsed.stacktrace.join("\n")).toContain("loadOrder");
  });

  it("still produces a stacktrace when there was no stack", () => {
    // A thrown string has no stack; the event must not be blank.
    const parsed = parseError("nope", ROOT);
    expect(parsed.stacktrace.length).toBeGreaterThan(0);
    expect(parsed.stacktrace[0]).toContain("nope");
  });
});

describe("formatStack", () => {
  it("renders back into the order a runtime would print", () => {
    const frames = parseStack(V8_STACK, ROOT);
    const lines = formatStack("TypeError", "boom", frames);
    expect(lines[0]).toBe("TypeError: boom");
    // Innermost first again, the way V8 prints it.
    expect(lines[1]).toContain("loadOrder");
  });
});

describe("GlobalErrorHandlers", () => {
  let captured: Array<{ parsed: any; context: any }>;
  let handlers: GlobalErrorHandlers;

  beforeEach(() => {
    captured = [];
    handlers = new GlobalErrorHandlers({
      capture: (parsed, context) => captured.push({ parsed, context }),
      flush: async () => undefined,
    });
  });

  afterEach(() => handlers.uninstall());

  it("adds listeners without replacing existing ones", () => {
    // An application's own handler is a deliberate choice about how it wants to
    // die. Assigning over it would be a monitoring library breaking the thing
    // it monitors.
    const theirs = () => undefined;
    process.on("unhandledRejection", theirs);
    const before = process.listenerCount("unhandledRejection");

    handlers.install();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

    handlers.uninstall();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
    process.removeListener("unhandledRejection", theirs);
  });

  it("captures an unhandled rejection", () => {
    handlers.install();
    process.emit("unhandledRejection", new Error("promise died"), Promise.resolve());

    expect(captured).toHaveLength(1);
    expect(captured[0].parsed.value).toBe("promise died");
    expect(captured[0].context.handled).toBe(false);
    expect(captured[0].context.mechanism).toBe("unhandledRejection");
  });

  it("records a rejection as error, not fatal", () => {
    // The process usually survives one. Triage differs, so the distinction is
    // kept rather than flattened.
    handlers.install();
    process.emit("unhandledRejection", new Error("x"), Promise.resolve());
    expect(captured[0].context.level).toBe("error");
  });

  it("captures a rejection carrying a non-Error", () => {
    handlers.install();
    process.emit("unhandledRejection", "just a string", Promise.resolve());
    expect(captured[0].parsed.value).toBe("just a string");
  });

  it("is idempotent", () => {
    handlers.install();
    const count = process.listenerCount("unhandledRejection");
    handlers.install();
    expect(process.listenerCount("unhandledRejection")).toBe(count);
  });

  it("removes everything it added", () => {
    const uncaught = process.listenerCount("uncaughtException");
    const rejection = process.listenerCount("unhandledRejection");

    handlers.install();
    handlers.uninstall();

    expect(process.listenerCount("uncaughtException")).toBe(uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(rejection);
    expect(handlers.isInstalled()).toBe(false);
  });

  it("does not throw when capturing fails", () => {
    // A crash inside the crash reporter must not replace the crash.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const broken = new GlobalErrorHandlers({
      capture: () => {
        throw new Error("reporter is broken");
      },
      flush: async () => undefined,
    });
    broken.install();

    expect(() => {
      process.emit("unhandledRejection", new Error("x"), Promise.resolve());
    }).not.toThrow();

    broken.uninstall();
    spy.mockRestore();
  });
});

describe("framework error handlers", () => {
  const reporter = () => {
    const calls: Array<{ error: unknown; context: any }> = [];
    return {
      calls,
      captureException(error: unknown, context: Record<string, unknown> = {}) {
        calls.push({ error, context });
      },
    };
  };

  it("express hands the error onward", () => {
    // Deciding what the user sees is the application's job and always was.
    const client = reporter();
    const next = jest.fn();
    const error = new Error("route blew up");

    expressErrorHandler(client)(error, { method: "get", originalUrl: "/orders/4821" }, {}, next);

    expect(client.calls).toHaveLength(1);
    expect(next).toHaveBeenCalledWith(error);
  });

  it("express middleware keeps four parameters", () => {
    // Express identifies error middleware by arity alone. A three-argument
    // function is silently treated as ordinary middleware and never runs on
    // the error path - which would make this whole handler dead code.
    expect(expressErrorHandler(reporter()).length).toBe(4);
  });

  it("prefers the route pattern over the concrete url", () => {
    // /users/:id groups; /users/4821 would make every request its own issue.
    const client = reporter();
    expressErrorHandler(client)(
      new Error("x"),
      { method: "GET", originalUrl: "/users/4821", route: { path: "/users/:id" } },
      {},
      jest.fn(),
    );
    expect(client.calls[0].context.http_url).toBe("/users/:id");
  });

  it("attaches no headers, body or query string", () => {
    // There is no scrubbing layer yet, so nothing that could carry a credential
    // is collected at all.
    const client = reporter();
    expressErrorHandler(client)(
      new Error("x"),
      {
        method: "POST",
        originalUrl: "/login?token=secret",
        headers: { authorization: "Bearer super-secret" },
      } as any,
      {},
      jest.fn(),
    );

    const serialized = JSON.stringify(client.calls[0].context);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("authorization");
  });

  it("express still forwards when reporting throws", () => {
    const broken = {
      captureException() {
        throw new Error("reporter down");
      },
    };
    const next = jest.fn();
    const error = new Error("route blew up");

    expect(() => expressErrorHandler(broken)(error, {}, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledWith(error);
  });

  it("koa reports and rethrows", () => {
    const client = reporter();
    const middleware = koaErrorHandler(client);
    const error = new Error("handler blew up");

    return expect(
      middleware({ request: { method: "GET", url: "/x" } } as any, async () => {
        throw error;
      }),
    )
      .rejects.toBe(error)
      .then(() => {
        expect(client.calls).toHaveLength(1);
      });
  });

  it("koa stays out of the way when nothing throws", async () => {
    const client = reporter();
    await koaErrorHandler(client)({} as any, async () => undefined);
    expect(client.calls).toHaveLength(0);
  });

  it("fastify reports and calls done", () => {
    const client = reporter();
    const done = jest.fn();

    fastifyErrorHandler(client)({ method: "GET", url: "/x" }, {}, new Error("boom"), done);

    expect(client.calls).toHaveLength(1);
    expect(done).toHaveBeenCalled();
  });

  it("fastify works without a done callback", () => {
    const client = reporter();
    expect(() =>
      fastifyErrorHandler(client)({ method: "GET", url: "/x" }, {}, new Error("boom")),
    ).not.toThrow();
    expect(client.calls).toHaveLength(1);
  });
});
