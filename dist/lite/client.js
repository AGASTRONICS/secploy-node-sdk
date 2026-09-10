"use strict";
/**
 * The client core shared by the browser and React Native builds.
 *
 * The Node client (`index.ts`) is built for a server: axios, `process`
 * handlers, a sixty-second flush, a request gate, a WebSocket policy channel.
 * None of that belongs in a page or on a handset, and most of it would not
 * even bundle there. This is the part both front-end runtimes actually need -
 * an event queue, error reports in the shape every SDK sends, and a place for
 * session replay to hang - built on `fetch` and nothing else.
 *
 * What it deliberately shares with the Node client, by importing rather than
 * copying: the delivery policy (`transport.ts`), the scrubber
 * (`portable/scrub.ts`) and the stack parser (`portable/stack.ts`). Those are
 * the rules the ingest relies on every client following identically.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiteClient = exports.LITE_DEFAULTS = void 0;
const scrub_1 = require("../portable/scrub");
const stack_1 = require("../portable/stack");
const ids_1 = require("../portable/ids");
const uploader_1 = require("../replay/uploader");
const transport_1 = require("../transport");
/**
 * Defaults tuned for a front end rather than a server.
 *
 * Five seconds, not sixty: a tab is closed or an app is swiped away long before
 * a minute passes, and an error that sits in memory until then is never sent.
 * A smaller queue, because this heap is somebody's phone.
 */
exports.LITE_DEFAULTS = {
    apiUrl: "https://api.secploy.com",
    environment: "production",
    captureUncaught: true,
    scrubEnabled: true,
    batchSize: 30,
    flushInterval: 5,
    maxQueueSize: 500,
    maxRetry: 3,
    debug: false,
};
class LiteClient {
    constructor(config, platform) {
        this.replay = null;
        this.queue = [];
        this.timer = null;
        this.draining = null;
        this.closed = false;
        this.droppedEvents = 0;
        this.filteredEvents = 0;
        const resolved = { ...exports.LITE_DEFAULTS, ...config };
        // Undefined in the caller's object must not erase a default.
        for (const [key, value] of Object.entries(exports.LITE_DEFAULTS)) {
            if (resolved[key] === undefined)
                resolved[key] = value;
        }
        this.config = resolved;
        if (!resolved.apiKey)
            throw new Error("API key is required");
        if (!resolved.environmentKey)
            throw new Error("Environment key is required");
        if (!resolved.organizationId)
            throw new Error("Organization ID is required");
        if (!resolved.ingestUrl)
            throw new Error("Ingest URL is required");
        const fetchImpl = platform.fetchImpl ??
            (typeof globalThis.fetch === "function"
                ? globalThis.fetch.bind(globalThis)
                : null);
        if (!fetchImpl) {
            throw new Error("[secploy] fetch is not available in this runtime");
        }
        this.fetchImpl = fetchImpl;
        this.sdkName = platform.sdkName;
        this.platformContext = platform.platformContext ?? (() => ({}));
        this.stackOptions = platform.stackOptions ?? {};
        this.sessionId = platform.sessionId ?? (0, ids_1.newSessionId)();
        this.scrubber = new scrub_1.Scrubber({
            denyKeys: resolved.scrubFields,
            enabled: resolved.scrubEnabled !== false,
        });
    }
    diagnostic(message) {
        if (this.config.debug) {
            // eslint-disable-next-line no-console
            console.info(`[secploy] ${message}`);
        }
    }
    getHeaders() {
        return {
            "X-API-Key": this.config.apiKey,
            "X-Environment-Key": this.config.environmentKey,
            "X-Organization-ID": this.config.organizationId,
        };
    }
    get apiUrl() {
        return (this.config.apiUrl || exports.LITE_DEFAULTS.apiUrl).replace(/\/+$/, "");
    }
    start() {
        if (this.timer || this.closed)
            return;
        this.timer = setInterval(() => {
            void this.drain(this.config.maxRetry);
        }, this.config.flushInterval * 1000);
        // Node only (tests, SSR). A page or an app has no process to hold open.
        this.timer.unref?.();
    }
    /**
     * Queue one event. Never throws.
     *
     * The same door as `EventHandler.sendEvent` in the Node client: the
     * application's hook first, on the real values, then the scrubber, so
     * nothing the hook returns can leave unscrubbed.
     */
    sendEvent(type, payload) {
        if (this.closed)
            return false;
        try {
            let prepared = payload;
            if (this.config.beforeSend) {
                try {
                    const result = this.config.beforeSend({ ...payload });
                    if (result === null) {
                        this.filteredEvents++;
                        return false;
                    }
                    if (result && typeof result === "object" && !Array.isArray(result)) {
                        prepared = result;
                    }
                }
                catch (error) {
                    // A broken filter costs visibility into the filter, not the app.
                    // eslint-disable-next-line no-console
                    console.error("[secploy] beforeSend threw, keeping the event:", error);
                }
            }
            const scrubbed = this.scrubber.scrub(prepared);
            if (!scrubbed || typeof scrubbed !== "object" || Array.isArray(scrubbed)) {
                return false;
            }
            if (this.queue.length >= this.config.maxQueueSize) {
                // Oldest out: the newest events describe what is happening now.
                this.queue.shift();
                this.droppedEvents++;
            }
            this.queue.push({
                type,
                payload: { event_id: (0, ids_1.newEventId)(), ...scrubbed },
                timestamp: Date.now(),
            });
            if (this.queue.length >= this.config.batchSize) {
                void this.drain(this.config.maxRetry);
            }
            return true;
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error("[secploy] Failed to queue event:", error);
            return false;
        }
    }
    /**
     * Report an error. Returns the event id, which is also what the replay
     * uploaded for it is indexed under.
     */
    captureException(thrown, context = {}) {
        const { mechanism, handled, level, ...extra } = context;
        return this.report((0, stack_1.parseError)(thrown, stack_1.defaultModuleOf, this.stackOptions), {
            level: String(level ?? "error"),
            mechanism: String(mechanism ?? "manual"),
            handled: handled === undefined ? true : Boolean(handled),
            extra,
        });
    }
    /** Report a message with no exception behind it. */
    captureMessage(message, level = "info", context = {}) {
        const parsed = (0, stack_1.parseError)(new Error(message), stack_1.defaultModuleOf, this.stackOptions);
        parsed.type = "Message";
        parsed.value = message;
        // Frames are innermost-last, so this method's own frame is the final one.
        parsed.frames = parsed.frames.slice(0, -1);
        return this.report(parsed, {
            level,
            mechanism: "manual",
            handled: true,
            extra: context,
        });
    }
    /**
     * Build and queue an error report, and ask replay for the window behind it.
     *
     * The same payload `buildErrorPayload` produces in the Dart SDK, so a web
     * error, a React Native error and a Flutter error group and render alike.
     */
    report(parsed, options) {
        if (this.closed)
            return null;
        try {
            const eventId = (0, ids_1.newEventId)();
            const replay = this.replay;
            const replayActive = Boolean(replay?.active);
            let platformContext = {};
            try {
                platformContext = this.platformContext();
            }
            catch {
                // A platform probe that throws must not cost the report.
            }
            const sent = this.sendEvent(options.level, {
                event_id: eventId,
                message: `${parsed.type}: ${parsed.value}`,
                type: options.level,
                context: {
                    exception_type: parsed.type,
                    exception_value: parsed.value,
                    stacktrace: parsed.stacktrace,
                    frames: parsed.frames,
                    environment: this.config.environment,
                    ...(this.config.release ? { release: this.config.release } : {}),
                    session_id: this.sessionId,
                    sdk: this.sdkName,
                    ...platformContext,
                    // Tells the dashboard to look for a recording, and to say so when
                    // none arrived - which means segments were lost, not never taken.
                    ...(replayActive ? { has_replay: true } : {}),
                    ...options.extra,
                    mechanism: options.mechanism,
                    handled: options.handled,
                },
            });
            // Fire and forget, and only for an error that is actually going out: a
            // recording of an error the app's own filter dropped is a recording
            // nobody can reach. The report never waits on the upload.
            if (sent && replay && replayActive) {
                replay.flushForError(eventId).catch((error) => {
                    this.diagnostic(`Replay flush failed: ${error}`);
                });
            }
            return sent ? eventId : null;
        }
        catch (failure) {
            // eslint-disable-next-line no-console
            console.error("[secploy] Failed to build an error report:", failure);
            return null;
        }
    }
    /**
     * Send whatever is queued now, once each, without waiting on a retry
     * schedule already in progress.
     *
     * `keepalive` lets the request outlive the page. Browsers cap a keepalive
     * body at 64 KiB, so larger batches go without it and may be cut off - the
     * cost of a tab closing mid-send, not a reason to hold the page open.
     */
    async flush(options = {}) {
        const events = this.queue.splice(0);
        for (let i = 0; i < events.length; i += this.config.batchSize) {
            await this.sendBatch(events.slice(i, i + this.config.batchSize), 1, Boolean(options.keepalive));
        }
    }
    /** Stop, flush what is left, and release the replay recorder. */
    async close() {
        if (this.closed)
            return;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.replay?.stop();
        await this.flush();
        this.closed = true;
    }
    diagnostics() {
        return {
            session_id: this.sessionId,
            queued: this.queue.length,
            dropped: this.droppedEvents,
            filtered: this.filteredEvents,
            replay: this.replay?.diagnostics() ?? null,
        };
    }
    drain(attempts) {
        if (this.draining)
            return this.draining;
        this.draining = (async () => {
            try {
                while (this.queue.length > 0 && !this.closed) {
                    const batch = this.queue.splice(0, this.config.batchSize);
                    await this.sendBatch(batch, attempts, false);
                }
            }
            finally {
                this.draining = null;
            }
        })();
        return this.draining;
    }
    /** Deliver one batch under the shared transport rules. Never throws. */
    async sendBatch(events, attempts, keepalive) {
        if (events.length === 0)
            return;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const { outcome, retryAfterMs } = await this.post(events, keepalive);
            if (outcome === "delivered")
                return;
            if (outcome === "drop") {
                this.droppedEvents += events.length;
                // eslint-disable-next-line no-console
                console.warn(`[secploy] Discarded ${events.length} events the ingest rejected`);
                return;
            }
            if (attempt === attempts - 1 || this.closed)
                break;
            await new Promise((resolve) => setTimeout(resolve, (0, transport_1.backoffDelay)(attempt, retryAfterMs)));
        }
        this.droppedEvents += events.length;
    }
    async post(events, keepalive) {
        try {
            const body = JSON.stringify({ events });
            const response = await (0, uploader_1.fetchWithTimeout)(this.fetchImpl, this.config.ingestUrl, {
                method: "POST",
                headers: { ...this.getHeaders(), "Content-Type": "application/json" },
                body,
                credentials: "omit",
                keepalive: keepalive && body.length < 60000,
            }, 10000);
            let retryAfter = null;
            try {
                retryAfter = response.headers?.get?.("retry-after") ?? null;
            }
            catch {
                retryAfter = null;
            }
            return {
                outcome: (0, transport_1.classifyStatus)(response.status),
                retryAfterMs: (0, transport_1.parseRetryAfter)(retryAfter),
            };
        }
        catch {
            return { outcome: "retry", retryAfterMs: null };
        }
    }
}
exports.LiteClient = LiteClient;
