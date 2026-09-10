"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenReplayRecorder = exports.SCREEN_REPLAY_DEFAULTS = void 0;
exports.setActiveRecorder = setActiveRecorder;
exports.registerSource = registerSource;
exports.unregisterSource = unregisterSource;
const base64_1 = require("../portable/base64");
const buffer_1 = require("../replay/buffer");
const segment_1 = require("../replay/segment");
const uploader_1 = require("../replay/uploader");
const jpegMask_1 = require("./jpegMask");
exports.SCREEN_REPLAY_DEFAULTS = {
    framesPerSecond: 1,
    pixelRatio: 0.3,
    quality: 0.6,
    bufferSeconds: 30,
    maxBufferBytes: 4 * 1024 * 1024,
    maxSegmentBytes: 2 * 1024 * 1024,
    maskColor: [26, 26, 26],
};
class ScreenReplayRecorder {
    constructor(args) {
        this.source = null;
        this.timer = null;
        this.capturing = false;
        this.uploading = false;
        this.paused = false;
        this.stoppedReason = null;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.framesCaptured = 0;
        this.segmentsUploaded = 0;
        this.failures = {};
        const options = { ...exports.SCREEN_REPLAY_DEFAULTS, ...args.options };
        for (const [key, value] of Object.entries(exports.SCREEN_REPLAY_DEFAULTS)) {
            if (options[key] === undefined)
                options[key] = value;
        }
        options.framesPerSecond = Math.min(10, Math.max(0.1, options.framesPerSecond));
        this.options = options;
        this.sessionId = args.sessionId;
        this.uploader = args.uploader;
        this.sequence = args.sequence;
        this.emit = args.emit;
        this.onDiagnostic = args.onDiagnostic ?? (() => undefined);
        this.buffer = new buffer_1.FrameRingBuffer(options.maxBufferBytes, 
        // Twice what the window nominally holds, so a burst of cheap frames does
        // not start evicting a window that is still inside its byte budget.
        Math.max(2, Math.ceil(options.bufferSeconds * options.framesPerSecond) * 2));
    }
    get frameIntervalMs() {
        return Math.round(1000 / this.options.framesPerSecond);
    }
    get active() {
        return this.stoppedReason === null && this.source !== null;
    }
    get isRecording() {
        return this.timer !== null;
    }
    attach(source) {
        this.source = source;
        this.start();
    }
    detach(source) {
        if (this.source !== source)
            return;
        this.source = null;
        this.stopTimer();
    }
    start() {
        if (this.timer || this.stoppedReason || this.paused || !this.source)
            return;
        this.timer = setInterval(() => {
            void this.captureFrame();
        }, this.frameIntervalMs);
        this.timer.unref?.();
    }
    stopTimer() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /**
     * Backgrounded. The frames are kept - an error can still fire on resume, and
     * the seconds before a backgrounding are often exactly the interesting ones -
     * but capture pauses: a view the OS is not compositing captures as nothing.
     */
    pause() {
        this.paused = true;
        this.stopTimer();
    }
    resume() {
        this.paused = false;
        this.start();
    }
    stop() {
        this.stopTimer();
        this.buffer.clear();
    }
    fail(reason) {
        // Counted, not logged per occurrence: a screen mid-transition can fail
        // every tick, and a log line a second would be its own bug.
        this.failures[reason] = (this.failures[reason] ?? 0) + 1;
    }
    /** One frame. Public for tests; driven by the timer otherwise. */
    async captureFrame() {
        const source = this.source;
        if (this.capturing || this.stoppedReason || !source)
            return;
        // Held for the whole capture, so a frame slower than the tick interval
        // cannot stack two captures on one view.
        this.capturing = true;
        try {
            const before = await source.measureMasks();
            if (!before.ok)
                return this.fail(before.reason);
            const { width: rootWidth, height: rootHeight } = before.root;
            const target = source.captureTarget();
            if (!target)
                return this.fail("not_mounted");
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
            if (!after.ok)
                return this.fail(after.reason);
            let bytes = (0, base64_1.base64ToBytes)(captured);
            const size = (0, jpegMask_1.jpegDimensions)(bytes);
            if (!size)
                return this.fail("not_a_jpeg");
            const scaleX = size.width / rootWidth;
            const scaleY = size.height / rootHeight;
            const rects = [...before.rects, ...after.rects].map((rect) => ({
                x: rect.x * scaleX,
                y: rect.y * scaleY,
                width: rect.width * scaleX,
                height: rect.height * scaleY,
            }));
            if (rects.length > 0) {
                bytes = (0, jpegMask_1.maskJpeg)(bytes, rects, {
                    quality: this.options.quality * 100,
                    color: this.options.maskColor,
                });
            }
            this.buffer.add({ bytes, capturedAt: Date.now() });
            this.framesCaptured++;
            this.lastWidth = size.width;
            this.lastHeight = size.height;
        }
        catch {
            // Nothing may escape a capture. This runs on a timer inside someone
            // else's app, where an escaping error is reported once per tick - a
            // single bug in here becomes thousands of events about nothing.
            this.fail("capture_failed");
        }
        finally {
            this.capturing = false;
        }
    }
    /**
     * Upload the window that led to an error.
     *
     * Returns the object key, or null if nothing was sent. Never throws: it is
     * called from the error path.
     */
    async flushForError(errorEventId) {
        if (this.stoppedReason)
            return null;
        if (this.uploading)
            return null;
        const frames = this.buffer.drain();
        if (frames.length === 0)
            return null;
        this.uploading = true;
        try {
            const trimmed = (0, buffer_1.trimToSegmentBudget)(frames, this.options.maxSegmentBytes);
            if (trimmed.length === 0)
                return null;
            const header = {
                session_id: this.sessionId,
                seq: this.sequence.peek(),
                started_at: new Date(trimmed[0].capturedAt).toISOString(),
                width: this.lastWidth || 1,
                height: this.lastHeight || 1,
                frame_count: trimmed.length,
                frame_interval_ms: this.frameIntervalMs,
                codec: "jpeg",
            };
            const bytes = (0, segment_1.writeSegment)(header, trimmed.map((frame) => frame.bytes));
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
            this.emit("replay.segment", (0, uploader_1.replaySegmentEvent)({
                header,
                objectKey: outcome.objectKey,
                byteSize: bytes.length,
                durationMs,
                errorEventId,
            }));
            return outcome.objectKey;
        }
        catch (error) {
            this.onDiagnostic(`Replay upload failed: ${error}`);
            return null;
        }
        finally {
            this.uploading = false;
        }
    }
    diagnostics() {
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
exports.ScreenReplayRecorder = ScreenReplayRecorder;
/**
 * How `SecployReplayRoot` and the live recorder find each other without the
 * component importing the client, which imports the component.
 *
 * Either may arrive first: an app can mount its root before `init` runs, or
 * call `init` before anything renders.
 */
let activeRecorder = null;
let mountedSource = null;
function setActiveRecorder(recorder) {
    if (activeRecorder && mountedSource)
        activeRecorder.detach(mountedSource);
    activeRecorder = recorder;
    if (recorder && mountedSource)
        recorder.attach(mountedSource);
}
function registerSource(source) {
    mountedSource = source;
    activeRecorder?.attach(source);
}
function unregisterSource(source) {
    if (mountedSource !== source)
        return;
    activeRecorder?.detach(source);
    mountedSource = null;
}
