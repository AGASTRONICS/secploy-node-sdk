import { EventQueue } from "./events";
/**
 * Drains the event queue and delivers batches to the ingest.
 *
 * The governing constraint is that this runs inside somebody else's
 * application. An agent that grows without bound, blocks the host, or retries
 * forever is worse than one that loses events, so every failure path here ends
 * in bounded memory and a counted loss rather than an unbounded wait.
 */
export declare class EventProcessor {
    private queue;
    private ingestUrl;
    private getHeaders;
    private batchSize;
    private flushInterval;
    private maxRetry;
    private eventBatch;
    private isRunning;
    private processorInterval;
    /**
     * Guards against overlapping passes. The loop is driven by a timer but its
     * body is async, so without this a slow delivery would let the next tick
     * enter while the previous one was still awaiting - two drains interleaving
     * into one shared batch, duplicating some events and losing others.
     */
    private draining;
    /**
     * The in-flight drain, so stop() can wait for it.
     *
     * Without this, stop() would resolve while a pass was still awaiting a POST,
     * and the processor went on sending after the application believed it had
     * shut down.
     */
    private drainPromise;
    /** Events lost after delivery was given up on or permanently rejected. */
    private droppedEvents;
    constructor(queue: EventQueue, ingestUrl: string, headersCallback: () => Record<string, string>, batchSize?: number, flushInterval?: number, maxRetry?: number);
    /** Events lost to failed delivery, as opposed to queue overflow. */
    droppedCount(): number;
    /**
     * One delivery attempt.
     *
     * Never throws: a transport failure is an outcome, not an exception, and an
     * escape here would leave the timer loop wedged.
     */
    private post;
    private sleep;
    /**
     * Deliver a batch, retrying transient failures with jittered backoff.
     *
     * Resolves true when the batch should be cleared - which includes the case
     * where it was permanently rejected. The caller must not keep a batch the
     * server has refused on its content; that is what turned a single malformed
     * event into a permanently stuck pipeline.
     */
    private sendBatch;
    private shouldFlush;
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
    private processEvents;
    /**
     * Release the current batch and deliver it.
     *
     * The buffer is reset *before* the send. Whatever happens to this batch, it
     * is no longer the buffer's problem, and events arriving during a slow send
     * accumulate in the new one rather than being resent with it.
     */
    private flush;
    /**
     * Deliver everything queued right now, without stopping.
     *
     * Used by the crash path, where the process is about to die and the report
     * has to leave first, and by serverless handlers that freeze between
     * invocations.
     */
    flushNow(): Promise<void>;
    start(): void;
    stop(): Promise<void>;
}
