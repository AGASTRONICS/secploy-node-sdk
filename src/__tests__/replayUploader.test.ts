import { SegmentHeader } from "../replay/segment";
import { FetchLike, SegmentUploader, replaySegmentEvent } from "../replay/uploader";

const header: SegmentHeader = {
  session_id: "sess_" + "b".repeat(32),
  seq: 0,
  started_at: "2026-09-10T12:00:00.000Z",
  width: 390,
  height: 844,
  frame_count: 2,
  frame_interval_ms: 0,
  codec: "rrweb+gzip",
};

interface Call {
  url: string;
  init: Parameters<FetchLike>[1];
}

function fakeFetch(
  mint: { status: number; body?: unknown } | Error,
  put: { status: number } | Error = { status: 200 },
) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const answer = init?.method === "PUT" ? put : mint;
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status,
      json: async () => ("body" in answer ? answer.body : {}),
    };
  };
  return { calls, fetchImpl };
}

const minted = {
  status: 201,
  body: {
    upload_url: "https://r2.example/replay/t/p/s/000000.sr1?X-Amz-Signature=abc",
    object_key: "replay/t/p/s/000000.sr1",
    content_type: "application/octet-stream",
  },
};

function uploader(fetchImpl: FetchLike) {
  return new SegmentUploader({
    apiUrl: "https://api.example.com/",
    headers: () => ({ "X-API-Key": "key", "X-Environment-Key": "env" }),
    fetchImpl,
    timeoutMs: 1000,
  });
}

describe("SegmentUploader", () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);

  it("asks for a URL naming the exact size, then PUTs exactly those bytes", async () => {
    const { calls, fetchImpl } = fakeFetch(minted);
    const outcome = await uploader(fetchImpl).upload({ header, bytes, durationMs: 4200 });

    expect(outcome).toEqual({
      objectKey: "replay/t/p/s/000000.sr1",
      failure: null,
      permanent: false,
    });

    const [mint, put] = calls;
    expect(mint.url).toBe("https://api.example.com/projects/replay/upload-url/");
    expect(mint.init?.method).toBe("POST");
    expect(mint.init?.credentials).toBe("omit");
    expect(mint.init?.headers).toMatchObject({
      "X-API-Key": "key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(mint.init?.body)).toEqual({
      session_id: header.session_id,
      seq: 0,
      byte_size: 5,
      duration_ms: 4200,
      frame_count: 2,
      width: 390,
      height: 844,
    });

    expect(put.url).toBe(minted.body.upload_url);
    expect(put.init?.method).toBe("PUT");
    // The API key must never ride along to the storage provider.
    expect(put.init?.headers).toEqual({ "Content-Type": "application/octet-stream" });
    expect(put.init?.body).toBe(bytes);
  });

  it.each([
    [503, "notConfigured", true],
    [402, "quotaExceeded", true],
    [401, "unauthorized", true],
    [403, "unauthorized", true],
    [400, "rejected", true],
    [500, "transient", false],
    [429, "transient", false],
  ])("maps a %s from the API to %s", async (status, failure, permanent) => {
    const { calls, fetchImpl } = fakeFetch({ status });
    const outcome = await uploader(fetchImpl).upload({ header, bytes, durationMs: 1 });
    expect(outcome).toEqual({ objectKey: null, failure, permanent });
    expect(calls).toHaveLength(1);
  });

  it("treats a network failure as transient", async () => {
    const { fetchImpl } = fakeFetch(new Error("offline"));
    expect(await uploader(fetchImpl).upload({ header, bytes, durationMs: 1 })).toMatchObject({
      failure: "transient",
      permanent: false,
    });
  });

  it("treats a storage signature refusal as permanent, and other PUT failures as transient", async () => {
    const refused = fakeFetch(minted, { status: 403 });
    expect(
      await uploader(refused.fetchImpl).upload({ header, bytes, durationMs: 1 }),
    ).toMatchObject({ failure: "rejected", permanent: true });

    const blocked = fakeFetch(minted, new TypeError("Failed to fetch"));
    expect(
      await uploader(blocked.fetchImpl).upload({ header, bytes, durationMs: 1 }),
    ).toMatchObject({ failure: "transient", permanent: false });
  });

  it("treats a mint response without a URL as transient", async () => {
    const { fetchImpl } = fakeFetch({ status: 201, body: { object_key: "k" } });
    expect(await uploader(fetchImpl).upload({ header, bytes, durationMs: 1 })).toMatchObject({
      failure: "transient",
    });
  });
});

describe("replaySegmentEvent", () => {
  it("carries every field the ingest indexes, plus the error it belongs to", () => {
    const event = replaySegmentEvent({
      header,
      objectKey: "replay/t/p/s/000000.sr1",
      byteSize: 999,
      durationMs: 31000,
      errorEventId: "evt-1",
      extra: { event_count: 42 },
    });

    expect(event.type).toBe("replay.segment");
    expect(event.context).toEqual({
      session_id: header.session_id,
      seq: 0,
      object_key: "replay/t/p/s/000000.sr1",
      started_at: header.started_at,
      frame_count: 2,
      frame_interval_ms: 0,
      duration_ms: 31000,
      width: 390,
      height: 844,
      codec: "rrweb+gzip",
      byte_size: 999,
      error_event_id: "evt-1",
      event_count: 42,
    });
  });
});
