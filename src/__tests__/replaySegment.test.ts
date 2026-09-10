import {
  FrameRingBuffer,
  trimToSegmentBudget,
} from "../replay/buffer";
import {
  SegmentFormatError,
  SegmentHeader,
  readSegment,
  segmentSize,
  writeSegment,
} from "../replay/segment";

const header = (overrides: Partial<SegmentHeader> = {}): SegmentHeader => ({
  session_id: "sess_" + "a".repeat(32),
  seq: 3,
  started_at: "2026-09-10T12:00:00.000Z",
  width: 120,
  height: 260,
  frame_count: 2,
  frame_interval_ms: 1000,
  codec: "jpeg",
  ...overrides,
});

describe(".sr1 segments", () => {
  it("round-trips a header and its frames", () => {
    const frames = [Uint8Array.from([1, 2, 3]), Uint8Array.from([9])];
    const bytes = writeSegment(header(), frames);
    const parsed = readSegment(bytes);

    expect(parsed.header).toEqual(header());
    expect(parsed.frames.map((f) => Array.from(f))).toEqual([[1, 2, 3], [9]]);
  });

  it("lays bytes out exactly as the Dart writer and dashboard reader expect", () => {
    const h = header({ frame_count: 1 });
    const bytes = writeSegment(h, [Uint8Array.from([0xaa, 0xbb])]);
    const view = new DataView(bytes.buffer);
    const json = JSON.stringify(h);

    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x53, 0x52, 0x30, 0x31]);
    expect(view.getUint16(4)).toBe(1); // version, big-endian
    expect(view.getUint32(6)).toBe(json.length); // header length, big-endian
    expect(Buffer.from(bytes.subarray(10, 10 + json.length)).toString()).toBe(json);
    expect(view.getUint32(10 + json.length)).toBe(2);
    expect(Array.from(bytes.subarray(14 + json.length))).toEqual([0xaa, 0xbb]);
    expect(segmentSize(h, [2])).toBe(bytes.length);
  });

  it("writes header keys in the Dart writer's order", () => {
    const bytes = writeSegment(header({ frame_count: 0 }), []);
    const json = Buffer.from(bytes.subarray(10, bytes.length)).toString();
    expect(Object.keys(JSON.parse(json))).toEqual([
      "session_id",
      "seq",
      "started_at",
      "width",
      "height",
      "frame_count",
      "frame_interval_ms",
      "codec",
    ]);
  });

  it("refuses a header whose frame count disagrees with the frames", () => {
    expect(() => writeSegment(header({ frame_count: 3 }), [new Uint8Array(1)])).toThrow(
      SegmentFormatError,
    );
  });

  it("refuses truncated and foreign input", () => {
    const bytes = writeSegment(header(), [new Uint8Array(10), new Uint8Array(10)]);
    expect(() => readSegment(bytes.subarray(0, bytes.length - 1))).toThrow(/past the end/);
    expect(() => readSegment(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow(
      /bad magic/,
    );
  });
});

describe("FrameRingBuffer", () => {
  const frame = (size: number, at = 0) => ({ bytes: new Uint8Array(size), capturedAt: at });

  it("evicts oldest-first to stay under the byte ceiling", () => {
    const buffer = new FrameRingBuffer(100, 50);
    buffer.add(frame(40, 1));
    buffer.add(frame(40, 2));
    buffer.add(frame(40, 3));

    expect(buffer.byteLength).toBe(80);
    expect(buffer.evictedCount).toBe(1);
    expect(buffer.drain().map((f) => f.capturedAt)).toEqual([2, 3]);
  });

  it("bounds the frame count too", () => {
    const buffer = new FrameRingBuffer(1000, 2);
    [1, 2, 3].forEach((at) => buffer.add(frame(1, at)));
    expect(buffer.drain().map((f) => f.capturedAt)).toEqual([2, 3]);
  });

  it("refuses a frame larger than the whole budget instead of emptying itself", () => {
    const buffer = new FrameRingBuffer(100, 10);
    buffer.add(frame(50, 1));
    buffer.add(frame(101, 2));
    expect(buffer.drain().map((f) => f.capturedAt)).toEqual([1]);
  });

  it("starts a fresh window after draining", () => {
    const buffer = new FrameRingBuffer(100, 10);
    buffer.add(frame(10));
    buffer.drain();
    expect(buffer.length).toBe(0);
    expect(buffer.byteLength).toBe(0);
  });

  it("trims to a segment budget keeping the frames nearest the error", () => {
    const frames = [1, 2, 3, 4].map((at) => frame(1000, at));
    const kept = trimToSegmentBudget(frames, 2048 + 2 * 1004);
    expect(kept.map((f) => f.capturedAt)).toEqual([3, 4]);
  });
});
