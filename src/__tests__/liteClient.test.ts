import { LiteClient, ReplayHook } from "../lite/client";
import { FetchLike } from "../replay/uploader";

const config = {
  apiKey: "pk_test",
  environmentKey: "env_test",
  organizationId: "org_1",
  ingestUrl: "https://ingest.example.com/ingest",
  release: "2.4.1",
};

function recordingFetch(status = 202) {
  const bodies: any[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init?.body));
    headers.push(init?.headers ?? {});
    return { status, json: async () => ({}), headers: { get: () => null } };
  };
  return { bodies, headers, fetchImpl };
}

function fakeReplay(active = true): ReplayHook & { flushForError: jest.Mock } {
  return {
    active,
    flushForError: jest.fn(async () => "replay/key"),
    stop: jest.fn(),
    diagnostics: () => ({}),
  };
}

function client(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}) {
  return new LiteClient(
    { ...config, ...overrides },
    {
      sdkName: "secploy-test",
      sessionId: "sess_" + "c".repeat(32),
      platformContext: () => ({ platform: "web" }),
      fetchImpl,
    },
  );
}

describe("LiteClient", () => {
  it("requires the same credentials as the Node client", () => {
    const { fetchImpl } = recordingFetch();
    expect(
      () => new LiteClient({ ...config, apiKey: "" }, { sdkName: "t", fetchImpl }),
    ).toThrow("API key is required");
  });

  it("sends errors in the shape the other SDKs send", async () => {
    const { bodies, headers, fetchImpl } = recordingFetch();
    const c = client(fetchImpl);

    const eventId = c.captureException(new TypeError("boom"), { route: "/cart" });
    await c.flush();

    expect(headers[0]).toMatchObject({
      "X-API-Key": "pk_test",
      "X-Environment-Key": "env_test",
      "X-Organization-ID": "org_1",
    });
    const [event] = bodies[0].events;
    expect(event.type).toBe("error");
    expect(event.payload.event_id).toBe(eventId);
    expect(event.payload.message).toBe("TypeError: boom");
    expect(event.payload.context).toMatchObject({
      exception_type: "TypeError",
      exception_value: "boom",
      environment: "production",
      release: "2.4.1",
      session_id: "sess_" + "c".repeat(32),
      sdk: "secploy-test",
      platform: "web",
      route: "/cart",
      mechanism: "manual",
      handled: true,
    });
    expect(event.payload.context.frames.length).toBeGreaterThan(0);
    expect(event.payload.context.has_replay).toBeUndefined();
  });

  it("asks replay for the window behind an error, under the error's own id", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const c = client(fetchImpl);
    const replay = fakeReplay();
    (c as any).replay = replay;

    const eventId = c.captureException(new Error("x"));
    await c.flush();

    expect(replay.flushForError).toHaveBeenCalledWith(eventId);
    expect(bodies[0].events[0].payload.context.has_replay).toBe(true);
  });

  it("does not claim a replay once the recorder has stopped", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const c = client(fetchImpl);
    const replay = fakeReplay(false);
    (c as any).replay = replay;

    c.captureException(new Error("x"));
    await c.flush();

    expect(replay.flushForError).not.toHaveBeenCalled();
    expect(bodies[0].events[0].payload.context.has_replay).toBeUndefined();
  });

  it("uploads no recording for an error the app's own filter dropped", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const c = client(fetchImpl, { beforeSend: () => null });
    const replay = fakeReplay();
    (c as any).replay = replay;

    expect(c.captureException(new Error("x"))).toBeNull();
    await c.flush();

    expect(replay.flushForError).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(0);
  });

  it("scrubs credentials but keeps the session id", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const c = client(fetchImpl);

    c.sendEvent("info", { message: "login", context: { password: "hunter2", session_id: c.sessionId } });
    await c.flush();

    const context = bodies[0].events[0].payload.context;
    expect(context.password).toBe("[secploy:redacted]");
    expect(context.session_id).toBe(c.sessionId);
  });

  it("drops a batch the ingest refuses rather than keeping it forever", async () => {
    const { bodies, fetchImpl } = recordingFetch(400);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = client(fetchImpl);

    c.sendEvent("info", { message: "a" });
    await c.flush();
    await c.flush();

    expect(bodies).toHaveLength(1);
    expect(c.diagnostics()).toMatchObject({ dropped: 1, queued: 0 });
    warn.mockRestore();
  });

  it("bounds the queue, discarding the oldest", () => {
    const { fetchImpl } = recordingFetch();
    const c = client(fetchImpl, { maxQueueSize: 2, batchSize: 100 });
    c.sendEvent("info", { message: "1" });
    c.sendEvent("info", { message: "2" });
    c.sendEvent("info", { message: "3" });
    expect(c.diagnostics()).toMatchObject({ queued: 2, dropped: 1 });
  });

  it("reports a message without the reporter's own frame", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const c = client(fetchImpl);
    c.captureMessage("checkout slow", "warning");
    await c.flush();

    const payload = bodies[0].events[0].payload;
    expect(payload.type).toBe("warning");
    expect(payload.message).toBe("Message: checkout slow");
    const functions = payload.context.frames.map((f: any) => f.function);
    expect(functions.some((fn: string) => fn.includes("captureMessage"))).toBe(false);
  });
});
