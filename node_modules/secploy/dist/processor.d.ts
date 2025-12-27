import { EventQueue } from "./events";
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
    constructor(queue: EventQueue, ingestUrl: string, headersCallback: () => Record<string, string>, batchSize?: number, flushInterval?: number, maxRetry?: number);
    private sendBatch;
    private processEvents;
    start(): void;
    stop(): Promise<void>;
}
