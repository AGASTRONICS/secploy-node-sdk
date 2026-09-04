/**
 * Batched identity reporting.
 *
 * When the gate asks the API about every request, identity travels along as
 * query parameters and is recorded as a side effect. With the policy cached
 * locally the gate makes no request at all, so identities would otherwise stop
 * being reported entirely.
 *
 * They are reported from here instead, and the deduplication matters more than
 * the batching. A busy endpoint sees the same user hundreds of times a minute;
 * sending each sighting would only move the write storm from the request path
 * to a queue. An identity is re-sent only when something about it changes, or
 * when its last report has aged out.
 */
import { SecurityGateAuthContext } from "./types";
export interface IdentityReporterOptions {
    apiUrl: string;
    headersCallback: () => Record<string, string>;
    reportInterval?: number;
    flushInterval?: number;
    maxBatch?: number;
    maxTracked?: number;
}
export declare class IdentityReporter {
    private apiUrl;
    private getHeaders;
    private reportInterval;
    private flushInterval;
    private maxBatch;
    private maxTracked;
    private pending;
    private seen;
    private timer;
    constructor(options: IdentityReporterOptions);
    get pendingCount(): number;
    private static fingerprint;
    /**
     * Note that an identity was seen. Returns true if it was queued, false if it
     * was suppressed as a duplicate.
     *
     * Cheap by design: this runs on the request path, so it does a map lookup and
     * a string comparison and nothing else.
     */
    record(input?: SecurityGateAuthContext | Record<string, any> | null): boolean;
    /** Drop the oldest tracked identities once over capacity. */
    private trimSeen;
    /**
     * Send everything pending. Resolves with the number of identities sent.
     *
     * Never rejects: identity reporting is telemetry and must not surface in the
     * host application. On failure the batch is put back so the next flush
     * retries it.
     */
    flush(timeoutMs?: number): Promise<number>;
    private requeue;
    start(): void;
    stop(): Promise<void>;
}
