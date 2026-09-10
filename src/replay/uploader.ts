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
  | "notConfigured"
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
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    signal?: any;
    credentials?: string;
    keepalive?: boolean;
  },
) => Promise<{
  status: number;
  json(): Promise<any>;
  headers?: { get(name: string): string | null } | any;
}>;

const failed = (
  failure: UploadFailure,
  permanent = false,
): UploadOutcome => ({ objectKey: null, failure, permanent });

/**
 * Run `fetch` with a deadline.
 *
 * AbortController where there is one, so a timed-out request is actually torn
 * down rather than left holding a socket; a plain race where there is not.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number,
): ReturnType<FetchLike> {
  const Controller = (globalThis as any).AbortController;
  const controller = Controller ? new Controller() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller?.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SegmentUploaderOptions {
  apiUrl: string;
  headers: () => Record<string, string>;
  fetchImpl: FetchLike;
  /** Per request. A handset on a train needs longer than a desktop. */
  timeoutMs?: number;
}

export class SegmentUploader {
  private readonly apiUrl: string;
  private readonly headers: () => Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: SegmentUploaderOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.headers = options.headers;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Ask for a URL, then PUT to it. Never throws. */
  async upload(args: {
    header: SegmentHeader;
    bytes: Uint8Array;
    durationMs: number;
  }): Promise<UploadOutcome> {
    const { header, bytes, durationMs } = args;

    let minted: Awaited<ReturnType<FetchLike>>;
    try {
      minted = await fetchWithTimeout(
        this.fetchImpl,
        `${this.apiUrl}/projects/replay/upload-url/`,
        {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          // The key is publishable and travels in a header. No cookie belongs
          // on a request to our API from a customer's page.
          credentials: "omit",
          body: JSON.stringify({
            session_id: header.session_id,
            seq: header.seq,
            // Exactly what will be PUT. The server signs this length into the
            // URL, so a mismatch fails at the storage provider with a
            // signature error rather than storing a truncated segment.
            byte_size: bytes.length,
            duration_ms: durationMs,
            frame_count: header.frame_count,
            width: header.width,
            height: header.height,
          }),
        },
        this.timeoutMs,
      );
    } catch {
      return failed("transient");
    }

    switch (minted.status) {
      case 200:
      case 201:
        break;
      case 503:
        return failed("notConfigured", true);
      case 402:
        return failed("quotaExceeded", true);
      case 401:
      case 403:
        return failed("unauthorized", true);
      case 400:
        return failed("rejected", true);
      default:
        return failed("transient");
    }

    let body: Record<string, unknown>;
    try {
      body = (await minted.json()) as Record<string, unknown>;
    } catch {
      return failed("transient");
    }

    const uploadUrl = typeof body?.upload_url === "string" ? body.upload_url : null;
    const objectKey = typeof body?.object_key === "string" ? body.object_key : null;
    const contentType =
      typeof body?.content_type === "string"
        ? body.content_type
        : "application/octet-stream";
    if (!uploadUrl || !objectKey) return failed("transient");

    try {
      const put = await fetchWithTimeout(
        this.fetchImpl,
        uploadUrl,
        {
          method: "PUT",
          // Content-Length is set from the body, and is part of what the URL
          // was signed for. Content-Type must match too.
          headers: { "Content-Type": contentType },
          credentials: "omit",
          body: bytes,
        },
        this.timeoutMs,
      );

      if (put.status >= 200 && put.status < 300) {
        return { objectKey, failure: null, permanent: false };
      }
      // A 403 here is usually the signature refusing a length or type that
      // does not match what was minted - our bug, not the network's. Retrying
      // the same bytes against the same URL cannot fix it.
      if (put.status === 403) return failed("rejected", true);
      return failed("transient");
    } catch {
      // In a browser this is also what a missing CORS rule on the bucket looks
      // like: the PUT is refused before any status is visible to script.
      return failed("transient");
    }
  }
}

/**
 * The index event, sent through the ordinary pipeline once the bytes are up.
 *
 * `replay.segment` is in the always-sent list on every SDK and on the ingest.
 * It must never be sampled away: the object is already stored by the time this
 * is sent, so dropping the index does not save anything - it strands bytes
 * nobody can find.
 */
export function replaySegmentEvent(args: {
  header: SegmentHeader;
  objectKey: string;
  byteSize: number;
  durationMs: number;
  errorEventId?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, any> {
  const { header, objectKey, byteSize, durationMs, errorEventId, extra } = args;
  return {
    message: `replay segment ${header.seq} for ${header.session_id}`,
    type: "replay.segment",
    context: {
      session_id: header.session_id,
      seq: header.seq,
      object_key: objectKey,
      started_at: header.started_at,
      frame_count: header.frame_count,
      frame_interval_ms: header.frame_interval_ms,
      duration_ms: durationMs,
      width: header.width,
      height: header.height,
      codec: header.codec,
      byte_size: byteSize,
      ...(errorEventId ? { error_event_id: errorEventId } : {}),
      ...extra,
    },
  };
}
