/**
 * Delivery policy for the event transport.
 *
 * This mirrors `secploy/transport.py` in the Python SDK deliberately: the two
 * clients talk to the same ingest, and a difference in how they read a response
 * is a difference nobody notices until one of them is retrying something the
 * other dropped. Keep them in step.
 *
 * Three rules, each of which was a real failure before it was written down.
 *
 * **Any 2xx means delivered.** The previous transport accepted only `200`. The
 * ingest answers `202 {"status": "sampled"}` when a project's server-side
 * sampling rate drops a batch - so every sampled batch was read as a failure
 * and resent five times. Server-side sampling, whose entire purpose is to
 * reduce load, multiplied it instead.
 *
 * **A 4xx is permanent, so the batch is dropped.** The previous transport
 * cleared its buffer only on success. One malformed event that earns a `400`
 * therefore stayed in the buffer forever, was retried against every subsequent
 * flush, and took the rest of the queue down with it while memory grew without
 * bound.
 *
 * **Everything else backs off.** Network errors, 5xx, 429 and 408 are worth
 * retrying, but not immediately and not in lockstep. A fixed one-second sleep
 * means every client in a fleet retries in the same rhythm, so an ingest
 * recovering from an outage is hit by the whole fleet at once, in phase.
 */
export type DeliveryOutcome = "delivered" | "retry" | "drop";
/** Backoff bounds. The cap is what stops a long outage becoming a long silence. */
export declare const INITIAL_BACKOFF_MS = 1000;
export declare const MAX_BACKOFF_MS = 30000;
/**
 * A server asking us to wait longer than this is either broken or telling us to
 * go away for the day; either way we resume on our own schedule.
 */
export declare const MAX_RETRY_AFTER_MS = 300000;
/**
 * Decide what a response status means for the batch that produced it.
 *
 * `undefined` stands for "no response at all" - a connection error, a timeout,
 * a DNS failure - which is always worth retrying.
 */
export declare function classifyStatus(statusCode?: number | null): DeliveryOutcome;
/**
 * Read a `Retry-After` header, in milliseconds.
 *
 * Only the delta-seconds form is honoured. The HTTP-date form is legal but rare
 * from an API, and misreading a date as a duration is a worse failure than
 * ignoring it and using our own backoff.
 */
export declare function parseRetryAfter(value: unknown): number | null;
/**
 * How long to wait before retry number `attempt` (0-based), in milliseconds.
 *
 * An explicit `Retry-After` wins, because the server knows more than we do
 * about when it will be ready. Otherwise: exponential growth with full jitter -
 * the delay is drawn uniformly from `[0, ceiling]` rather than sitting at the
 * ceiling, so a fleet of clients that failed together does not return together.
 */
export declare function backoffDelay(attempt: number, retryAfterMs?: number | null, random?: () => number): number;
