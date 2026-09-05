"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogLevel = exports.REDACTED = exports.normalizeKey = exports.scrubString = exports.hashSessionId = exports.Scrubber = exports.bucket = exports.actorKey = exports.neverSampled = exports.shouldSend = exports.normalizeAuthContext = exports.RealtimeChannel = exports.IdentityReporter = exports.PolicySnapshot = exports.SecurityPolicyCache = exports.normalizeEndpoint = exports.SecurityGateBlocked = exports.SecployGate = exports.GlobalErrorHandlers = exports.culpritFrom = exports.normalizeError = exports.parseStack = exports.parseError = exports.koaErrorHandler = exports.fastifyErrorHandler = exports.expressErrorHandler = exports.Secploy = void 0;
const types_1 = require("./types");
const events_1 = require("./events");
const scrubbing_1 = require("./scrubbing");
const processor_1 = require("./processor");
const policyCache_1 = require("./policyCache");
const identityReporter_1 = require("./identityReporter");
const gate_1 = require("./gate");
const errors_1 = require("./errors");
const instrument_1 = require("./instrument");
const errorHandlers_1 = require("./errorHandlers");
const DEFAULT_CONFIG = {
    environment: "development",
    samplingRate: 1.0,
    maxRetry: 5,
    debug: false,
    logLevel: types_1.LogLevel.INFO,
    batchSize: 100,
    flushInterval: 60,
    maxQueueSize: events_1.DEFAULT_MAX_QUEUE_SIZE,
    apiUrl: "https://api.secploy.com",
    gateMode: "remote",
    maxPolicyStaleness: 900,
    identityReportInterval: 300,
    identityFlushInterval: 30,
    realtime: true,
    failOpen: true,
    captureUncaught: true,
    captureConsole: true,
    scrubEnabled: true,
};
const GATE_MODES = ["remote", "cached", "shadow"];
/** Severity order, for comparing against the configured logLevel. */
const LEVEL_ORDER = {
    [types_1.LogLevel.DEBUG]: 0,
    [types_1.LogLevel.INFO]: 1,
    [types_1.LogLevel.WARNING]: 2,
    [types_1.LogLevel.ERROR]: 3,
    [types_1.LogLevel.CRITICAL]: 4,
};
/**
 * JSON.stringify that cannot throw.
 *
 * A logged object may be circular or carry a getter that raises; neither is a
 * reason for the log line to be lost.
 */
function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return Object.prototype.toString.call(value);
    }
}
class Secploy {
    constructor(config) {
        this.logHandlers = new Set();
        this.globalHandlers = null;
        /** Set while restoring console, so uninstall puts back exactly what we took. */
        this.restoreConsole = null;
        this.config = { ...DEFAULT_CONFIG, ...config };
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
        if (!GATE_MODES.includes(this.config.gateMode)) {
            throw new Error(`Invalid gateMode: ${this.config.gateMode}. Must be one of: ${GATE_MODES.join(", ")}.`);
        }
        this.eventQueue = new events_1.EventQueue(this.config.maxQueueSize);
        // Credentials never leave the process. See scrubbing.ts for what counts as
        // one, and why identifiers deliberately do not.
        this.eventHandler = new events_1.EventHandler(this.eventQueue, new scrubbing_1.Scrubber({
            denyKeys: this.config.scrubFields,
            enabled: this.config.scrubEnabled !== false,
        }), this.config.beforeSend, 
        // Applied at last. It has been in the configuration - documented and
        // defaulted - and never read, so a project that turned its volume down
        // was still sending all of it.
        this.config.samplingRate);
        this.eventProcessor = new processor_1.EventProcessor(this.eventQueue, this.config.ingestUrl, () => this.getHeaders(), this.config.batchSize, this.config.flushInterval, this.config.maxRetry);
        const apiUrl = (this.config.apiUrl ?? "https://api.secploy.com").replace(/\/$/, "");
        this.securityPolicy = new policyCache_1.SecurityPolicyCache({
            apiUrl,
            headersCallback: () => this.getHeaders(),
            maxStaleness: this.config.maxPolicyStaleness,
        });
        // With the gate cached there is no per-request call to carry identity to
        // the API, so it is batched and deduplicated here instead.
        this.identities = new identityReporter_1.IdentityReporter({
            apiUrl,
            headersCallback: () => this.getHeaders(),
            reportInterval: this.config.identityReportInterval,
            flushInterval: this.config.identityFlushInterval,
        });
        this.gate = new gate_1.SecployGate({
            apiUrl,
            apiKey: this.config.apiKey,
            environmentKey: this.config.environmentKey,
            headersCallback: () => this.getHeaders(),
            policyCache: this.securityPolicy,
            identityReporter: this.identities,
            gateMode: this.config.gateMode,
            failOpen: this.config.failOpen,
            sendEvent: (type, payload) => {
                this.sendEvent(type, payload);
            },
        });
        this.start();
    }
    /**
     * Load the policy snapshot and subscribe to changes.
     *
     * The first fetch is not awaited, so constructing the client never blocks the
     * application on a network call. Until it lands the gate falls back to a
     * remote lookup, so requests are decided correctly from the very first one
     * rather than being waved through.
     */
    startSecurityPolicy() {
        const wsUrl = (this.config.apiUrl ?? "https://api.secploy.com")
            .replace(/\/$/, "")
            .replace(/^https:\/\//, "wss://")
            .replace(/^http:\/\//, "ws://") + "/ws/sdk/security/";
        this.securityPolicy
            .fetch()
            .catch((error) => console.warn("[secploy] Initial security policy fetch failed:", error))
            .then(() => {
            if (!this.config.realtime)
                return;
            try {
                this.securityPolicy.startRealtime(wsUrl, () => this.getHeaders());
            }
            catch (error) {
                console.warn("[secploy] Security policy real-time failed to start:", error);
            }
        });
        this.identities.start();
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
        const logLevels = {
            log: types_1.LogLevel.INFO,
            info: types_1.LogLevel.INFO,
            warn: types_1.LogLevel.WARNING,
            error: types_1.LogLevel.ERROR,
            debug: types_1.LogLevel.DEBUG,
        };
        // `logLevel` was declared, defaulted, and never read: every console level
        // was captured whatever it was set to, so an application asking for errors
        // only still shipped its debug output.
        const threshold = LEVEL_ORDER[this.config.logLevel ?? types_1.LogLevel.INFO] ?? 0;
        // Capture the exact functions being replaced, so stop() can put those back
        // rather than a snapshot of whatever console looked like. If another
        // library patched console after us, restoring a copy would silently undo
        // their instrumentation too.
        const originals = {};
        Object.entries(logLevels).forEach(([method, level]) => {
            const original = console[method];
            originals[method] = original;
            // Below the configured level: leave the method alone entirely rather
            // than wrapping it and discarding the result, so quiet levels cost
            // nothing at all.
            if ((LEVEL_ORDER[level] ?? 0) < threshold) {
                delete originals[method];
                return;
            }
            console[method] = (...args) => {
                // The application's own output goes out first and unchanged. Whatever
                // happens below must never come between a developer and their logs.
                if (typeof original === "function")
                    original.apply(console, args);
                try {
                    const message = args
                        .map((arg) => typeof arg === "object" ? safeStringify(arg) : String(arg))
                        .join(" ");
                    this.logHandlers.forEach((handler) => {
                        handler.handleLog(level, message);
                    });
                    // An error logged rather than thrown is still an error. Without this
                    // the most common way applications record a handled failure -
                    // console.error(err) - produced a log line and no issue.
                    if (level === types_1.LogLevel.ERROR) {
                        const thrown = args.find((arg) => arg instanceof Error);
                        if (thrown) {
                            this.reportError((0, errors_1.parseError)(thrown), {
                                mechanism: "console",
                                handled: true,
                                level: "error",
                            });
                        }
                    }
                }
                catch {
                    // Capturing a log must never break logging.
                }
            };
        });
        this.restoreConsole = () => {
            Object.entries(originals).forEach(([method, original]) => {
                console[method] = original;
            });
        };
    }
    /**
     * Report a parsed error as an event.
     *
     * One place builds the payload so a crash, a console.error and an explicit
     * captureException all arrive in the same shape and group together.
     */
    reportError(parsed, context = {}) {
        try {
            const payload = {
                message: `${parsed.type}: ${parsed.value}`,
                type: String(context.level ?? "error"),
                context: {
                    exception_type: parsed.type,
                    exception_value: parsed.value,
                    // Both shapes: structured frames for grouping and display, the
                    // formatted strings so an ingest that predates them still works.
                    stacktrace: parsed.stacktrace,
                    frames: parsed.frames,
                    // No culprit here on purpose. Each side owns what it actually knows:
                    // the SDK knows which frames are the application's own, because it is
                    // running inside it; the ingest owns how a module path is normalised,
                    // because that rule has to be identical for every event whatever sent
                    // it. Sending our own culprit as well produced a field that quietly
                    // disagreed with the one on the issue.
                    environment: this.config.environment,
                    ...(this.config.release ? { release: this.config.release } : {}),
                    ...context.extra,
                    mechanism: context.mechanism ?? "manual",
                    handled: context.handled ?? true,
                },
            };
            this.sendEvent(String(context.level ?? "error"), payload);
            return parsed.type;
        }
        catch (failure) {
            // eslint-disable-next-line no-console
            console.error("[secploy] Failed to build an error report:", failure);
            return null;
        }
    }
    /**
     * Report an error that was caught and handled.
     *
     * Accepts anything: JavaScript permits throwing any value, and a rejected
     * promise carrying a plain object is not unusual. Whatever arrives becomes a
     * report rather than a second failure inside the reporter.
     */
    captureException(thrown, context = {}) {
        this.reportError((0, errors_1.parseError)(thrown), {
            mechanism: "manual",
            handled: true,
            level: context.level ?? "error",
            extra: context,
        });
    }
    /**
     * Report a message with no exception behind it.
     *
     * The stack is captured from here so the event still says where it came
     * from; the frame for this method itself is dropped.
     */
    /**
     * Framework error handlers, bound to this client.
     *
     * Sits next to gate.express() so the two halves of the integration read the
     * same way: one guards the request, one catches what it throws.
     */
    get errorHandler() {
        return {
            express: () => (0, errorHandlers_1.expressErrorHandler)(this),
            koa: () => (0, errorHandlers_1.koaErrorHandler)(this),
            fastify: () => (0, errorHandlers_1.fastifyErrorHandler)(this),
        };
    }
    captureMessage(message, level = "info", context = {}) {
        const carrier = new Error(message);
        const parsed = (0, errors_1.parseError)(carrier);
        parsed.type = "Message";
        parsed.value = message;
        // Frames are innermost-last, so this method's own frame is the final one.
        parsed.frames = parsed.frames.slice(0, -1);
        this.reportError(parsed, {
            mechanism: "manual",
            handled: true,
            level,
            extra: context,
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
        if (this.config.gateMode !== "remote") {
            this.startSecurityPolicy();
        }
        // Console capture is on by default rather than gated behind `debug`. It
        // used to run only when debugging, which meant an application's own
        // console.error output - often the only record of a handled failure -
        // reached the SDK on a developer's laptop and nowhere else.
        if (this.config.captureConsole && !this.restoreConsole) {
            this.setupLogging();
        }
        if (this.config.debug) {
            // `debug` used to gate console capture. When that became a setting of
            // its own it was left declared and unread, so turning it on did nothing.
            // It now says what it sounds like it says: report what the SDK itself is
            // doing.
            console.info(`[secploy] started: gate=${this.config.gateMode} ` +
                `sampling=${this.config.samplingRate} ` +
                `scrubbing=${this.config.scrubEnabled !== false} ` +
                `queue=${this.eventQueue.maxSize()} ` +
                `captureUncaught=${this.config.captureUncaught} ` +
                `release=${this.config.release ?? "unset"}`);
        }
        // The crashes worth having are the ones nobody anticipated.
        if (this.config.captureUncaught && !this.globalHandlers) {
            this.globalHandlers = new instrument_1.GlobalErrorHandlers({
                capture: (parsed, context) => this.reportError(parsed, context),
                flush: () => this.flush(),
            });
            this.globalHandlers.install();
        }
    }
    /**
     * Deliver whatever is queued, without shutting anything down.
     *
     * Separate from stop() because a serverless handler or a crash path wants the
     * events out but the client still usable.
     */
    async flush() {
        await this.eventProcessor.flushNow();
    }
    async stop() {
        this.securityPolicy.stopRealtime();
        // Put the process back as we found it. A library that leaves a patched
        // console and process listeners behind after being stopped is a leak, and
        // in tests it is a cross-contamination bug.
        if (this.globalHandlers) {
            this.globalHandlers.uninstall();
            this.globalHandlers = null;
        }
        if (this.restoreConsole) {
            this.restoreConsole();
            this.restoreConsole = null;
        }
        await this.identities.stop();
        await this.eventProcessor.stop();
    }
}
exports.Secploy = Secploy;
var errorHandlers_2 = require("./errorHandlers");
Object.defineProperty(exports, "expressErrorHandler", { enumerable: true, get: function () { return errorHandlers_2.expressErrorHandler; } });
Object.defineProperty(exports, "fastifyErrorHandler", { enumerable: true, get: function () { return errorHandlers_2.fastifyErrorHandler; } });
Object.defineProperty(exports, "koaErrorHandler", { enumerable: true, get: function () { return errorHandlers_2.koaErrorHandler; } });
var errors_2 = require("./errors");
Object.defineProperty(exports, "parseError", { enumerable: true, get: function () { return errors_2.parseError; } });
Object.defineProperty(exports, "parseStack", { enumerable: true, get: function () { return errors_2.parseStack; } });
Object.defineProperty(exports, "normalizeError", { enumerable: true, get: function () { return errors_2.normalizeError; } });
Object.defineProperty(exports, "culpritFrom", { enumerable: true, get: function () { return errors_2.culpritFrom; } });
var instrument_2 = require("./instrument");
Object.defineProperty(exports, "GlobalErrorHandlers", { enumerable: true, get: function () { return instrument_2.GlobalErrorHandlers; } });
var gate_2 = require("./gate");
Object.defineProperty(exports, "SecployGate", { enumerable: true, get: function () { return gate_2.SecployGate; } });
Object.defineProperty(exports, "SecurityGateBlocked", { enumerable: true, get: function () { return gate_2.SecurityGateBlocked; } });
Object.defineProperty(exports, "normalizeEndpoint", { enumerable: true, get: function () { return gate_2.normalizeEndpoint; } });
var policyCache_2 = require("./policyCache");
Object.defineProperty(exports, "SecurityPolicyCache", { enumerable: true, get: function () { return policyCache_2.SecurityPolicyCache; } });
Object.defineProperty(exports, "PolicySnapshot", { enumerable: true, get: function () { return policyCache_2.PolicySnapshot; } });
var identityReporter_2 = require("./identityReporter");
Object.defineProperty(exports, "IdentityReporter", { enumerable: true, get: function () { return identityReporter_2.IdentityReporter; } });
var realtime_1 = require("./realtime");
Object.defineProperty(exports, "RealtimeChannel", { enumerable: true, get: function () { return realtime_1.RealtimeChannel; } });
var authContext_1 = require("./authContext");
Object.defineProperty(exports, "normalizeAuthContext", { enumerable: true, get: function () { return authContext_1.normalizeAuthContext; } });
var sampling_1 = require("./sampling");
Object.defineProperty(exports, "shouldSend", { enumerable: true, get: function () { return sampling_1.shouldSend; } });
Object.defineProperty(exports, "neverSampled", { enumerable: true, get: function () { return sampling_1.neverSampled; } });
Object.defineProperty(exports, "actorKey", { enumerable: true, get: function () { return sampling_1.actorKey; } });
Object.defineProperty(exports, "bucket", { enumerable: true, get: function () { return sampling_1.bucket; } });
var scrubbing_2 = require("./scrubbing");
Object.defineProperty(exports, "Scrubber", { enumerable: true, get: function () { return scrubbing_2.Scrubber; } });
Object.defineProperty(exports, "hashSessionId", { enumerable: true, get: function () { return scrubbing_2.hashSessionId; } });
Object.defineProperty(exports, "scrubString", { enumerable: true, get: function () { return scrubbing_2.scrubString; } });
Object.defineProperty(exports, "normalizeKey", { enumerable: true, get: function () { return scrubbing_2.normalizeKey; } });
Object.defineProperty(exports, "REDACTED", { enumerable: true, get: function () { return scrubbing_2.REDACTED; } });
var types_2 = require("./types");
Object.defineProperty(exports, "LogLevel", { enumerable: true, get: function () { return types_2.LogLevel; } });
