import axios from "axios";
import { DEFAULT_MAX_QUEUE_SIZE, EventHandler, EventQueue } from "../events";
import { EventProcessor } from "../processor";
import {
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  backoffDelay,
  classifyStatus,
  parseRetryAfter,
} from "../transport";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

function response(
  status: number,
  data: unknown = {},
  headers: Record<string, string> = {},
) {
  return { status, data, headers };
}

describe("classifyStatus", () => {
  it("treats every 2xx as delivered", () => {
    for (const code of [200, 201, 202, 204, 299]) {
      expect(classifyStatus(code)).toBe("delivered");
    }
  });

  it("does not treat a sampled response as a failure", () => {
    // The ingest answers 202 {"status":"sampled"} when server-side sampling
    // drops a batch. Reading that as a failure made the client resend it five
    // times, so sampling multiplied load instead of reducing it.
    expect(classifyStatus(202)).toBe("delivered");
  });

  it("treats client errors as permanent", () => {
    for (const code of [400, 401, 403, 404, 413, 422]) {
      expect(classifyStatus(code)).toBe("drop");
    }
  });

  it("retries the client errors that are worth retrying", () => {
    for (const code of [408, 425, 429]) {
      expect(classifyStatus(code)).toBe("retry");
    }
  });

  it("retries server errors", () => {
    for (const code of [500, 502, 503, 504]) {
      expect(classifyStatus(code)).toBe("retry");
    }
  });

  it("retries when there was no response at all", () => {
    expect(classifyStatus(undefined)).toBe("retry");
    expect(classifyStatus(null)).toBe("retry");
  });

  it("does not read an unreadable status as success", () => {
    expect(classifyStatus(NaN)).toBe("retry");
  });

  it("agrees with the Python SDK", () => {
    // Both clients talk to the same ingest. A difference in how they read a
    // response is a difference nobody notices until one is retrying something
    // the other dropped. These are the cases pinned in test_transport.py.
    const expected: Array<[number, string]> = [
      [200, "delivered"],
      [202, "delivered"],
      [204, "delivered"],
      [400, "drop"],
      [401, "drop"],
      [404, "drop"],
      [408, "retry"],
      [425, "retry"],
      [429, "retry"],
      [500, "retry"],
      [503, "retry"],
    ];
    for (const [code, outcome] of expected) {
      expect(classifyStatus(code)).toBe(outcome);
    }
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and returns milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(" 5 ")).toBe(5_000);
  });

  it("falls back to our own backoff when the value is absent or unreadable", () => {
    for (const value of [
      null,
      undefined,
      "",
      "Wed, 21 Oct 2026 07:28:00 GMT",
      "soon",
      "-1",
    ]) {
      expect(parseRetryAfter(value)).toBeNull();
    }
  });

  it("caps an absurd delay", () => {
    expect(parseRetryAfter("999999")).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("backoffDelay", () => {
  it("grows with the attempt number", () => {
    const atCeiling = () => 1;
    expect(backoffDelay(4, null, atCeiling)).toBeGreaterThan(
      backoffDelay(0, null, atCeiling),
    );
  });

  it("is capped", () => {
    const atCeiling = () => 1;
    for (let attempt = 0; attempt < 40; attempt++) {
      expect(backoffDelay(attempt, null, atCeiling)).toBeLessThanOrEqual(
        MAX_BACKOFF_MS,
      );
    }
  });

  it("is jittered", () => {
    // A fleet that failed together must not return together.
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) delays.add(backoffDelay(3));
    expect(delays.size).toBeGreaterThan(1);
  });

  it("honours Retry-After over its own schedule", () => {
    expect(backoffDelay(0, 12_000)).toBe(12_000);
  });

  it("still caps an absurd Retry-After", () => {
    expect(backoffDelay(0, 1e9)).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("EventQueue", () => {
  // Overflow is expected in several of these; the warning is the point, not noise.
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it("does not grow without bound", () => {
    // The failure this prevents: an unreachable ingest growing the host
    // application's heap until the process dies.
    const queue = new EventQueue(5);
    const handler = new EventHandler(queue);

    for (let i = 0; i < 1000; i++) {
      handler.sendEvent("error", { message: `event-${i}` });
    }

    expect(queue.size()).toBe(5);
    expect(queue.droppedCount()).toBe(995);
  });

  it("keeps the newest events", () => {
    // For a security agent, what is happening now matters more than what
    // happened at the start of an outage.
    const queue = new EventQueue(3);
    const handler = new EventHandler(queue);

    for (let i = 0; i < 10; i++) {
      handler.sendEvent("error", { message: `event-${i}` });
    }

    const kept = [queue.dequeue(), queue.dequeue(), queue.dequeue()].map(
      (e) => (e?.payload as { message: string }).message,
    );
    expect(kept).toEqual(["event-7", "event-8", "event-9"]);
  });

  it("preserves order across wraparound", () => {
    // The ring buffer's one real hazard: indices wrapping and reordering the
    // queue. Cycle it several times over.
    const queue = new EventQueue(4);
    for (let i = 0; i < 3; i++)
      queue.enqueue({ type: "e", payload: { i }, timestamp: i });
    expect(queue.dequeue()?.payload).toEqual({ i: 0 });
    expect(queue.dequeue()?.payload).toEqual({ i: 1 });

    for (let i = 3; i < 8; i++)
      queue.enqueue({ type: "e", payload: { i }, timestamp: i });

    const drained: number[] = [];
    let event = queue.dequeue();
    while (event) {
      drained.push((event.payload as { i: number }).i);
      event = queue.dequeue();
    }
    expect(drained).toEqual([4, 5, 6, 7]);
  });

  it("releases references as it drains", () => {
    // A drained queue must not pin whole payloads in memory.
    const queue = new EventQueue(2);
    queue.enqueue({ type: "e", payload: { a: 1 }, timestamp: 1 });
    queue.dequeue();
    expect(queue.size()).toBe(0);
    expect(queue.peek()).toBeUndefined();
  });

  it("defaults to the same bound as the Python SDK", () => {
    expect(DEFAULT_MAX_QUEUE_SIZE).toBe(10_000);
    expect(new EventQueue().maxSize()).toBe(10_000);
  });

  it("never refuses to accept an event", () => {
    // sendEvent runs on the application's own request path and must not become
    // backpressure on the service being observed.
    const queue = new EventQueue(1);
    const handler = new EventHandler(queue);
    for (let i = 0; i < 50; i++) {
      expect(handler.sendEvent("error", { message: "x" })).toBe(true);
    }
    expect(queue.size()).toBe(1);
  });
});

describe("EventProcessor delivery", () => {
  let queue: EventQueue;
  let processor: EventProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    queue = new EventQueue(100);
    processor = new EventProcessor(
      queue,
      "https://ingest.example.com/ingest",
      () => ({}),
      2,
      60,
      3,
    );
  });

  afterEach(async () => {
    await processor.stop();
    jest.restoreAllMocks();
  });

  async function drain(expectedCalls: number, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    processor.start();
    while (
      mockedAxios.post.mock.calls.length < expectedCalls &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("sends a full batch once", async () => {
    mockedAxios.post.mockResolvedValue(response(200));
    const handler = new EventHandler(queue);
    handler.sendEvent("error", { message: "one" });
    handler.sendEvent("error", { message: "two" });

    await drain(1);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const sent = (mockedAxios.post.mock.calls[0][1] as { events: any[] })
      .events;
    expect(sent.map((e) => e.payload.message)).toEqual(["one", "two"]);
  });

  it("flushes a lone event on time instead of leaving it waiting", async () => {
    // The bug: the flush condition was only evaluated inside the drain loop,
    // which does not run when the queue is empty. On a quiet application a
    // single event sat unsent until the next one happened to arrive.
    mockedAxios.post.mockResolvedValue(response(200));
    processor = new EventProcessor(
      queue,
      "https://ingest.example.com/ingest",
      () => ({}),
      100,
      0,
      3,
    );

    new EventHandler(queue).sendEvent("error", { message: "alone" });
    await drain(1);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const sent = (mockedAxios.post.mock.calls[0][1] as { events: any[] })
      .events;
    expect(sent.map((e) => e.payload.message)).toEqual(["alone"]);
  });

  it("drops a rejected batch instead of retrying it forever", async () => {
    // The poison pill. One malformed event used to be retried against every
    // subsequent flush, forever, taking the queue behind it down too.
    mockedAxios.post
      .mockResolvedValueOnce(response(400, { error: "invalid payload" }))
      .mockResolvedValue(response(200));

    processor = new EventProcessor(
      queue,
      "https://ingest.example.com/ingest",
      () => ({}),
      1,
      0,
      3,
    );
    const handler = new EventHandler(queue);
    for (const message of ["poison", "good-1", "good-2"]) {
      handler.sendEvent("error", { message });
    }

    await drain(3);

    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    const delivered = mockedAxios.post.mock.calls.map(
      (call) => (call[1] as { events: any[] }).events[0].payload.message,
    );
    expect(delivered).toEqual(["poison", "good-1", "good-2"]);
    expect(processor.droppedCount()).toBe(1);
  });

  it("does not resend a sampled batch", async () => {
    mockedAxios.post.mockResolvedValue(response(202, { status: "sampled" }));
    const handler = new EventHandler(queue);
    handler.sendEvent("error", { message: "one" });
    handler.sendEvent("error", { message: "two" });

    await drain(1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(processor.droppedCount()).toBe(0);
  });

  it("retries a transient failure and delivers on recovery", async () => {
    mockedAxios.post
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const handler = new EventHandler(queue);
    handler.sendEvent("error", { message: "one" });
    handler.sendEvent("error", { message: "two" });

    await drain(2);

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(processor.droppedCount()).toBe(0);
  });

  it("retries when the request throws", async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(response(200));

    const handler = new EventHandler(queue);
    handler.sendEvent("error", { message: "one" });
    handler.sendEvent("error", { message: "two" });

    await drain(2);

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it("does not overlap two drains", async () => {
    // The loop is driven by a timer but its body is async. Without a guard, a
    // slow delivery lets the next tick enter mid-await, and two drains
    // interleave into one shared batch.
    let inFlight = 0;
    let maxInFlight = 0;
    mockedAxios.post.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight--;
      return response(200);
    });

    const handler = new EventHandler(queue);
    for (let i = 0; i < 20; i++)
      handler.sendEvent("error", { message: `e-${i}` });

    await drain(5, 5000);

    expect(maxInFlight).toBe(1);
  });

  it("delivers every event exactly once under a slow ingest", async () => {
    mockedAxios.post.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return response(200);
    });

    const handler = new EventHandler(queue);
    for (let i = 0; i < 20; i++)
      handler.sendEvent("error", { message: `e-${i}` });

    await drain(10, 5000);
    await processor.stop();

    const delivered = mockedAxios.post.mock.calls.flatMap((call) =>
      (call[1] as { events: any[] }).events.map((e) => e.payload.message),
    );
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered).toHaveLength(20);
  });
});

describe("EventProcessor shutdown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("drains the queue, not just the batch", async () => {
    // Events still queued at shutdown were previously discarded in silence -
    // exactly the events a process shutting down most needs to report.
    mockedAxios.post.mockResolvedValue(response(200));
    const queue = new EventQueue(100);
    const processor = new EventProcessor(
      queue,
      "https://ingest.example.com/ingest",
      () => ({}),
      1000,
      3600,
      3,
    );

    processor.start();
    const handler = new EventHandler(queue);
    for (const message of ["a", "b", "c"])
      handler.sendEvent("error", { message });

    await processor.stop();

    const delivered = mockedAxios.post.mock.calls.flatMap((call) =>
      (call[1] as { events: any[] }).events.map((e) => e.payload.message),
    );
    expect(delivered.sort()).toEqual(["a", "b", "c"]);
  });

  it("does not hang on a dead ingest", async () => {
    // One attempt, no backoff. An application calling stop() would rather lose
    // a batch than wait out a retry schedule.
    mockedAxios.post.mockResolvedValue(response(503));
    const queue = new EventQueue(100);
    const processor = new EventProcessor(
      queue,
      "https://ingest.example.com/ingest",
      () => ({}),
      1000,
      3600,
      5,
    );

    processor.start();
    new EventHandler(queue).sendEvent("error", { message: "a" });

    const started = Date.now();
    await processor.stop();

    expect(Date.now() - started).toBeLessThan(4000);
    expect(mockedAxios.post.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
