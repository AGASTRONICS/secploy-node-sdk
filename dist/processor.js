"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventProcessor = void 0;
const axios_1 = __importDefault(require("axios"));
class EventProcessor {
    constructor(queue, ingestUrl, headersCallback, batchSize = 100, flushInterval = 60, maxRetry = 5) {
        this.queue = queue;
        this.ingestUrl = ingestUrl.replace(/\/$/, "");
        this.getHeaders = headersCallback;
        this.batchSize = batchSize;
        this.flushInterval = flushInterval * 1000; // Convert to milliseconds
        this.maxRetry = maxRetry;
        this.isRunning = false;
        this.processorInterval = null;
        this.eventBatch = {
            events: [],
            size: 0,
            lastFlush: Date.now(),
        };
    }
    async sendBatch(events) {
        for (let attempt = 0; attempt < this.maxRetry; attempt++) {
            try {
                const response = await axios_1.default.post(this.ingestUrl, { events }, {
                    headers: this.getHeaders(),
                    timeout: 5000,
                });
                if (response.status === 200) {
                    console.debug(`Batch of ${events.length} events sent successfully`);
                    return true;
                }
            }
            catch (error) {
                console.error("Send batch failed:", error);
            }
            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
    }
    async processEvents() {
        while (this.queue.size() > 0) {
            const event = this.queue.dequeue();
            if (event) {
                this.eventBatch.events.push(event);
                this.eventBatch.size++;
            }
            const shouldFlush = this.eventBatch.size >= this.batchSize ||
                (this.eventBatch.size > 0 &&
                    Date.now() - this.eventBatch.lastFlush >= this.flushInterval);
            if (shouldFlush) {
                if (await this.sendBatch(this.eventBatch.events)) {
                    this.eventBatch = {
                        events: [],
                        size: 0,
                        lastFlush: Date.now(),
                    };
                }
                else {
                    // If send fails, wait before retrying
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
    }
    start() {
        if (this.isRunning) {
            return;
        }
        console.info("Starting event processor...");
        this.isRunning = true;
        this.processorInterval = setInterval(() => this.processEvents(), 1000 // Check queue every second
        );
    }
    async stop() {
        if (!this.isRunning) {
            return;
        }
        console.info("Stopping event processor...");
        this.isRunning = false;
        if (this.processorInterval) {
            clearInterval(this.processorInterval);
            this.processorInterval = null;
        }
        // Flush any remaining events
        if (this.eventBatch.events.length > 0) {
            await this.sendBatch(this.eventBatch.events);
        }
    }
}
exports.EventProcessor = EventProcessor;
