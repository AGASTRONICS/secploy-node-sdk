import { EventData } from "./types";

export class EventQueue {
  private queue: EventData[] = [];

  enqueue(event: EventData): void {
    this.queue.push(event);
  }

  dequeue(): EventData | undefined {
    return this.queue.shift();
  }

  peek(): EventData | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}

export class EventHandler {
  private queue: EventQueue;

  constructor(queue: EventQueue) {
    this.queue = queue;
  }

  /**
   * Queue an event for sending. Events are batched and sent periodically.
   */
  sendEvent(eventType: string, payload: Record<string, any>): boolean {
    try {
      const event: EventData = {
        type: eventType,
        payload,
        timestamp: Date.now(),
      };
      this.queue.enqueue(event);
      return true;
    } catch (error) {
      console.error("Failed to queue event:", error);
      return false;
    }
  }
}
