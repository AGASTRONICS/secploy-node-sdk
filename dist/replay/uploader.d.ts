/**
 * Getting a segment off the device.
 *
 * Mirrors `uploader.dart`. Three steps, in this order, and the order is the
 * point:
 *
 *   1. ask the control plane for a presigned PUT
 *   2. PUT the bytes straight to object storage
 *   3. send a small `replay.segment` event through the ordinary event pipeline
 *
 * **Object first, index second.** If the index event is lost, an orphaned
 * object sits in the bucket until the server's sweep collects it - wasteful,
 * but invisible. The other order leaves the dashboard holding an index row
 * pointing at bytes that never arrived, which is a broken play button on a real
 * issue. Cheap and invisible beats visible and broken.
 *
 * Uses `fetch`, which both browsers and React Native provide, rather than
 * axios: axios in a browser bundle is dead weight for two requests, and its
 * React Native adapter handles binary bodies worse than `fetch` does.
 */
import { SegmentHeader } from "./segment";
/** Why an upload did not happen. */
export type UploadFailure = 
/** The deployment has replay switched off. Permanent for this session. */
"notConfigured"
/** The plan's monthly allowance is spent. Also permanent for this session. */
 | "quotaExceeded"
/**
 * Credentials rejected. Permanent, and worth surfacing: it usually means a
 * key was rotated and the app was not rebuilt.
 */
 | "unauthorized"
/** Refused on its content - too large, malformed session id. */
 | "rejected"
/** Network, timeout, or a 5xx. Worth trying again. */
 | "transient";
export interface UploadOutcome {
    objectKey: string | null;
    failure: UploadFailure | null;
    /** Whether retrying this session could ever succeed. */
    permanent: boolean;
}
/** The slice of `fetch` this module uses, so tests can supply their own. */
export type FetchLike = (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    signal?: any;
    credentials?: string;
    keepalive?: boolean;
}) => Promise<{
    status: number;
    json(): Promise<any>;
    headers?: {
        get(name: string): string | null;
    } | any;
}>;
/**
 * Run `fetch` with a deadline.
 *
 * AbortController where there is one, so a timed-out request is actually torn
 * down rather than left holding a socket; a plain race where there is not.
 */
export declare function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: Parameters<FetchLike>[1], timeoutMs: number): ReturnType<FetchLike>;
export interface SegmentUploaderOptions {
    apiUrl: string;
    headers: () => Record<string, string>;
    fetchImpl: FetchLike;
    /** Per request. A handset on a train needs longer than a desktop. */
    timeoutMs?: number;
}
export declare class SegmentUploader {
    private readonly apiUrl;
    private readonly headers;
    private readonly fetchImpl;
    private readonly timeoutMs;
    constructor(options: SegmentUploaderOptions);
    /** Ask for a URL, then PUT to it. Never throws. */
    upload(args: {
        header: SegmentHeader;
        bytes: Uint8Array;
        durationMs: number;
    }): Promise<UploadOutcome>;
}
/**
 * The index event, sent through the ordinary pipeline once the bytes are up.
 *
 * `replay.segment` is in the always-sent list on every SDK and on the ingest.
 * It must never be sampled away: the object is already stored by the time this
 * is sent, so dropping the index does not save anything - it strands bytes
 * nobody can find.
 */
export declare function replaySegmentEvent(args: {
    header: SegmentHeader;
    objectKey: string;
    byteSize: number;
    durationMs: number;
    errorEventId?: string | null;
    extra?: Record<string, unknown>;
}): Record<string, any>;
