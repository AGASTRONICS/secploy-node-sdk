"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventProcessor = void 0;
const transport_1 = require("./transport");
const axios_1 = __importDefault(require("axios"));
/** How long the loop waits between passes when there is nothing to do. */
const TICK_MS = 1000;
/**
 * Drains the event queue and delivers batches to the ingest.
 *
 * The governing constraint is that this runs inside somebody else's
 * application. An agent that grows without bound, blocks the host, or retries
 * forever is worse than one that loses events, so every failure path here ends
 * in bounded memory and a counted loss rather than an unbounded wait.
 */
class EventProcessor {
    constructor(queue, ingestUrl, headersCallback, batchSize = 100, flushInterval = 60, maxRetry = 5) {
        /**
         * Guards against overlapping passes. The loop is driven by a timer but its
         * body is async, so without this a slow delivery would let the next tick
         * enter while the previous one was still awaiting - two drains interleaving
         * into one shared batch, duplicating some events and losing others.
         */
        this.draining = false;
        /**
         * The in-flight drain, so stop() can wait for it.
         *
         * Without this, stop() would resolve while a pass was still awaiting a POST,
         * and the processor went on sending after the application believed it had
         * shut down.
         */
        this.drainPromise = null;
        /** Events lost after delivery was given up on or permanently rejected. */
        this.droppedEvents = 0;
        this.queue = queue;
        this.ingestUrl = ingestUrl.replace(/\/$/, "");
        this.getHeaders = headersCallback;
        this.batchSize = batchSize;
        this.flushInterval = flushInterval * 1000;
        this.maxRetry = maxRetry;
        this.isRunning = false;
        this.processorInterval = null;
        this.eventBatch = {
            events: [],
            size: 0,
            lastFlush: Date.now(),
        };
    }
    /** Events lost to failed delivery, as opposed to queue overflow. */
    droppedCount() {
        return this.droppedEvents;
    }
    /**
     * One delivery attempt.
     *
     * Never throws: a transport failure is an outcome, not an exception, and an
     * escape here would leave the timer loop wedged.
     */
    async post(events) {
        try {
            const response = await axios_1.default.post(this.ingestUrl, { events }, {
                headers: this.getHeaders(),
                timeout: 5000,
                // Judge the status ourselves rather than letting axios throw on it,
                // so a 400 and a 503 can be told apart without unwrapping an error.
                validateStatus: () => true,
            });
            const outcome = (0, transport_1.classifyStatus)(response.status);
            if (outcome === "drop") {
                // Log the body: a 4xx is a complaint about our payload, and the detail
                // is the only way anyone will work out which event caused it.
                console.error(`[secploy] Ingest rejected a batch of ${events.length} events ` +
                    `(${response.status}): ${String(JSON.stringify(response.data)).slice(0, 500)}`);
            }
            return {
                outcome,
                retryAfterMs: (0, transport_1.parseRetryAfter)(response.headers?.["retry-after"]),
            };
        }
        catch {
            // No response at all: connection refused, DNS failure, timeout. The error
            // is deliberately not inspected — every one of these is retryable, and
            // branching on the message would couple us to the HTTP client's wording.
            return { outcome: "retry", retryAfterMs: null };
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Deliver a batch, retrying transient failures with jittered backoff.
     *
     * Resolves true when the batch should be cleared - which includes the case
     * where it was permanently rejected. The caller must not keep a batch the
     * server has refused on its content; that is what turned a single malformed
     * event into a permanently stuck pipeline.
     */
    async sendBatch(events, maxAttempts) {
        if (events.length === 0)
            return true;
        const attempts = maxAttempts ?? this.maxRetry;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const { outcome, retryAfterMs } = await this.post(events);
            if (outcome === "delivered") {
                return true;
            }
            if (outcome === "drop") {
                this.droppedEvents += events.length;
                console.warn(`[secploy] Discarded ${events.length} events the ingest rejected ` +
                    `(total discarded: ${this.droppedEvents})`);
                return true;
            }
            if (attempt === attempts - 1)
                break;
            if (!this.isRunning && maxAttempts === undefined) {
                // Shutting down mid-retry. Abandoning the wait is right - stop() must
                // not block on a backoff schedule - but the loss is still a loss.
                this.droppedEvents += events.length;
                return false;
            }
            await this.sleep((0, transport_1.backoffDelay)(attempt, retryAfterMs));
        }
        this.droppedEvents += events.length;
        console.warn(`[secploy] Giving up on ${events.length} events after ${attempts} attempts ` +
            `(total discarded: ${this.droppedEvents})`);
        return true;
    }
    shouldFlush(now) {
        if (this.eventBatch.size >= this.batchSize)
            return true;
        return this.eventBatch.size > 0 && now - this.eventBatch.lastFlush >= this.flushInterval;
    }
    /**
     * Move everything currently queued into the batch, flushing whenever the
     * batch is full, then flush once more if the batch has been waiting.
     *
     * The trailing check is the fix for a real bug: the flush condition used to
     * be evaluated only inside the drain loop, which does not run when the queue
     * is empty. On a quiet application a single event would sit in the buffer
     * unsent until the next one happened to arrive - which on a service that
     * errors once an hour meant an hour of silence per error.
     */
    async processEvents() {
        if (this.draining)
            return;
        this.draining = true;
        try {
            // isRunning is re-checked every pass, not just on entry. A drain that
            // began before stop() would otherwise keep posting after the application
            // believed the processor had shut down; stop() finishes what is left.
            while (this.isRunning && this.queue.size() > 0) {
                const event = this.queue.dequeue();
                if (event) {
                    this.eventBatch.events.push(event);
                    this.eventBatch.size++;
                }
                if (this.shouldFlush(Date.now())) {
                    await this.flush();
                }
            }
            if (this.isRunning && this.shouldFlush(Date.now())) {
                await this.flush();
            }
        }
        catch (error) {
            console.error("[secploy] Error processing events:", error);
        }
        finally {
            this.draining = false;
        }
    }
    /**
     * Release the current batch and deliver it.
     *
     * The buffer is reset *before* the send. Whatever happens to this batch, it
     * is no longer the buffer's problem, and events arriving during a slow send
     * accumulate in the new one rather than being resent with it.
     */
    async flush(maxAttempts) {
        const events = this.eventBatch.events;
        this.eventBatch = { events: [], size: 0, lastFlush: Date.now() };
        await this.sendBatch(events, maxAttempts);
    }
    /**
     * Deliver everything queued right now, without stopping.
     *
     * Used by the crash path, where the process is about to die and the report
     * has to leave first, and by serverless handlers that freeze between
     * invocations.
     */
    async flushNow() {
        if (this.drainPromise) {
            await this.drainPromise.catch(() => undefined);
        }
        let event = this.queue.dequeue();
        while (event) {
            this.eventBatch.events.push(event);
            this.eventBatch.size++;
            event = this.queue.dequeue();
        }
        if (this.eventBatch.size > 0) {
            // A single attempt: a caller flushing before a crash is racing the
            // process's own death, and a retry schedule would outlive it anyway.
            await this.flush(1);
        }
    }
    start() {
        if (this.isRunning) {
            return;
        }
        this.isRunning = true;
        this.processorInterval = setInterval(() => {
            this.drainPromise = this.processEvents();
        }, TICK_MS);
        // Do not hold the process open on our account. A short-lived script should
        // be able to exit without waiting for our timer; stop() still flushes.
        this.processorInterval.unref?.();
    }
    async stop() {
        if (!this.isRunning) {
            return;
        }
        this.isRunning = false;
        if (this.processorInterval) {
            clearInterval(this.processorInterval);
            this.processorInterval = null;
        }
        // Let any pass that is already under way finish before taking over the
        // buffer, so the same events are not sent from two places at once.
        if (this.drainPromise) {
            await this.drainPromise;
            this.drainPromise = null;
        }
        // Drain the queue as well as the batch. Events still queued at shutdown
        // were previously discarded in silence - exactly the events a process
        // shutting down most needs to report.
        //
        // Bounded by batchSize: a backlog of thousands would turn stop() into a
        // multi-megabyte upload while the application is trying to exit. What does
        // not fit is reported rather than dropped quietly.
        while (this.eventBatch.size < this.batchSize && this.queue.size() > 0) {
            const event = this.queue.dequeue();
            if (!event)
                break;
            this.eventBatch.events.push(event);
            this.eventBatch.size++;
        }
        const abandoned = this.queue.size();
        if (abandoned > 0) {
            this.droppedEvents += abandoned;
            console.warn(`[secploy] ${abandoned} events were still queued at shutdown and were not sent`);
        }
        if (this.eventBatch.size > 0) {
            // One attempt, no backoff. Shutdown is not the moment to spend half a
            // minute sleeping between retries; an application waiting on stop() would
            // rather lose the batch than hang.
            await this.flush(1);
        }
    }
}
exports.EventProcessor = EventProcessor;
