/**
 * Session replay for React Native: a timer, a rolling window, and what happens
 * when it ends.
 *
 * The same design as the Flutter SDK's `ReplayController`, deliberately:
 * error-buffer mode only. Frames are captured and thrown away continuously;
 * nothing is written anywhere until an error fires, and then the window already
 * in memory is what gets uploaded. On an app that does not crash, this costs
 * one small screenshot per second and produces no network traffic at all.
 *
 * Each frame is captured in four steps, and the order is the guarantee:
 *
 *   1. walk the tree and measure everything that must be masked
 *   2. capture the root view with `react-native-view-shot`
 *   3. measure again
 *   4. paint over the union of both measurements, then keep the frame
 *
 * Measuring on both sides of the capture is what covers a screen that moved
 * in between - a scroll, a transition. A region is painted wherever it was
 * just before or just after the capture. If either walk fails, the frame is
 * dropped: an unmasked frame is never kept on the theory that it is probably
 * fine.
 *
 * Nothing here imports React Native. The root component (`components.ts`)
 * supplies the capture target and the measurements, and `react-native-view-
 * shot`'s `captureRef` is passed in by the application.
 */

import { base64ToBytes } from "../portable/base64";
import { ReplayHook } from "../lite/client";
import {
  BufferedFrame,
  FrameRingBuffer,
  trimToSegmentBudget,
} from "../replay/buffer";
import { SegmentHeader, writeSegment } from "../replay/segment";
import { SequenceStore } from "../replay/sequence";
import { SegmentUploader, replaySegmentEvent } from "../replay/uploader";
import { MaskMeasurement, Rect } from "./fiberMasks";
import { jpegDimensions, maskJpeg } from "./jpegMask";

/** `captureRef` from `react-native-view-shot`, as much of it as is used. */
export type CaptureRef = (
  target: any,
  options: {
    format: "jpg";
    quality: number;
    width: number;
    height: number;
    result: "base64";
  },
) => Promise<string>;

export interface ScreenReplayOptions {
  /** Off by default: this records somebody else's user. */
  enabled?: boolean;
  /** `captureRef` from `react-native-view-shot`. Required when enabled. */
  captureRef?: CaptureRef;
  /**
   * One by default. The question replay answers - which screen, which
   * control, in what order - is answered at one frame a second, and each
   * capture costs a native snapshot on the device the user is holding.
   */
  framesPerSecond?: number;
  /**
   * Image pixels per layout unit. A third of layout size is legible for
   * layout and control identity while keeping each frame to a few kilobytes.
   * Matches the Flutter SDK's default.
   */
  pixelRatio?: number;
  /** JPEG quality, 0-1. */
  quality?: number;
  /** How much history to keep: the window uploaded when an error fires. */
  bufferSeconds?: number;
  /** Hard ceiling on what the window may occupy in the app's heap. */
  maxBufferBytes?: number;
  /**
   * Ceiling for one uploaded segment. Must not exceed the server's
   * SESSION_REPLAY_MAX_SEGMENT_BYTES, which is signed into the upload URL.
   */
  maxSegmentBytes?: number;
  /** The fill painted over masked regions, as RGB. */
  maskColor?: [number, number, number];
}

export const SCREEN_REPLAY_DEFAULTS = {
  framesPerSecond: 1,
  pixelRatio: 0.3,
  quality: 0.6,
  bufferSeconds: 30,
  maxBufferBytes: 4 * 1024 * 1024,
  maxSegmentBytes: 2 * 1024 * 1024,
  maskColor: [26, 26, 26] as [number, number, number],
};

type ResolvedScreenReplayOptions = ScreenReplayOptions &
  typeof SCREEN_REPLAY_DEFAULTS & { captureRef: CaptureRef };

/** What the mounted `SecployReplayRoot` offers the recorder. */
export interface ScreenSource {
  /** The view to capture, or null while unmounted. */
  captureTarget(): unknown | null;
  /** Everything to mask, relative to the root, in layout units. */
  measureMasks(): Promise<MaskMeasurement>;
}

export interface ScreenReplayRecorderArgs {
  options: ScreenReplayOptions & { captureRef: CaptureRef };
  sessionId: string;
  uploader: SegmentUploader;
  sequence: SequenceStore;
  emit: (type: string, payload: Record<string, any>) => void;
  onDiagnostic?: (message: string) => void;
}

export class ScreenReplayRecorder implements ReplayHook {
  private readonly options: ResolvedScreenReplayOptions;
  private readonly sessionId: string;
  private readonly uploader: SegmentUploader;
  private readonly sequence: SequenceStore;
  private readonly emit: ScreenReplayRecorderArgs["emit"];
  private readonly onDiagnostic: (message: string) => void;
  private readonly buffer: FrameRingBuffer;

  private source: ScreenSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private capturing = false;
  private uploading = false;
  private paused = false;
  private stoppedReason: string | null = null;

  private lastWidth = 0;
  private lastHeight = 0;
  private framesCaptured = 0;
  private segmentsUploaded = 0;
  private readonly failures: Record<string, number> = {};

  constructor(args: ScreenReplayRecorderArgs) {
    const options = { ...SCREEN_REPLAY_DEFAULTS, ...args.options } as ResolvedScreenReplayOptions;
    for (const [key, value] of Object.entries(SCREEN_REPLAY_DEFAULTS)) {
      if ((options as any)[key] === undefined) (options as any)[key] = value;
    }
    options.framesPerSecond = Math.min(10, Math.max(0.1, options.framesPerSecond));
    this.options = options;
    this.sessionId = args.sessionId;
    this.uploader = args.uploader;
    this.sequence = args.sequence;
    this.emit = args.emit;
    this.onDiagnostic = args.onDiagnostic ?? (() => undefined);
    this.buffer = new FrameRingBuffer(
      options.maxBufferBytes,
      // Twice what the window nominally holds, so a burst of cheap frames does
      // not start evicting a window that is still inside its byte budget.
      Math.max(2, Math.ceil(options.bufferSeconds * options.framesPerSecond) * 2),
    );
  }

  private get frameIntervalMs(): number {
    return Math.round(1000 / this.options.framesPerSecond);
  }

  get active(): boolean {
    return this.stoppedReason === null && this.source !== null;
  }

  get isRecording(): boolean {
    return this.timer !== null;
  }

  attach(source: ScreenSource): void {
    this.source = source;
    this.start();
  }

  detach(source: ScreenSource): void {
    if (this.source !== source) return;
    this.source = null;
    this.stopTimer();
  }

  start(): void {
    if (this.timer || this.stoppedReason || this.paused || !this.source) return;
    this.timer = setInterval(() => {
      void this.captureFrame();
    }, this.frameIntervalMs);
    (this.timer as any).unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Backgrounded. The frames are kept - an error can still fire on resume, and
   * the seconds before a backgrounding are often exactly the interesting ones -
   * but capture pauses: a view the OS is not compositing captures as nothing.
   */
  pause(): void {
    this.paused = true;
    this.stopTimer();
  }

  resume(): void {
    this.paused = false;
    this.start();
  }

  stop(): void {
    this.stopTimer();
    this.buffer.clear();
  }

  private fail(reason: string): void {
    // Counted, not logged per occurrence: a screen mid-transition can fail
    // every tick, and a log line a second would be its own bug.
    this.failures[reason] = (this.failures[reason] ?? 0) + 1;
  }

  /** One frame. Public for tests; driven by the timer otherwise. */
  async captureFrame(): Promise<void> {
    const source = this.source;
    if (this.capturing || this.stoppedReason || !source) return;

    // Held for the whole capture, so a frame slower than the tick interval
    // cannot stack two captures on one view.
    this.capturing = true;
    try {
      const before = await source.measureMasks();
      if (!before.ok) return this.fail(before.reason);

      const { width: rootWidth, height: rootHeight } = before.root;
      const target = source.captureTarget();
      if (!target) return this.fail("not_mounted");

      const width = Math.max(1, Math.round(rootWidth * this.options.pixelRatio));
      const height = Math.max(1, Math.round(rootHeight * this.options.pixelRatio));

      const captured = await this.options.captureRef(target, {
        format: "jpg",
        quality: this.options.quality,
        width,
        height,
        result: "base64",
      });

      const after = await source.measureMasks();
      // The screen changed in a way the walk could not follow. The capture is
      // discarded, unmasked, without ever being decoded.
      if (!after.ok) return this.fail(after.reason);

      let bytes = base64ToBytes(captured);
      const size = jpegDimensions(bytes);
      if (!size) return this.fail("not_a_jpeg");

      const scaleX = size.width / rootWidth;
      const scaleY = size.height / rootHeight;
      const rects: Rect[] = [...before.rects, ...after.rects].map((rect) => ({
        x: rect.x * scaleX,
        y: rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      }));

      if (rects.length > 0) {
        bytes = maskJpeg(bytes, rects, {
          quality: this.options.quality * 100,
          color: this.options.maskColor,
        });
      }

      this.buffer.add({ bytes, capturedAt: Date.now() });
      this.framesCaptured++;
      this.lastWidth = size.width;
      this.lastHeight = size.height;
    } catch {
      // Nothing may escape a capture. This runs on a timer inside someone
      // else's app, where an escaping error is reported once per tick - a
      // single bug in here becomes thousands of events about nothing.
      this.fail("capture_failed");
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Upload the window that led to an error.
   *
   * Returns the object key, or null if nothing was sent. Never throws: it is
   * called from the error path.
   */
  async flushForError(errorEventId?: string): Promise<string | null> {
    if (this.stoppedReason) return null;
    if (this.uploading) return null;

    const frames = this.buffer.drain();
    if (frames.length === 0) return null;

    this.uploading = true;
    try {
      const trimmed: BufferedFrame[] = trimToSegmentBudget(
        frames,
        this.options.maxSegmentBytes,
      );
      if (trimmed.length === 0) return null;

      const header: SegmentHeader = {
        session_id: this.sessionId,
        seq: this.sequence.peek(),
        started_at: new Date(trimmed[0].capturedAt).toISOString(),
        width: this.lastWidth || 1,
        height: this.lastHeight || 1,
        frame_count: trimmed.length,
        frame_interval_ms: this.frameIntervalMs,
        codec: "jpeg",
      };
      const bytes = writeSegment(
        header,
        trimmed.map((frame) => frame.bytes),
      );
      const durationMs = trimmed[trimmed.length - 1].capturedAt - trimmed[0].capturedAt;

      const outcome = await this.uploader.upload({ header, bytes, durationMs });
      if (!outcome.objectKey) {
        if (outcome.permanent) {
          // The deployment, the plan or the credentials said no. None of that
          // changes mid-session, so asking again would be a request per crash.
          this.stoppedReason = outcome.failure ?? "rejected";
          this.stop();
          this.onDiagnostic(`Session replay stopped for this session: ${outcome.failure}`);
        }
        return null;
      }

      this.sequence.commit();
      this.segmentsUploaded++;

      // Object first, index second. See uploader.ts.
      this.emit(
        "replay.segment",
        replaySegmentEvent({
          header,
          objectKey: outcome.objectKey,
          byteSize: bytes.length,
          durationMs,
          errorEventId,
        }),
      );
      return outcome.objectKey;
    } catch (error) {
      this.onDiagnostic(`Replay upload failed: ${error}`);
      return null;
    } finally {
      this.uploading = false;
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      kind: "screen",
      recording: this.isRecording,
      attached: this.source !== null,
      stopped_reason: this.stoppedReason,
      frames_captured: this.framesCaptured,
      frames_buffered: this.buffer.length,
      buffered_bytes: this.buffer.byteLength,
      frames_evicted: this.buffer.evictedCount,
      segments_uploaded: this.segmentsUploaded,
      capture_failures: { ...this.failures },
    };
  }
}

/**
 * How `SecployReplayRoot` and the live recorder find each other without the
 * component importing the client, which imports the component.
 *
 * Either may arrive first: an app can mount its root before `init` runs, or
 * call `init` before anything renders.
 */
let activeRecorder: ScreenReplayRecorder | null = null;
let mountedSource: ScreenSource | null = null;

export function setActiveRecorder(recorder: ScreenReplayRecorder | null): void {
  if (activeRecorder && mountedSource) activeRecorder.detach(mountedSource);
  activeRecorder = recorder;
  if (recorder && mountedSource) recorder.attach(mountedSource);
}

export function registerSource(source: ScreenSource): void {
  mountedSource = source;
  activeRecorder?.attach(source);
}

export function unregisterSource(source: ScreenSource): void {
  if (mountedSource !== source) return;
  activeRecorder?.detach(source);
  mountedSource = null;
}
