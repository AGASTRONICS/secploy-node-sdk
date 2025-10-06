"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecployClient = void 0;
const types_1 = require("./types");
const events_1 = require("./events");
const processor_1 = require("./processor");
const DEFAULT_CONFIG = {
    environment: "development",
    samplingRate: 1.0,
    heartbeatInterval: 60,
    maxRetry: 5,
    debug: false,
    logLevel: types_1.LogLevel.INFO,
    batchSize: 100,
    flushInterval: 60,
};
class SecployClient {
    constructor(config) {
        this.logHandlers = new Set();
        // Merge with default config
        this.config = { ...DEFAULT_CONFIG, ...config };
        // Validate required fields
        if (!this.config.apiKey) {
            throw new Error("API key is required");
        }
        if (!this.config.environmentKey) {
            throw new Error("Environment key is required");
        }
        if (!this.config.organizationId) {
            throw new Error("Organization ID is required");
        }
        if (!this.config.ingestUrl) {
            throw new Error("Ingest URL is required");
        }
        // Initialize event handling
        this.eventQueue = new events_1.EventQueue();
        this.eventHandler = new events_1.EventHandler(this.eventQueue);
        this.eventProcessor = new processor_1.EventProcessor(this.eventQueue, this.config.ingestUrl, () => this.getHeaders(), this.config.batchSize, this.config.flushInterval, this.config.maxRetry);
        // Start processing
        this.start();
        // Set up debug logging
        if (this.config.debug) {
            this.setupLogging();
        }
    }
    getHeaders() {
        return {
            "X-API-Key": this.config.apiKey,
            "X-Environment-Key": this.config.environmentKey,
            "X-Organization-ID": this.config.organizationId,
            "Content-Type": "application/json",
        };
    }
    setupLogging() {
        // Override console methods to capture logs
        const originalConsole = { ...console };
        const logLevels = {
            log: types_1.LogLevel.INFO,
            info: types_1.LogLevel.INFO,
            warn: types_1.LogLevel.WARNING,
            error: types_1.LogLevel.ERROR,
            debug: types_1.LogLevel.DEBUG,
        };
        Object.entries(logLevels).forEach(([method, level]) => {
            console[method] = (...args) => {
                // Call original console method
                originalConsole[method](...args);
                // Forward to log handlers
                const message = args
                    .map((arg) => typeof arg === "object" ? JSON.stringify(arg) : String(arg))
                    .join(" ");
                this.logHandlers.forEach((handler) => {
                    handler.handleLog(level, message);
                });
            };
        });
    }
    registerLogHandler(handler) {
        this.logHandlers.add(handler);
    }
    unregisterLogHandler(handler) {
        this.logHandlers.delete(handler);
    }
    sendEvent(eventType, payload) {
        return this.eventHandler.sendEvent(eventType, payload);
    }
    start() {
        this.eventProcessor.start();
    }
    async stop() {
        await this.eventProcessor.stop();
    }
}
exports.SecployClient = SecployClient;
