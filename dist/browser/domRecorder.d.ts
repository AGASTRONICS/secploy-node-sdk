/**
 * Session replay for the web: a DOM recording, not a screen recording.
 *
 * The mobile SDKs capture screenshots because a native app offers nothing
 * else to capture. A page does: rrweb records the DOM once and then only its
 * mutations, which costs the host page almost nothing in steady state. The
 * alternative - rasterising the DOM to an image every second - means
 * serialising and re-rendering the whole document on the main thread of
 * somebody else's page, every second, forever, to support a feature that is
 * used only when an error fires.
 *
 * **Masking happens before the recording exists.** rrweb replaces masked text
 * and input values while it serialises the DOM, so the real characters are
 * never in an event, never in this buffer and never on the wire. That is
 * stronger than the mobile SDKs can manage, where an unmasked bitmap exists for
 * a moment before it is painted over.
 *
 * **Error-buffer mode only**, as on mobile. Events are held in memory and
 * thrown away; only an error causes an upload. What makes that work for a DOM
 * recording is the checkout: a recording is playable only from a full
 * snapshot, so rrweb is asked to take a fresh one every `bufferSeconds`, and
 * two generations are kept - the previous checkout and the current one. The
 * window uploaded for an error therefore always begins with a snapshot and
 * covers between one and two buffer lengths of history.
 *
 * rrweb is not imported here. The application passes its `record` function in,
 * so the package carries no hard dependency on it and a page that leaves
 * replay off ships none of its code.
 */
import { ReplayHook } from "../lite/client";
import { SequenceStore } from "../replay/sequence";
import { SegmentUploader } from "../replay/uploader";
/** rrweb's `record`, as much of it as this module uses. */
export type RrwebRecord = ((options: Record<string, any>) => (() => void) | undefined | void) & {
    takeFullSnapshot?: (isCheckout?: boolean) => void;
};
export interface WebReplayOptions {
    /** Off by default: this records somebody else's user. */
    enabled?: boolean;
    /** `record` from the `rrweb` package. Required when enabled. */
    record?: RrwebRecord;
    /** History kept for an error. The upload holds between one and two of these. */
    bufferSeconds?: number;
    /** Ceiling on serialised events held in memory, in bytes. */
    maxBufferBytes?: number;
    /**
     * Ceiling for one uploaded segment. Must not exceed the server's
     * SESSION_REPLAY_MAX_SEGMENT_BYTES, which is signed into the upload URL.
     */
    maxSegmentBytes?: number;
    /**
     * Mask every text node. On by default, as on mobile: the failure mode of
     * the other default is a customer's data on a support ticket. Opt regions
     * back in with `data-secploy-unmask`.
     */
    maskAllText?: boolean;
    /** Replace images, video, canvas and iframes with placeholders. On by default. */
    blockMedia?: boolean;
    /** Always masked, even inside an unmasked region. */
    maskSelector?: string;
    /** Recorded as-is. Input values stay masked unless inside one of these too. */
    unmaskSelector?: string;
    /** Not recorded at all; replayed as an empty box of the same size. */
    blockSelector?: string;
    /**
     * Extra rrweb options - `sampling`, `recordCanvas` and so on. Privacy
     * options are applied after these and cannot be overridden from here.
     */
    recordOptions?: Record<string, unknown>;
}
export declare const WEB_REPLAY_DEFAULTS: {
    bufferSeconds: number;
    maxBufferBytes: number;
    maxSegmentBytes: number;
    maskAllText: boolean;
    blockMedia: boolean;
    maskSelector: string;
    unmaskSelector: string;
    blockSelector: string;
};
type ResolvedWebReplayOptions = WebReplayOptions & typeof WEB_REPLAY_DEFAULTS & {
    record: RrwebRecord;
};
/**
 * Whether an element sits in an unmasked region, with the nearer marker
 * winning - a `data-secploy-mask` inside an unmasked card masks again.
 */
export declare function isUnmasked(element: any, options: Pick<WebReplayOptions, "maskSelector" | "unmaskSelector">): boolean;
/**
 * The block selector for media, honouring unmasked regions.
 *
 * `:not()` with a complex selector inside is Selectors Level 4. A browser that
 * rejects it would make rrweb throw on every node, so it is tested first and
 * the fallback blocks all media - more than asked for, which is the safe way to
 * be wrong.
 */
export declare function mediaBlockSelector(unmaskSelector: string): string;
/** rrweb's options, with the privacy settings this SDK will not let slip. */
export declare function buildRecordOptions(options: ResolvedWebReplayOptions, emit: (event: any, isCheckout?: boolean) => void, onRecorderError?: (error: unknown) => void): Record<string, any>;
/** gzip via the platform's CompressionStream, or null where there is none. */
export declare function gzip(bytes: Uint8Array): Promise<Uint8Array | null>;
export interface DomReplayRecorderArgs {
    options: WebReplayOptions & {
        record: RrwebRecord;
    };
    sessionId: string;
    uploader: SegmentUploader;
    sequence: SequenceStore;
    emit: (type: string, payload: Record<string, any>) => void;
    onDiagnostic?: (message: string) => void;
    /** Injectable for tests; defaults to CompressionStream gzip. */
    compress?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
}
export declare class DomReplayRecorder implements ReplayHook {
    private readonly options;
    private readonly sessionId;
    private readonly uploader;
    private readonly sequence;
    private readonly emit;
    private readonly onDiagnostic;
    private readonly compress;
    private previous;
    private current;
    private stopRecording;
    private recording;
    private uploading;
    private forcingCheckout;
    /**
     * Set when the deployment, the plan, the credentials or the page itself
     * have said no. None of those change mid-session.
     */
    private stoppedReason;
    private counters;
    constructor(args: DomReplayRecorderArgs);
    get active(): boolean;
    start(): boolean;
    stop(): void;
    private halt;
    /** rrweb's emit callback. Must be cheap and must never throw. */
    onEvent(event: any, isCheckout?: boolean): void;
    /**
     * Keep the held events under `maxBufferBytes`.
     *
     * The previous generation goes first; it is the older history. If the
     * current one alone is over, a new checkout is forced, which turns it into
     * the previous generation and then evicts it. A page whose single snapshot
     * exceeds the budget cannot be recorded inside it at all, and recording
     * stops rather than churning snapshots on every event.
     */
    private enforceBudget;
    /** Chunk, encode and (where possible) compress a run of events. */
    private pack;
    /**
     * Upload the window that led to an error.
     *
     * Returns the object key, or null if nothing was sent. Never throws: it is
     * called from the error path.
     */
    flushForError(errorEventId?: string): Promise<string | null>;
    diagnostics(): Record<string, unknown>;
}
export {};
