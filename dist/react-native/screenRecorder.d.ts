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
import { ReplayHook } from "../lite/client";
import { SequenceStore } from "../replay/sequence";
import { SegmentUploader } from "../replay/uploader";
import { MaskMeasurement } from "./fiberMasks";
/** `captureRef` from `react-native-view-shot`, as much of it as is used. */
export type CaptureRef = (target: any, options: {
    format: "jpg";
    quality: number;
    width: number;
    height: number;
    result: "base64";
}) => Promise<string>;
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
export declare const SCREEN_REPLAY_DEFAULTS: {
    framesPerSecond: number;
    pixelRatio: number;
    quality: number;
    bufferSeconds: number;
    maxBufferBytes: number;
    maxSegmentBytes: number;
    maskColor: [number, number, number];
};
/** What the mounted `SecployReplayRoot` offers the recorder. */
export interface ScreenSource {
    /** The view to capture, or null while unmounted. */
    captureTarget(): unknown | null;
    /** Everything to mask, relative to the root, in layout units. */
    measureMasks(): Promise<MaskMeasurement>;
}
export interface ScreenReplayRecorderArgs {
    options: ScreenReplayOptions & {
        captureRef: CaptureRef;
    };
    sessionId: string;
    uploader: SegmentUploader;
    sequence: SequenceStore;
    emit: (type: string, payload: Record<string, any>) => void;
    onDiagnostic?: (message: string) => void;
}
export declare class ScreenReplayRecorder implements ReplayHook {
    private readonly options;
    private readonly sessionId;
    private readonly uploader;
    private readonly sequence;
    private readonly emit;
    private readonly onDiagnostic;
    private readonly buffer;
    private source;
    private timer;
    private capturing;
    private uploading;
    private paused;
    private stoppedReason;
    private lastWidth;
    private lastHeight;
    private framesCaptured;
    private segmentsUploaded;
    private readonly failures;
    constructor(args: ScreenReplayRecorderArgs);
    private get frameIntervalMs();
    get active(): boolean;
    get isRecording(): boolean;
    attach(source: ScreenSource): void;
    detach(source: ScreenSource): void;
    start(): void;
    private stopTimer;
    /**
     * Backgrounded. The frames are kept - an error can still fire on resume, and
     * the seconds before a backgrounding are often exactly the interesting ones -
     * but capture pauses: a view the OS is not compositing captures as nothing.
     */
    pause(): void;
    resume(): void;
    stop(): void;
    private fail;
    /** One frame. Public for tests; driven by the timer otherwise. */
    captureFrame(): Promise<void>;
    /**
     * Upload the window that led to an error.
     *
     * Returns the object key, or null if nothing was sent. Never throws: it is
     * called from the error path.
     */
    flushForError(errorEventId?: string): Promise<string | null>;
    diagnostics(): Record<string, unknown>;
}
export declare function setActiveRecorder(recorder: ScreenReplayRecorder | null): void;
export declare function registerSource(source: ScreenSource): void;
export declare function unregisterSource(source: ScreenSource): void;
