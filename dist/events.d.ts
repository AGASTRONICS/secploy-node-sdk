import { EventData } from "./types";
export declare class EventQueue {
    private queue;
    enqueue(event: EventData): void;
    dequeue(): EventData | undefined;
    peek(): EventData | undefined;
    size(): number;
    clear(): void;
}
export declare class EventHandler {
    private queue;
    constructor(queue: EventQueue);
    /**
     * Queue an event for sending. Events are batched and sent periodically.
     */
    sendEvent(eventType: string, payload: Record<string, any>): boolean;
}
