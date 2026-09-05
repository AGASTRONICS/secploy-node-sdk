import { randomUUID } from "crypto";
import { EventData } from "./types";
import { Scrubber } from "./scrubbing";
import { shouldSend } from "./sampling";

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
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

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
export class EventQueue {
  private buffer: (EventData | undefined)[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  /** Events discarded because the queue was full. */
  private dropped = 0;

  constructor(maxSize: number = DEFAULT_MAX_QUEUE_SIZE) {
    this.capacity = Math.max(1, Math.floor(maxSize));
    this.buffer = new Array(this.capacity);
  }

  enqueue(event: EventData): void {
    if (this.count === this.capacity) {
      // Overwrite the oldest and advance past it.
      this.head = (this.head + 1) % this.capacity;
      this.count--;
      this.dropped++;
      if (this.dropped % 1000 === 1) {
        console.warn(
          `[secploy] Event queue is full; discarded ${this.dropped} oldest events so far`,
        );
      }
    }

    this.buffer[(this.head + this.count) % this.capacity] = event;
    this.count++;
  }

  dequeue(): EventData | undefined {
    if (this.count === 0) return undefined;

    const event = this.buffer[this.head];
    // Release the reference so a drained queue does not pin whole payloads.
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return event;
  }

  peek(): EventData | undefined {
    return this.count === 0 ? undefined : this.buffer[this.head];
  }

  size(): number {
    return this.count;
  }

  /** Events lost to overflow. Surfaced so a silent loss is a countable one. */
  droppedCount(): number {
    return this.dropped;
  }

  maxSize(): number {
    return this.capacity;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}

/** Run on every event before it is queued. Return null to drop it. */
export type BeforeSend = (
  payload: Record<string, any>,
) => Record<string, any> | null | undefined;

/**
 * The single door every event goes through on its way out.
 *
 * Scrubbing and the before_send hook live here rather than at each place that
 * builds a payload, because that is the only arrangement that stays correct:
 * redacting per call site guarantees the next payload someone adds is the one
 * that leaks.
 */
export class EventHandler {
  private queue: EventQueue;
  private scrubber: Scrubber;
  private beforeSend?: BeforeSend;
  private samplingRate: number;

  /** Events the application's own hook chose not to send. */
  private filtered = 0;

  /**
   * Events thinned by sampling. Counted separately from the above: they mean
   * different things, and a rate that turns out to be dropping more than
   * expected should be visible rather than inferred.
   */
  private sampled = 0;

  constructor(
    queue: EventQueue,
    scrubber?: Scrubber,
    beforeSend?: BeforeSend,
    samplingRate = 1.0,
  ) {
    this.queue = queue;
    this.scrubber = scrubber ?? new Scrubber();
    this.beforeSend = beforeSend;
    this.samplingRate = samplingRate;
  }

  filteredCount(): number {
    return this.filtered;
  }

  sampledCount(): number {
    return this.sampled;
  }

  sendEvent(eventType: string, payload: Record<string, any>): boolean {
    try {
      // Sampling first, so the work below - the hook, the scrub, the
      // serialisation - is not spent on an event that is about to be
      // discarded. Errors and security signals are never sampled; see
      // sampling.ts for why that distinction exists.
      if (!shouldSend(eventType, payload, this.samplingRate)) {
        this.sampled++;
        return false;
      }

      let prepared: Record<string, any> | null = payload;

      // The application's hook runs first, on the real values, so it can decide
      // from them - drop this event, annotate it, redact something only this
      // codebase knows is sensitive.
      if (this.beforeSend) {
        prepared = this.applyBeforeSend(payload);
        if (prepared === null) {
          this.filtered++;
          return false;
        }
      }

      // Scrubbing runs last so nothing the hook returned - including anything
      // it added - can escape unscrubbed.
      const scrubbed = this.scrubber.scrub(prepared);
      if (
        !scrubbed ||
        typeof scrubbed !== "object" ||
        Array.isArray(scrubbed)
      ) {
        // The scrubber refused the payload outright.
        return false;
      }

      const event: EventData = {
        type: eventType,
        // Generated here, at enqueue, and never again. A retry of a batch
        // carries the same ids, which is what lets the ingest recognise a
        // redelivery and not count the occurrence twice - and occurrence
        // counts are the whole point of grouping.
        payload: {
          event_id: randomUUID(),
          ...(scrubbed as Record<string, any>),
        },
        timestamp: Date.now(),
      };
      this.queue.enqueue(event);
      return true;
    } catch (error) {
      console.error("Failed to queue event:", error);
      return false;
    }
  }

  /**
   * Run the application's hook, defensively.
   *
   * A hook that throws must not stop the SDK reporting. The event is kept
   * rather than dropped: a broken filter should cost visibility into the
   * filter, not into the application.
   */
  private applyBeforeSend(
    payload: Record<string, any>,
  ): Record<string, any> | null {
    let result: ReturnType<BeforeSend>;
    try {
      result = this.beforeSend!({ ...payload });
    } catch (error) {
      console.error(
        "[secploy] beforeSend threw, keeping the event as-is:",
        error,
      );
      return payload;
    }

    if (result === null) return null;
    if (result === undefined) return payload;
    if (typeof result !== "object" || Array.isArray(result)) {
      console.error(
        "[secploy] beforeSend must return an object or null; keeping the event as-is",
      );
      return payload;
    }
    return result;
  }
}
