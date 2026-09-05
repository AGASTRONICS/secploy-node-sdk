import axios from "axios";
import { Secploy } from "../index";

// No network. stop() flushes, and a real request would hang out to the axios
// timeout on every test.
jest.mock("axios");
(axios as jest.Mocked<typeof axios>).post.mockResolvedValue({
  status: 200,
  data: {},
  headers: {},
} as any);

function makeClient(overrides: Record<string, unknown> = {}) {
  return new Secploy({
    apiKey: "key",
    environmentKey: "env",
    organizationId: "org",
    ingestUrl: "https://ingest.example.com/ingest",
    environment: "production",
    captureUncaught: false,
    captureConsole: false,
    realtime: false,
    ...overrides,
  } as any);
}

/** The events a client queued, without going near the network. */
function queued(client: Secploy): Array<{ type: string; payload: any }> {
  const events: Array<{ type: string; payload: any }> = [];
  const queue = (client as any).eventQueue;
  let event = queue.dequeue();
  while (event) {
    events.push(event);
    event = queue.dequeue();
  }
  return events;
}

describe("captureException", () => {
  let client: Secploy;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.stop();
  });

  it("queues an event for a caught error", () => {
    // The gap this closes: before, a Node application could catch an error and
    // have no way at all to report it.
    client.captureException(new TypeError("bad input"));

    const events = queued(client);
    expect(events).toHaveLength(1);
    expect(events[0].payload.context.exception_type).toBe("TypeError");
    expect(events[0].payload.context.exception_value).toBe("bad input");
  });

  it("sends structured frames and the formatted text together", () => {
    // Frames for grouping and display; the strings so an ingest that predates
    // them still understands the event.
    client.captureException(new Error("boom"));

    const context = queued(client)[0].payload.context;
    expect(Array.isArray(context.frames)).toBe(true);
    expect(context.frames.length).toBeGreaterThan(0);
    expect(Array.isArray(context.stacktrace)).toBe(true);
    expect(context.stacktrace.length).toBeGreaterThan(0);
  });

  it("marks each frame as in-app or not", () => {
    // The SDK runs inside the application, so it knows this rather than making
    // the server guess from path substrings.
    client.captureException(new Error("boom"));

    const frames = queued(client)[0].payload.context.frames;
    expect(
      frames.every((frame: any) => typeof frame.in_app === "boolean"),
    ).toBe(true);
  });

  it("puts the failing frame last, where the ingest looks for it", () => {
    // The culprit is derived server-side from these frames rather than sent,
    // so what has to be right here is the ordering: innermost last, matching
    // Python and matching what the ingest reads.
    client.captureException(new Error("boom"));

    const frames = queued(client)[0].payload.context.frames;
    const innermost = frames[frames.length - 1];
    expect(innermost.in_app).toBe(true);
    expect(innermost.module).toContain("capture.test");
  });

  it("does not send a culprit of its own", () => {
    // Each side owns what it knows. Sending one produced a field that quietly
    // disagreed with the culprit on the issue.
    client.captureException(new Error("boom"));
    expect(queued(client)[0].payload.context).not.toHaveProperty("culprit");
  });

  it("records that the error was handled", () => {
    // A caught error and a crash are triaged differently.
    client.captureException(new Error("boom"));

    const context = queued(client)[0].payload.context;
    expect(context.handled).toBe(true);
    expect(context.mechanism).toBe("manual");
  });

  it("carries extra context through", () => {
    client.captureException(new Error("boom"), {
      order_id: "4821",
      tenant: "acme",
    });

    const context = queued(client)[0].payload.context;
    expect(context.order_id).toBe("4821");
    expect(context.tenant).toBe("acme");
  });

  it("accepts anything that was thrown", () => {
    // JavaScript permits throwing any value, and every one of these happens.
    for (const thrown of ["a string", null, undefined, 42, { code: 500 }]) {
      client.captureException(thrown);
    }
    expect(queued(client)).toHaveLength(5);
  });

  it("never throws, whatever it is handed", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => client.captureException(circular)).not.toThrow();
  });

  it("attaches the environment", () => {
    client.captureException(new Error("boom"));
    expect(queued(client)[0].payload.context.environment).toBe("production");
  });
});

describe("release", () => {
  it("is attached when configured", async () => {
    // Without it an issue cannot say which build it first appeared in, and
    // "this regressed in 2.4.1" is unanswerable.
    const client = makeClient({ release: "2.4.1" });
    client.captureException(new Error("boom"));

    expect(queued(client)[0].payload.context.release).toBe("2.4.1");
    await client.stop();
  });

  it("is absent rather than empty when not configured", async () => {
    const client = makeClient();
    client.captureException(new Error("boom"));

    expect(queued(client)[0].payload.context).not.toHaveProperty("release");
    await client.stop();
  });
});

describe("captureMessage", () => {
  let client: Secploy;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.stop();
  });

  it("queues a message with no exception behind it", () => {
    client.captureMessage("cache warm failed", "warning");

    const event = queued(client)[0];
    expect(event.payload.type).toBe("warning");
    expect(event.payload.context.exception_value).toBe("cache warm failed");
  });

  it("still says where it came from", () => {
    client.captureMessage("something odd");
    expect(queued(client)[0].payload.context.frames.length).toBeGreaterThan(0);
  });

  it("does not blame its own frame", () => {
    // The innermost frame is this method itself, which would make every
    // captureMessage call look like it came from inside the SDK.
    client.captureMessage("something odd");

    const frames = queued(client)[0].payload.context.frames;
    const innermost = frames[frames.length - 1];
    expect(innermost.module).not.toContain("index");
    expect(innermost.function).not.toContain("captureMessage");
    expect(innermost.module).toContain("capture.test");
  });

  it("defaults to info", () => {
    client.captureMessage("just so you know");
    expect(queued(client)[0].payload.type).toBe("info");
  });
});

describe("console capture", () => {
  let client: Secploy | null = null;

  afterEach(async () => {
    if (client) await client.stop();
    client = null;
  });

  it("is on without needing debug mode", async () => {
    // It used to run only when `debug: true`, so an application's console.error
    // output - often the only record of a handled failure - reached the SDK on
    // a developer's laptop and nowhere else.
    const original = console.error;
    client = makeClient({ captureConsole: true });

    expect(console.error).not.toBe(original);
  });

  it("turns console.error(err) into a reported issue", () => {
    const spy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    client = makeClient({ captureConsole: true });

    console.error(new RangeError("out of bounds"));

    const events = queued(client).filter(
      (event) => event.payload?.context?.exception_type === "RangeError",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.context.mechanism).toBe("console");
    spy.mockRestore();
  });

  it("still prints the application's own output", () => {
    const printed: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => printed.push(args);

    client = makeClient({ captureConsole: true });
    console.log("hello");

    expect(printed).toHaveLength(1);
    console.log = original;
  });

  it("restores console on stop", async () => {
    const original = console.error;
    client = makeClient({ captureConsole: true });
    expect(console.error).not.toBe(original);

    await client.stop();
    client = null;

    // A library that leaves a patched console behind after being stopped is a
    // leak, and across tests it is a contamination bug.
    expect(console.error).toBe(original);
  });

  it("restores the function it replaced, not a snapshot", async () => {
    // If another library patched console after us, restoring a copy of the
    // whole object would silently undo their instrumentation too.
    const ours = console.warn;
    client = makeClient({ captureConsole: true });
    await client.stop();
    client = null;

    expect(console.warn).toBe(ours);
  });

  it("can be turned off", async () => {
    const original = console.error;
    client = makeClient({ captureConsole: false });
    expect(console.error).toBe(original);
  });
});

describe("global handlers", () => {
  it("are installed by default", async () => {
    const before = process.listenerCount("unhandledRejection");
    const client = new Secploy({
      apiKey: "key",
      environmentKey: "env",
      organizationId: "org",
      ingestUrl: "https://ingest.example.com/ingest",
      captureConsole: false,
      realtime: false,
    } as any);

    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

    await client.stop();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("can be turned off", async () => {
    const before = process.listenerCount("unhandledRejection");
    const client = makeClient({ captureUncaught: false });

    expect(process.listenerCount("unhandledRejection")).toBe(before);
    await client.stop();
  });

  it("report a rejection through the client", async () => {
    const client = makeClient({ captureUncaught: true });

    process.emit(
      "unhandledRejection",
      new Error("promise died"),
      Promise.resolve(),
    );

    const events = queued(client).filter(
      (event) => event.payload?.context?.exception_value === "promise died",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.context.handled).toBe(false);

    await client.stop();
  });
});
