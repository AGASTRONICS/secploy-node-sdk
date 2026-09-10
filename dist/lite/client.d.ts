/**
 * The client core shared by the browser and React Native builds.
 *
 * The Node client (`index.ts`) is built for a server: axios, `process`
 * handlers, a sixty-second flush, a request gate, a WebSocket policy channel.
 * None of that belongs in a page or on a handset, and most of it would not
 * even bundle there. This is the part both front-end runtimes actually need -
 * an event queue, error reports in the shape every SDK sends, and a place for
 * session replay to hang - built on `fetch` and nothing else.
 *
 * What it deliberately shares with the Node client, by importing rather than
 * copying: the delivery policy (`transport.ts`), the scrubber
 * (`portable/scrub.ts`) and the stack parser (`portable/stack.ts`). Those are
 * the rules the ingest relies on every client following identically.
 */
import { ParsedError, ParseStackOptions } from "../portable/stack";
import { FetchLike } from "../replay/uploader";
export interface LiteConfig {
    apiKey: string;
    environmentKey: string;
    organizationId: string;
    /** Where events are POSTed, e.g. https://ingest.secploy.com/ingest */
    ingestUrl: string;
    /** Base API URL, for replay upload URLs. Defaults to https://api.secploy.com */
    apiUrl?: string;
    environment?: string;
    /** Build identifier attached to every error. */
    release?: string;
    /** Install the platform's global error handlers. On by default. */
    captureUncaught?: boolean;
    /** Redact credentials from every event. On by default. */
    scrubEnabled?: boolean;
    /** Extra key names to redact, on top of the built-in denylist. */
    scrubFields?: string[];
    /** Runs on every event before it is queued. Return null to drop it. */
    beforeSend?: (payload: Record<string, any>) => Record<string, any> | null | undefined;
    batchSize?: number;
    /** Seconds between flushes. */
    flushInterval?: number;
    /** Unsent events held before the oldest are discarded. */
    maxQueueSize?: number;
    maxRetry?: number;
    /** Log what the SDK itself is doing. */
    debug?: boolean;
}
/**
 * Defaults tuned for a front end rather than a server.
 *
 * Five seconds, not sixty: a tab is closed or an app is swiped away long before
 * a minute passes, and an error that sits in memory until then is never sent.
 * A smaller queue, because this heap is somebody's phone.
 */
export declare const LITE_DEFAULTS: {
    apiUrl: string;
    environment: string;
    captureUncaught: boolean;
    scrubEnabled: boolean;
    batchSize: number;
    flushInterval: number;
    maxQueueSize: number;
    maxRetry: number;
    debug: boolean;
};
type ResolvedConfig = LiteConfig & typeof LITE_DEFAULTS;
/** What a replay recorder offers the client. */
export interface ReplayHook {
    /**
     * Recording, and able to upload. False once the deployment, the plan or the
     * credentials have refused - an error then must not claim a replay.
     */
    readonly active: boolean;
    /** Upload the window that led to an error. Never throws. */
    flushForError(errorEventId?: string): Promise<string | null>;
    stop(): void;
    diagnostics(): Record<string, unknown>;
}
export interface LitePlatform {
    /** Reported as `context.sdk`. */
    sdkName: string;
    /** Fields only this platform knows, merged into every error's context. */
    platformContext?: () => Record<string, unknown>;
    /** Supply a session id, e.g. one persisted across page loads. */
    sessionId?: string;
    fetchImpl?: FetchLike;
    /** Parse `fn@file:line:col` frames too. Browsers other than Chrome need it. */
    stackOptions?: ParseStackOptions;
}
export declare class LiteClient {
    protected readonly config: ResolvedConfig;
    /** Already in the hashed shape. Joins errors to their replay. */
    readonly sessionId: string;
    protected replay: ReplayHook | null;
    protected readonly fetchImpl: FetchLike;
    private readonly sdkName;
    private readonly platformContext;
    private readonly stackOptions;
    private readonly scrubber;
    private queue;
    private timer;
    private draining;
    protected closed: boolean;
    private droppedEvents;
    private filteredEvents;
    constructor(config: Partial<LiteConfig>, platform: LitePlatform);
    protected diagnostic(message: string): void;
    protected getHeaders(): Record<string, string>;
    protected get apiUrl(): string;
    start(): void;
    /**
     * Queue one event. Never throws.
     *
     * The same door as `EventHandler.sendEvent` in the Node client: the
     * application's hook first, on the real values, then the scrubber, so
     * nothing the hook returns can leave unscrubbed.
     */
    sendEvent(type: string, payload: Record<string, any>): boolean;
    /**
     * Report an error. Returns the event id, which is also what the replay
     * uploaded for it is indexed under.
     */
    captureException(thrown: unknown, context?: Record<string, unknown>): string | null;
    /** Report a message with no exception behind it. */
    captureMessage(message: string, level?: "fatal" | "error" | "warning" | "info", context?: Record<string, unknown>): string | null;
    /**
     * Build and queue an error report, and ask replay for the window behind it.
     *
     * The same payload `buildErrorPayload` produces in the Dart SDK, so a web
     * error, a React Native error and a Flutter error group and render alike.
     */
    protected report(parsed: ParsedError, options: {
        level: string;
        mechanism: string;
        handled: boolean;
        extra?: Record<string, unknown>;
    }): string | null;
    /**
     * Send whatever is queued now, once each, without waiting on a retry
     * schedule already in progress.
     *
     * `keepalive` lets the request outlive the page. Browsers cap a keepalive
     * body at 64 KiB, so larger batches go without it and may be cut off - the
     * cost of a tab closing mid-send, not a reason to hold the page open.
     */
    flush(options?: {
        keepalive?: boolean;
    }): Promise<void>;
    /** Stop, flush what is left, and release the replay recorder. */
    close(): Promise<void>;
    diagnostics(): Record<string, unknown>;
    private drain;
    /** Deliver one batch under the shared transport rules. Never throws. */
    private sendBatch;
    private post;
}
export {};
