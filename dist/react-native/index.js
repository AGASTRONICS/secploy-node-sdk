"use strict";
/**
 * Secploy for React Native.
 *
 * ```tsx
 * import { captureRef } from "react-native-view-shot";
 * import { SecployReactNative, SecployReplayRoot } from "secploy/react-native";
 *
 * SecployReactNative.init({
 *   apiKey: "...",
 *   environmentKey: "...",
 *   organizationId: "...",
 *   ingestUrl: "https://ingest.secploy.com/ingest",
 *   replay: { enabled: true, captureRef },
 * });
 *
 * export default function Root() {
 *   return (
 *     <SecployReplayRoot>
 *       <App />
 *     </SecployReplayRoot>
 *   );
 * }
 * ```
 *
 * Like the browser build, nothing reachable from here imports a Node module.
 * `react-native-view-shot` is passed in rather than imported, so an app that
 * leaves replay off needs no native module for it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashSessionId = exports.LITE_DEFAULTS = exports.LiteClient = exports.SCREEN_REPLAY_DEFAULTS = exports.ScreenReplayRecorder = exports.SecployUnmask = exports.SecployMask = exports.SecployReplayRoot = exports.SecployReactNative = void 0;
exports.init = init;
const client_1 = require("../lite/client");
const sequence_1 = require("../replay/sequence");
const uploader_1 = require("../replay/uploader");
const screenRecorder_1 = require("./screenRecorder");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require("react-native");
let current = null;
function deviceContext() {
    return {
        platform: RN?.Platform?.OS ?? "react-native",
        os_version: String(RN?.Platform?.Version ?? ""),
    };
}
class SecployReactNative extends client_1.LiteClient {
    /** Start the client. Replaces any client started before it. */
    static init(config) {
        if (current)
            void current.close();
        const client = new SecployReactNative(config);
        current = client;
        client.start();
        return client;
    }
    /** The live client, or null before `init`. */
    static get instance() {
        return current;
    }
    constructor(config) {
        super(config, { sdkName: "secploy-react-native", platformContext: deviceContext });
        this.cleanups = [];
        this.screenReplay = null;
        this.pendingUploads = [];
        this.rnConfig = config;
        const replay = config.replay;
        if (replay?.enabled) {
            if (typeof replay.captureRef !== "function") {
                // eslint-disable-next-line no-console
                console.warn("[secploy] replay.enabled needs replay.captureRef - pass `captureRef` from react-native-view-shot. Replay is off.");
            }
            else {
                const recorder = new screenRecorder_1.ScreenReplayRecorder({
                    options: { ...replay, captureRef: replay.captureRef },
                    sessionId: this.sessionId,
                    // A React Native session is one process, like Flutter's.
                    sequence: new sequence_1.MemorySequence(),
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
                this.screenReplay = recorder;
                this.replay = {
                    get active() {
                        return recorder.active;
                    },
                    // Tracked so a fatal error can wait for its own recording.
                    flushForError: (errorEventId) => {
                        const upload = recorder.flushForError(errorEventId);
                        this.pendingUploads.push(upload);
                        void upload.finally(() => {
                            this.pendingUploads = this.pendingUploads.filter((p) => p !== upload);
                        });
                        return upload;
                    },
                    stop: () => recorder.stop(),
                    diagnostics: () => recorder.diagnostics(),
                };
            }
        }
    }
    start() {
        super.start();
        if (this.cleanups.length > 0)
            return;
        if (this.screenReplay) {
            (0, screenRecorder_1.setActiveRecorder)(this.screenReplay);
            this.cleanups.push(() => (0, screenRecorder_1.setActiveRecorder)(null));
        }
        if (this.config.captureUncaught)
            this.installErrorHandlers();
        const AppState = RN?.AppState;
        if (AppState?.addEventListener) {
            const subscription = AppState.addEventListener("change", (state) => {
                if (state === "active") {
                    this.screenReplay?.resume();
                }
                else {
                    this.screenReplay?.pause();
                    // Backgrounded apps get killed without notice. This is the last
                    // moment a report can be expected to leave.
                    void this.flush();
                }
            });
            this.cleanups.push(() => subscription?.remove?.());
        }
    }
    installErrorHandlers() {
        const g = globalThis;
        const ErrorUtils = g.ErrorUtils;
        if (ErrorUtils?.getGlobalHandler && ErrorUtils?.setGlobalHandler) {
            const previous = ErrorUtils.getGlobalHandler();
            const handler = (error, isFatal) => {
                this.captureException(error, {
                    mechanism: "ErrorUtils",
                    handled: false,
                    level: isFatal ? "fatal" : "error",
                });
                if (!isFatal) {
                    previous?.(error, isFatal);
                    return;
                }
                // In a release build React Native's handler ends the process. Give the
                // report, and the recording of the seconds before it, a bounded chance
                // to leave first. Unbounded, a dead network would freeze a crashed app.
                const timeout = this.rnConfig.fatalFlushTimeoutMs ?? 3000;
                void Promise.race([
                    Promise.all([...this.pendingUploads]).then(() => this.flush()),
                    new Promise((resolve) => setTimeout(resolve, timeout)),
                ])
                    .catch(() => undefined)
                    .then(() => previous?.(error, isFatal));
            };
            ErrorUtils.setGlobalHandler(handler);
            this.cleanups.push(() => {
                if (ErrorUtils.getGlobalHandler() === handler)
                    ErrorUtils.setGlobalHandler(previous);
            });
        }
        const hermes = g.HermesInternal;
        if (this.rnConfig.captureUnhandledRejections !== false &&
            typeof hermes?.enablePromiseRejectionTracker === "function") {
            hermes.enablePromiseRejectionTracker({
                allRejections: true,
                onUnhandled: (id, rejection) => {
                    this.captureException(rejection, {
                        mechanism: "onunhandledrejection",
                        handled: false,
                    });
                    if (g.__DEV__) {
                        // eslint-disable-next-line no-console
                        console.warn(`Possible unhandled promise rejection (id: ${id}):`, rejection);
                    }
                },
                onHandled: () => undefined,
            });
        }
    }
    async close() {
        while (this.cleanups.length) {
            try {
                this.cleanups.pop()();
            }
            catch {
                // Never let teardown block the rest of it.
            }
        }
        if (current === this)
            current = null;
        await super.close();
    }
}
exports.SecployReactNative = SecployReactNative;
/** Shorthand for `SecployReactNative.init`. */
function init(config) {
    return SecployReactNative.init(config);
}
var components_1 = require("./components");
Object.defineProperty(exports, "SecployReplayRoot", { enumerable: true, get: function () { return components_1.SecployReplayRoot; } });
Object.defineProperty(exports, "SecployMask", { enumerable: true, get: function () { return components_1.SecployMask; } });
Object.defineProperty(exports, "SecployUnmask", { enumerable: true, get: function () { return components_1.SecployUnmask; } });
var screenRecorder_2 = require("./screenRecorder");
Object.defineProperty(exports, "ScreenReplayRecorder", { enumerable: true, get: function () { return screenRecorder_2.ScreenReplayRecorder; } });
Object.defineProperty(exports, "SCREEN_REPLAY_DEFAULTS", { enumerable: true, get: function () { return screenRecorder_2.SCREEN_REPLAY_DEFAULTS; } });
var client_2 = require("../lite/client");
Object.defineProperty(exports, "LiteClient", { enumerable: true, get: function () { return client_2.LiteClient; } });
Object.defineProperty(exports, "LITE_DEFAULTS", { enumerable: true, get: function () { return client_2.LITE_DEFAULTS; } });
var ids_1 = require("../portable/ids");
Object.defineProperty(exports, "hashSessionId", { enumerable: true, get: function () { return ids_1.hashSessionId; } });
