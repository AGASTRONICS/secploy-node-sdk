import { gunzipSync } from "zlib";

import {
  DomReplayRecorder,
  WEB_REPLAY_DEFAULTS,
  buildRecordOptions,
  isUnmasked,
} from "../browser/domRecorder";
import { MemorySequence } from "../replay/sequence";
import { readSegment } from "../replay/segment";

const SESSION = "sess_" + "d".repeat(32);

/** A stand-in for rrweb's `record`, emitting what rrweb emits. */
function fakeRrweb() {
  let emit: (event: any, isCheckout?: boolean) => void = () => undefined;
  let options: Record<string, any> = {};
  let now = 1_000;
  const stop = jest.fn();

  const snapshot = (isCheckout: boolean, size = 10) => {
    emit({ type: 4, data: { href: "https://app/x", width: 1280, height: 720 }, timestamp: now++ }, isCheckout);
    emit({ type: 2, data: { node: { html: "x".repeat(size) } }, timestamp: now++ }, isCheckout);
  };

  const record: any = jest.fn((opts: Record<string, any>) => {
    options = opts;
    emit = opts.emit;
    snapshot(false);
    return stop;
  });
  record.takeFullSnapshot = jest.fn((isCheckout?: boolean) => snapshot(Boolean(isCheckout)));

  return {
    record,
    stop,
    options: () => options,
    snapshot,
    incremental: (size = 10) =>
      emit({ type: 3, data: { source: 0, text: "y".repeat(size) }, timestamp: now++ }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function recorder(overrides: Record<string, unknown> = {}, upload?: jest.Mock) {
  const rrweb = fakeRrweb();
  const uploader = {
    upload:
      upload ??
      jest.fn(async () => ({ objectKey: "replay/t/p/s/000000.sr1", failure: null, permanent: false })),
  };
  const emitted: Array<[string, any]> = [];
  const sequence = new MemorySequence();
  const rec = new DomReplayRecorder({
    options: { record: rrweb.record, ...overrides },
    sessionId: SESSION,
    uploader: uploader as any,
    sequence,
    emit: (type, payload) => emitted.push([type, payload]),
  });
  return { rec, rrweb, uploader, emitted, sequence };
}

/** Unpack an uploaded segment back into rrweb events. */
function eventsOf(bytes: Uint8Array) {
  const segment = readSegment(bytes);
  const events = segment.frames.flatMap((frame) =>
    JSON.parse(
      (segment.header.codec === "rrweb+gzip" ? gunzipSync(frame) : Buffer.from(frame)).toString(),
    ),
  );
  return { header: segment.header, events };
}

describe("DomReplayRecorder", () => {
  it("uploads a window that starts with a snapshot, as a gzip rrweb segment", async () => {
    const { rec, rrweb, uploader, emitted, sequence } = recorder();
    expect(rec.start()).toBe(true);
    rrweb.incremental();
    rrweb.advance(5_000);
    rrweb.incremental();

    const key = await rec.flushForError("evt-1");
    expect(key).toBe("replay/t/p/s/000000.sr1");

    const { header, bytes, durationMs } = uploader.upload.mock.calls[0][0];
    const { events } = eventsOf(bytes);
    expect(header).toMatchObject({
      session_id: SESSION,
      seq: 0,
      codec: "rrweb+gzip",
      width: 1280,
      height: 720,
      frame_interval_ms: 0,
    });
    expect(events.map((e: any) => e.type)).toEqual([4, 2, 3, 3]);
    expect(durationMs).toBe(events[3].timestamp - events[0].timestamp);

    expect(sequence.peek()).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe("replay.segment");
    expect(emitted[0][1].context).toMatchObject({
      error_event_id: "evt-1",
      codec: "rrweb+gzip",
      event_count: 4,
    });
  });

  it("keeps two generations across checkouts, and no more", async () => {
    const { rec, rrweb, uploader } = recorder();
    rec.start();
    rrweb.incremental(); // generation 1: meta, snapshot, incremental
    rrweb.snapshot(true); // checkout -> generation 2
    rrweb.incremental();
    rrweb.snapshot(true); // checkout -> generation 3; generation 1 is gone
    rrweb.incremental();

    await rec.flushForError();
    const { events } = eventsOf(uploader.upload.mock.calls[0][0].bytes);
    expect(events.map((e: any) => e.type)).toEqual([4, 2, 3, 4, 2, 3]);
  });

  it("starts the next window with its own snapshot so the next error is playable", async () => {
    const { rec, rrweb, uploader } = recorder();
    rec.start();
    await rec.flushForError();
    expect(rrweb.record.takeFullSnapshot).toHaveBeenCalledWith(true);

    rrweb.incremental();
    await rec.flushForError();
    const second = eventsOf(uploader.upload.mock.calls[1][0].bytes);
    expect(second.events.map((e: any) => e.type)).toEqual([4, 2, 3]);
    expect(second.header.seq).toBe(1);
  });

  it("forces a checkout when one generation outgrows the buffer", () => {
    const { rec, rrweb } = recorder({ maxBufferBytes: 2_000 });
    rec.start();
    for (let i = 0; i < 5; i++) rrweb.incremental(500);

    expect(rrweb.record.takeFullSnapshot).toHaveBeenCalledWith(true);
    const held = rec.diagnostics();
    expect(held.buffered_bytes as number).toBeLessThanOrEqual(2_000);
    expect(rec.active).toBe(true);
  });

  it("stops on a page whose single snapshot exceeds the buffer", () => {
    const rrweb = fakeRrweb();
    const rec = new DomReplayRecorder({
      options: {
        record: Object.assign(
          jest.fn((opts: any) => {
            opts.emit({ type: 4, data: {}, timestamp: 1 }, false);
            opts.emit({ type: 2, data: { html: "z".repeat(5_000) }, timestamp: 2 }, false);
            return rrweb.stop;
          }),
          { takeFullSnapshot: jest.fn() },
        ),
        maxBufferBytes: 1_000,
      },
      sessionId: SESSION,
      uploader: { upload: jest.fn() } as any,
      sequence: new MemorySequence(),
      emit: () => undefined,
    });

    rec.start();
    expect(rec.active).toBe(false);
    expect(rec.diagnostics().stopped_reason).toBe("page_too_large");
    expect(rrweb.stop).toHaveBeenCalled();
  });

  it("stops asking once the server has permanently refused", async () => {
    const upload = jest.fn(async () => ({ objectKey: null, failure: "quotaExceeded", permanent: true }));
    const { rec, rrweb, emitted, sequence } = recorder({}, upload);
    rec.start();

    expect(await rec.flushForError()).toBeNull();
    expect(rec.active).toBe(false);
    expect(rrweb.stop).toHaveBeenCalled();
    expect(sequence.peek()).toBe(0);
    expect(emitted).toHaveLength(0);

    expect(await rec.flushForError()).toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps the sequence number for a retry after a transient failure", async () => {
    const upload = jest.fn(async () => ({ objectKey: null, failure: "transient", permanent: false }));
    const { rec, sequence } = recorder({}, upload);
    rec.start();
    await rec.flushForError();
    expect(rec.active).toBe(true);
    expect(sequence.peek()).toBe(0);
  });

  it("falls back to uncompressed frames where there is no CompressionStream", async () => {
    const rrweb = fakeRrweb();
    const upload = jest.fn(async () => ({ objectKey: "k", failure: null, permanent: false }));
    const rec = new DomReplayRecorder({
      options: { record: rrweb.record },
      sessionId: SESSION,
      uploader: { upload } as any,
      sequence: new MemorySequence(),
      emit: () => undefined,
      compress: async () => null,
    });
    rec.start();
    await rec.flushForError();

    const { header, events } = eventsOf((upload.mock.calls[0] as any)[0].bytes);
    expect(header.codec).toBe("rrweb");
    expect(events).toHaveLength(2);
  });
});

describe("rrweb privacy options", () => {
  const options = { ...WEB_REPLAY_DEFAULTS, record: jest.fn() as any };

  /** An element whose ancestors answer `closest` from a map. */
  const element = (matches: Record<string, any>, extra: Record<string, any> = {}) => ({
    closest: (selector: string) => matches[selector] ?? null,
    ...extra,
  });

  it("masks all text and inputs, and records no canvas, images or fonts", () => {
    const built = buildRecordOptions(options, () => undefined);
    expect(built).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: "*",
      recordCanvas: false,
      inlineImages: false,
      collectFonts: false,
      checkoutEveryNms: 30_000,
    });
    expect(built.blockSelector).toContain("[data-secploy-block]");
    expect(built.blockSelector).toContain("img");
  });

  it("does not let recordOptions switch privacy off", () => {
    const built = buildRecordOptions(
      { ...options, recordOptions: { maskAllInputs: false, recordCanvas: true, maskTextSelector: null } },
      () => undefined,
    );
    expect(built.maskAllInputs).toBe(true);
    expect(built.recordCanvas).toBe(false);
    expect(built.maskTextSelector).toBe("*");
  });

  it("reveals text only inside an unmasked region", () => {
    const { maskTextFn } = buildRecordOptions(options, () => undefined);
    const unmaskRoot = {};
    expect(maskTextFn("Total $42", element({}))).toBe("***** ***");
    expect(maskTextFn("Total $42", element({ "[data-secploy-unmask]": unmaskRoot }))).toBe(
      "Total $42",
    );
  });

  it("lets the nearer marker win when mask and unmask nest", () => {
    const unmask = {};
    const maskAround = { contains: (node: unknown) => node === unmask };
    const maskInside = { contains: () => false };

    expect(
      isUnmasked(element({ "[data-secploy-unmask]": unmask, "[data-secploy-mask]": maskAround }), options),
    ).toBe(true);
    expect(
      isUnmasked(element({ "[data-secploy-unmask]": unmask, "[data-secploy-mask]": maskInside }), options),
    ).toBe(false);
  });

  it("never reveals a password field, even inside an unmasked region", () => {
    const { maskInputFn } = buildRecordOptions(options, () => undefined);
    const inside = { "[data-secploy-unmask]": {} };
    expect(maskInputFn("hunter2", element(inside, { type: "password" }))).toBe("*******");
    expect(maskInputFn("alice", element(inside, { type: "text" }))).toBe("alice");
    expect(maskInputFn("alice", element({}, { type: "text" }))).toBe("*****");
  });

  it("swallows rrweb's own errors instead of reporting them as the app's", () => {
    const seen: unknown[] = [];
    const { errorHandler } = buildRecordOptions(options, () => undefined, (e) => seen.push(e));
    expect(errorHandler(new Error("rrweb internal"))).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
