"use strict";
/**
 * Secploy for the browser.
 *
 * ```ts
 * import { record } from "rrweb";
 * import { SecployBrowser } from "secploy/browser";
 *
 * SecployBrowser.init({
 *   apiKey: "...",
 *   environmentKey: "...",
 *   organizationId: "...",
 *   ingestUrl: "https://ingest.secploy.com/ingest",
 *   replay: { enabled: true, record },
 * });
 * ```
 *
 * A separate entry point from the Node client on purpose. That one imports
 * axios, `crypto`, `path` and `process`, installs `process` handlers and holds a
 * WebSocket; none of it belongs in a page, and a bundler asked to include it
 * either fails the build or polyfills its way to a much larger one. Nothing
 * reachable from this file imports a Node module.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeSegment = exports.readSegment = exports.hashSessionId = exports.LITE_DEFAULTS = exports.LiteClient = exports.isUnmasked = exports.buildRecordOptions = exports.WEB_REPLAY_DEFAULTS = exports.DomReplayRecorder = exports.SecployBrowser = void 0;
exports.init = init;
const client_1 = require("../lite/client");
const uploader_1 = require("../replay/uploader");
const domRecorder_1 = require("./domRecorder");
const session_1 = require("./session");
let current = null;
function pageContext() {
    const g = globalThis;
    const context = { platform: "web" };
    try {
        // Origin and path only. A query string routinely carries tokens - reset
        // links, OAuth codes, signed URLs - that no pattern in the scrubber knows.
        if (g.location)
            context.url = `${g.location.origin}${g.location.pathname}`;
        if (g.navigator?.userAgent)
            context.user_agent = g.navigator.userAgent;
    }
    catch {
        // Opaque origins and sandboxed frames can refuse these reads.
    }
    return context;
}
class SecployBrowser extends client_1.LiteClient {
    /** Start the client. Replaces any client started before it. */
    static init(config) {
        if (current)
            void current.close();
        const client = new SecployBrowser(config);
        current = client;
        client.start();
        return client;
    }
    /** The live client, or null before `init`. */
    static get instance() {
        return current;
    }
    constructor(config) {
        const session = (0, session_1.loadBrowserSession)(config.sessionId);
        super(config, {
            sdkName: "secploy-browser",
            sessionId: session.id,
            platformContext: pageContext,
            // Firefox and Safari print `fn@url:line:col`.
            stackOptions: { gecko: true },
        });
        this.cleanups = [];
        this.domReplay = null;
        const replay = config.replay;
        if (replay?.enabled) {
            if (typeof replay.record !== "function") {
                // eslint-disable-next-line no-console
                console.warn("[secploy] replay.enabled needs replay.record - pass `record` from the rrweb package. Replay is off.");
            }
            else if (typeof globalThis.document === "undefined") {
                this.diagnostic("No document to record; replay is off (server render?).");
            }
            else {
                this.domReplay = new domRecorder_1.DomReplayRecorder({
                    options: { ...replay, record: replay.record },
                    sessionId: this.sessionId,
                    sequence: session.sequence,
                    uploader: new uploader_1.SegmentUploader({
                        apiUrl: this.apiUrl,
                        headers: () => this.getHeaders(),
                        fetchImpl: this.fetchImpl,
                    }),
                    emit: (type, payload) => {
                        this.sendEvent(type, payload);
                    },
                    onDiagnostic: (message) => this.diagnostic(message),
                });
                this.replay = this.domReplay;
            }
        }
    }
    start() {
        super.start();
        if (this.cleanups.length > 0)
            return;
        const g = globalThis;
        if (typeof g.addEventListener !== "function")
            return;
        if (this.config.captureUncaught) {
            const onError = (event) => {
                // Failed resource loads (a 404 image) dispatch `error` too, with no
                // error and no message. They are not exceptions.
                if (!event || (event.error === undefined && !event.message))
                    return;
                this.captureException(event.error ?? event.message, {
                    mechanism: "onerror",
                    handled: false,
                });
            };
            const onRejection = (event) => {
                this.captureException(event?.reason, {
                    mechanism: "onunhandledrejection",
                    handled: false,
                });
            };
            g.addEventListener("error", onError);
            g.addEventListener("unhandledrejection", onRejection);
            this.cleanups.push(() => g.removeEventListener("error", onError));
            this.cleanups.push(() => g.removeEventListener("unhandledrejection", onRejection));
        }
        // A hidden page may never be shown again: mobile browsers kill background
        // tabs without an unload event. `visibilitychange` is the last moment that
        // reliably fires, and keepalive lets the request outlive the page.
        const onHidden = () => {
            if (g.document?.visibilityState === "hidden") {
                void this.flush({ keepalive: true });
            }
        };
        const onPageHide = () => void this.flush({ keepalive: true });
        g.document?.addEventListener?.("visibilitychange", onHidden);
        g.addEventListener("pagehide", onPageHide);
        this.cleanups.push(() => g.document?.removeEventListener?.("visibilitychange", onHidden));
        this.cleanups.push(() => g.removeEventListener("pagehide", onPageHide));
        this.domReplay?.start();
    }
    async close() {
        while (this.cleanups.length) {
            try {
                this.cleanups.pop()();
            }
            catch {
                // Removing a listener cannot meaningfully fail; never let it block.
            }
        }
        if (current === this)
            current = null;
        await super.close();
    }
}
exports.SecployBrowser = SecployBrowser;
/** Shorthand for `SecployBrowser.init`. */
function init(config) {
    return SecployBrowser.init(config);
}
var domRecorder_2 = require("./domRecorder");
Object.defineProperty(exports, "DomReplayRecorder", { enumerable: true, get: function () { return domRecorder_2.DomReplayRecorder; } });
Object.defineProperty(exports, "WEB_REPLAY_DEFAULTS", { enumerable: true, get: function () { return domRecorder_2.WEB_REPLAY_DEFAULTS; } });
Object.defineProperty(exports, "buildRecordOptions", { enumerable: true, get: function () { return domRecorder_2.buildRecordOptions; } });
Object.defineProperty(exports, "isUnmasked", { enumerable: true, get: function () { return domRecorder_2.isUnmasked; } });
var client_2 = require("../lite/client");
Object.defineProperty(exports, "LiteClient", { enumerable: true, get: function () { return client_2.LiteClient; } });
Object.defineProperty(exports, "LITE_DEFAULTS", { enumerable: true, get: function () { return client_2.LITE_DEFAULTS; } });
var ids_1 = require("../portable/ids");
Object.defineProperty(exports, "hashSessionId", { enumerable: true, get: function () { return ids_1.hashSessionId; } });
var segment_1 = require("../replay/segment");
Object.defineProperty(exports, "readSegment", { enumerable: true, get: function () { return segment_1.readSegment; } });
Object.defineProperty(exports, "writeSegment", { enumerable: true, get: function () { return segment_1.writeSegment; } });
