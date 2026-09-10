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
import { LiteClient, LiteConfig } from "../lite/client";
import { ScreenReplayOptions } from "./screenRecorder";
export interface ReactNativeConfig extends LiteConfig {
    replay?: ScreenReplayOptions;
    /**
     * Report unhandled promise rejections through Hermes' rejection tracker.
     * On by default. This replaces React Native's own tracker, whose only job
     * is the development-mode yellow box; the warning is re-logged in dev.
     */
    captureUnhandledRejections?: boolean;
    /**
     * How long a fatal error may hold the app open to deliver its report and
     * replay, before React Native's own handler runs and the app goes down.
     */
    fatalFlushTimeoutMs?: number;
}
export declare class SecployReactNative extends LiteClient {
    private readonly cleanups;
    private readonly screenReplay;
    private readonly rnConfig;
    private pendingUploads;
    /** Start the client. Replaces any client started before it. */
    static init(config: Partial<ReactNativeConfig>): SecployReactNative;
    /** The live client, or null before `init`. */
    static get instance(): SecployReactNative | null;
    constructor(config: Partial<ReactNativeConfig>);
    start(): void;
    private installErrorHandlers;
    close(): Promise<void>;
}
/** Shorthand for `SecployReactNative.init`. */
export declare function init(config: Partial<ReactNativeConfig>): SecployReactNative;
export { SecployReplayRoot, SecployMask, SecployUnmask } from "./components";
export { ScreenReplayRecorder, SCREEN_REPLAY_DEFAULTS } from "./screenRecorder";
export type { CaptureRef, ScreenReplayOptions } from "./screenRecorder";
export { LiteClient, LITE_DEFAULTS } from "../lite/client";
export type { LiteConfig, ReplayHook } from "../lite/client";
export { hashSessionId } from "../portable/ids";
