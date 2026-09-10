import * as jpeg from "jpeg-js";

import {
  FiberLike,
  HOST_COMPONENT,
  HOST_ROOT,
  Measurable,
  collectMaskTargets,
  currentFiberOf,
  measureTargets,
} from "../react-native/fiberMasks";
import { jpegDimensions, maskJpeg } from "../react-native/jpegMask";
import { ScreenReplayRecorder, ScreenSource } from "../react-native/screenRecorder";
import { MemorySequence } from "../replay/sequence";
import { readSegment } from "../replay/segment";

// --- helpers ---------------------------------------------------------------

const at = (x: number, y: number, width: number, height: number): Measurable => ({
  measureInWindow: (cb) => cb(x, y, width, height),
});

function fiber(type: unknown, props: Partial<FiberLike> = {}, children: FiberLike[] = []): FiberLike {
  const node: FiberLike = { tag: typeof type === "string" ? HOST_COMPONENT : 0, type, ...props };
  children.forEach((child, i) => {
    child.return = node;
    if (i === 0) node.child = child;
    if (i > 0) children[i - 1].sibling = child;
  });
  return node;
}

const host = (type: string, instance: unknown, children: FiberLike[] = []) =>
  fiber(type, { stateNode: instance }, children);

const Mask = () => null;
const Unmask = () => null;
const markers = { mask: Mask, unmask: Unmask };

/** A solid-colour JPEG. */
function solidJpeg(width: number, height: number, value = 255): Uint8Array {
  const data = Buffer.alloc(width * height * 4, value);
  return new Uint8Array(jpeg.encode({ data, width, height }, 90).data);
}

function pixel(bytes: Uint8Array, x: number, y: number): number {
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return decoded.data[(y * decoded.width + x) * 4];
}

// --- fiber walk ------------------------------------------------------------

describe("collectMaskTargets", () => {
  it("masks text, inputs and images by default and leaves plain views alone", () => {
    const text = at(0, 0, 10, 10);
    const input = at(0, 20, 10, 10);
    const image = at(0, 40, 10, 10);
    const root = fiber("Root", {}, [
      host("RCTView", at(0, 0, 100, 100), [
        host("RCTText", text, [host("RCTVirtualText", at(0, 0, 1, 1))]),
        host("AndroidTextInput", input),
        host("RCTImageView", image),
        host("RCTView", at(0, 60, 10, 10)),
      ]),
    ]);

    const walk = collectMaskTargets(root, markers);
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    // Nested virtual text sits inside its parent's rectangle and is not walked.
    expect(walk.targets.map((t) => t.instance)).toEqual([text, input, image]);
  });

  it("exempts SecployUnmask subtrees, but not their siblings", () => {
    const inside = at(0, 0, 1, 1);
    const beside = at(0, 5, 1, 1);
    const root = fiber("Root", {}, [
      fiber(Unmask, {}, [host("RCTView", at(0, 0, 1, 1), [host("RCTText", inside)])]),
      host("RCTText", beside),
    ]);

    const walk = collectMaskTargets(root, markers);
    expect(walk.ok && walk.targets.map((t) => t.instance)).toEqual([beside]);
  });

  it("masks a SecployMask's own view, whatever it contains, even inside an unmask", () => {
    const maskView = at(0, 0, 50, 50);
    const root = fiber("Root", {}, [
      fiber(Unmask, {}, [
        fiber(Mask, {}, [host("RCTView", maskView, [host("RCTText", at(0, 0, 1, 1))])]),
      ]),
    ]);

    const walk = collectMaskTargets(root, markers);
    expect(walk.ok && walk.targets.map((t) => t.reason)).toEqual(["SecployMask"]);
    expect(walk.ok && walk.targets[0].instance).toBe(maskView);
  });

  it("finds the measurable instance on the new architecture's stateNode shapes", () => {
    const fabric = at(1, 1, 1, 1);
    const react19 = at(2, 2, 2, 2);
    const root = fiber("Root", {}, [
      host("RCTText", { node: {}, canonical: fabric }),
      host("RCTText", { node: {}, canonical: { publicInstance: react19 } }),
    ]);
    const walk = collectMaskTargets(root, markers);
    expect(walk.ok && walk.targets.map((t) => t.instance)).toEqual([fabric, react19]);
  });

  it("fails closed when a region to mask cannot be measured", () => {
    const root = fiber("Root", {}, [host("RCTText", { notMeasurable: true })]);
    expect(collectMaskTargets(root, markers)).toEqual({ ok: false, reason: "unmeasurable_host" });
  });
});

describe("currentFiberOf", () => {
  it("walks React's current tree, not the possibly stale fiber on the instance", () => {
    const instance = {};
    const stale = fiber("Root", { stateNode: instance }, []);
    const current = fiber("Root", { stateNode: instance }, [host("RCTText", at(0, 0, 1, 1))]);

    const hostRoot: FiberLike = { tag: HOST_ROOT, stateNode: {} };
    const currentRoot: FiberLike = { tag: HOST_ROOT, child: current };
    current.return = currentRoot;
    stale.return = hostRoot;
    hostRoot.stateNode.current = currentRoot;
    (instance as any)._reactInternals = stale;

    expect(currentFiberOf(instance)).toBe(current);
  });

  it("gives up on a component that is not mounted under a root", () => {
    const instance: any = {};
    instance._reactInternals = { tag: 1, stateNode: instance };
    expect(currentFiberOf(instance)).toBeNull();
    expect(currentFiberOf({})).toBeNull();
  });
});

describe("measureTargets", () => {
  it("reports rectangles relative to the captured root", async () => {
    const result = await measureTargets(
      [
        { instance: at(30, 120, 50, 20), reason: "RCTText" },
        { instance: at(0, 0, 0, 0), reason: "RCTImageView" },
      ],
      at(10, 100, 390, 800),
    );
    expect(result).toEqual({
      ok: true,
      root: { width: 390, height: 800 },
      rects: [{ x: 20, y: 20, width: 50, height: 20 }],
    });
  });

  it("fails when a target never answers", async () => {
    const silent: Measurable = { measureInWindow: () => undefined };
    const result = await measureTargets([{ instance: silent, reason: "RCTText" }], at(0, 0, 10, 10), 20);
    expect(result).toEqual({ ok: false, reason: "measure_failed" });
  });
});

// --- pixels ----------------------------------------------------------------

describe("maskJpeg", () => {
  it("reads dimensions from the frame header", () => {
    expect(jpegDimensions(solidJpeg(37, 21))).toEqual({ width: 37, height: 21 });
    expect(jpegDimensions(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
  });

  it("paints an opaque fill over the rectangles and nowhere else", () => {
    const masked = maskJpeg(solidJpeg(40, 20), [{ x: 10, y: 5, width: 10, height: 5 }], {
      quality: 90,
      color: [0, 0, 0],
    });
    expect(pixel(masked, 15, 7)).toBeLessThan(40);
    expect(pixel(masked, 35, 15)).toBeGreaterThan(215);
  });

  it("encodes where there is no Buffer, as on React Native, and leaves no Buffer behind", () => {
    const g = globalThis as any;
    const saved = g.Buffer;
    const input = solidJpeg(16, 16);
    delete g.Buffer;
    let masked: Uint8Array;
    try {
      masked = maskJpeg(input, [{ x: 0, y: 0, width: 8, height: 8 }], {
        quality: 80,
        color: [0, 0, 0],
      });
      expect(g.Buffer).toBeUndefined();
    } finally {
      g.Buffer = saved;
    }
    expect(jpegDimensions(masked!)).toEqual({ width: 16, height: 16 });
  });
});

// --- recorder --------------------------------------------------------------

describe("ScreenReplayRecorder", () => {
  function setup(measurements: Array<Awaited<ReturnType<ScreenSource["measureMasks"]>>>) {
    const queue = [...measurements];
    const source: ScreenSource = {
      captureTarget: () => ({ view: true }),
      measureMasks: jest.fn(async () => queue.shift() ?? measurements[measurements.length - 1]),
    };
    const captureRef = jest.fn(async (_target: unknown, options: { width: number; height: number }) =>
      Buffer.from(solidJpeg(options.width, options.height)).toString("base64"),
    );
    const upload = jest.fn(async () => ({ objectKey: "replay/k", failure: null, permanent: false }));
    const emitted: Array<[string, any]> = [];
    const rec = new ScreenReplayRecorder({
      options: { captureRef, pixelRatio: 0.3, maskColor: [0, 0, 0] },
      sessionId: "sess_" + "e".repeat(32),
      uploader: { upload } as any,
      sequence: new MemorySequence(),
      emit: (type, payload) => emitted.push([type, payload]),
    });
    rec.attach(source);
    rec.pause(); // drive frames by hand, not by the timer
    return { rec, source, captureRef, upload, emitted };
  }

  const leftHalf = {
    ok: true as const,
    root: { width: 100, height: 50 },
    rects: [{ x: 0, y: 0, width: 50, height: 50 }],
  };

  it("captures a downscaled, masked frame and uploads it as a jpeg segment", async () => {
    const { rec, captureRef, upload, emitted } = setup([leftHalf]);

    await rec.captureFrame();
    expect(captureRef).toHaveBeenCalledWith(
      { view: true },
      { format: "jpg", quality: 0.6, width: 30, height: 15, result: "base64" },
    );
    expect(rec.diagnostics()).toMatchObject({ frames_buffered: 1, frames_captured: 1 });

    expect(await rec.flushForError("evt-9")).toBe("replay/k");
    const { header, bytes } = (upload.mock.calls[0] as any)[0];
    const segment = readSegment(bytes);
    expect(header).toMatchObject({ codec: "jpeg", width: 30, height: 15, frame_count: 1, frame_interval_ms: 1000 });
    expect(pixel(segment.frames[0] as Uint8Array, 5, 7)).toBeLessThan(40);
    expect(pixel(segment.frames[0] as Uint8Array, 25, 7)).toBeGreaterThan(215);

    expect(emitted[0][1].context).toMatchObject({ error_event_id: "evt-9", codec: "jpeg" });
    rec.stop();
  });

  it("masks wherever a region was either before or after the capture", async () => {
    const moved = { ...leftHalf, rects: [{ x: 50, y: 0, width: 50, height: 50 }] };
    const { rec, upload } = setup([leftHalf, moved]);

    await rec.captureFrame();
    await rec.flushForError();
    const frame = readSegment((upload.mock.calls[0] as any)[0].bytes).frames[0] as Uint8Array;
    expect(pixel(frame, 5, 7)).toBeLessThan(40);
    expect(pixel(frame, 25, 7)).toBeLessThan(40);
    rec.stop();
  });

  it("drops the frame, unmasked and undecoded, when the second walk fails", async () => {
    const { rec, captureRef } = setup([leftHalf, { ok: false, reason: "measure_failed" }]);
    await rec.captureFrame();
    expect(captureRef).toHaveBeenCalledTimes(1);
    expect(rec.diagnostics()).toMatchObject({
      frames_buffered: 0,
      capture_failures: { measure_failed: 1 },
    });
    rec.stop();
  });

  it("does not capture at all when the first walk fails", async () => {
    const { rec, captureRef } = setup([{ ok: false, reason: "fiber_unavailable" }]);
    await rec.captureFrame();
    expect(captureRef).not.toHaveBeenCalled();
    rec.stop();
  });

  it("stops for the session on a permanent refusal", async () => {
    const { rec, upload } = setup([leftHalf]);
    upload.mockResolvedValueOnce({ objectKey: null, failure: "notConfigured", permanent: true } as any);
    await rec.captureFrame();
    expect(await rec.flushForError()).toBeNull();
    expect(rec.active).toBe(false);
    expect(rec.diagnostics().stopped_reason).toBe("notConfigured");
  });
});
