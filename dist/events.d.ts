import { EventData } from "./types";
import { Scrubber } from "./scrubbing";
/**
 * How many unsent events may be held before the oldest start being discarded.
 *
 * The queue used to be unbounded. If the ingest was unreachable - an outage, a
 * firewall rule, a typo in the URL - it grew for as long as the process kept
 * running, inside the host application's own heap. An agent that reports on a
 * service must not be the reason that service dies, so the buffer is finite and
 * overflow is a counted loss rather than a slow leak.
 *
 * Matches DEFAULT_MAX_QUEUE_SIZE in the Python SDK.
 */
export declare const DEFAULT_MAX_QUEUE_SIZE = 10000;
/**
 * A bounded FIFO of pending events.
 *
 * Backed by a ring buffer rather than an array with `shift()`. `shift()` is
 * O(n) - it reindexes every remaining element - so draining a large backlog was
 * quadratic, and the backlog is exactly when the SDK can least afford to be
 * expensive. Here every operation is constant time.
 *
 * When full, the oldest events go first. The newest are the ones that matter:
 * if the ingest is unreachable, keeping a stale window and refusing everything
 * since would leave the SDK blind to what is happening now, which for a
 * security agent is the wrong half of the data to keep.
 */
export declare class EventQueue {
    private buffer;
    private head;
    private count;
    private readonly capacity;
    /** Events discarded because the queue was full. */
    private dropped;
    constructor(maxSize?: number);
    enqueue(event: EventData): void;
    dequeue(): EventData | undefined;
    peek(): EventData | undefined;
    size(): number;
    /** Events lost to overflow. Surfaced so a silent loss is a countable one. */
    droppedCount(): number;
    maxSize(): number;
    clear(): void;
}
/** Run on every event before it is queued. Return null to drop it. */
export type BeforeSend = (payload: Record<string, any>) => Record<string, any> | null | undefined;
/**
 * The single door every event goes through on its way out.
 *
 * Scrubbing and the before_send hook live here rather than at each place that
 * builds a payload, because that is the only arrangement that stays correct:
 * redacting per call site guarantees the next payload someone adds is the one
 * that leaks.
 */
export declare class EventHandler {
    private queue;
    private scrubber;
    private beforeSend?;
    private samplingRate;
    /** Events the application's own hook chose not to send. */
    private filtered;
    /**
     * Events thinned by sampling. Counted separately from the above: they mean
     * different things, and a rate that turns out to be dropping more than
     * expected should be visible rather than inferred.
     */
    private sampled;
    constructor(queue: EventQueue, scrubber?: Scrubber, beforeSend?: BeforeSend, samplingRate?: number);
    filteredCount(): number;
    sampledCount(): number;
    sendEvent(eventType: string, payload: Record<string, any>): boolean;
    /**
     * Run the application's hook, defensively.
     *
     * A hook that throws must not stop the SDK reporting. The event is kept
     * rather than dropped: a broken filter should cost visibility into the
     * filter, not into the application.
     */
    private applyBeforeSend;
}
