"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_RETRY_AFTER_MS = exports.MAX_BACKOFF_MS = exports.INITIAL_BACKOFF_MS = void 0;
exports.classifyStatus = classifyStatus;
exports.parseRetryAfter = parseRetryAfter;
exports.backoffDelay = backoffDelay;
/** Backoff bounds. The cap is what stops a long outage becoming a long silence. */
exports.INITIAL_BACKOFF_MS = 1000;
exports.MAX_BACKOFF_MS = 30000;
/**
 * A server asking us to wait longer than this is either broken or telling us to
 * go away for the day; either way we resume on our own schedule.
 */
exports.MAX_RETRY_AFTER_MS = 300000;
/** Status codes worth trying again even though they are 4xx. */
const RETRYABLE_CLIENT_ERRORS = new Set([
    408, // request timeout
    425, // too early
    429, // rate limited - the server usually says how long to wait
]);
/**
 * Decide what a response status means for the batch that produced it.
 *
 * `undefined` stands for "no response at all" - a connection error, a timeout,
 * a DNS failure - which is always worth retrying.
 */
function classifyStatus(statusCode) {
    if (statusCode === null || statusCode === undefined)
        return "retry";
    const code = Number(statusCode);
    // An unreadable status is not evidence of delivery.
    if (!Number.isFinite(code))
        return "retry";
    if (code >= 200 && code < 300)
        return "delivered";
    if (RETRYABLE_CLIENT_ERRORS.has(code))
        return "retry";
    // The server has judged the content. Sending it again produces the same
    // judgement, so the batch is dropped rather than retried forever.
    if (code >= 400 && code < 500)
        return "drop";
    if (code >= 500)
        return "retry";
    // 1xx and 3xx are not answers to a POST we can act on. Treat as transient
    // rather than discarding data on an ambiguity.
    return "retry";
}
/**
 * Read a `Retry-After` header, in milliseconds.
 *
 * Only the delta-seconds form is honoured. The HTTP-date form is legal but rare
 * from an API, and misreading a date as a duration is a worse failure than
 * ignoring it and using our own backoff.
 */
function parseRetryAfter(value) {
    if (value === null || value === undefined)
        return null;
    const raw = String(value).trim();
    // Number("") is 0 in JavaScript, so an empty or whitespace-only header would
    // otherwise be read as "retry immediately" - which removes the backoff
    // entirely at exactly the moment the server is asking for room.
    if (raw === "")
        return null;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0)
        return null;
    return Math.min(seconds * 1000, exports.MAX_RETRY_AFTER_MS);
}
/**
 * How long to wait before retry number `attempt` (0-based), in milliseconds.
 *
 * An explicit `Retry-After` wins, because the server knows more than we do
 * about when it will be ready. Otherwise: exponential growth with full jitter -
 * the delay is drawn uniformly from `[0, ceiling]` rather than sitting at the
 * ceiling, so a fleet of clients that failed together does not return together.
 */
function backoffDelay(attempt, retryAfterMs, random = Math.random) {
    if (retryAfterMs !== null &&
        retryAfterMs !== undefined &&
        retryAfterMs >= 0) {
        return Math.min(retryAfterMs, exports.MAX_RETRY_AFTER_MS);
    }
    const exponent = Math.max(0, Math.floor(attempt));
    // Cap the exponent before shifting so a long-lived retry loop cannot
    // overflow into an enormous number.
    const ceiling = Math.min(exports.INITIAL_BACKOFF_MS * 2 ** Math.min(exponent, 10), exports.MAX_BACKOFF_MS);
    return random() * ceiling;
}
