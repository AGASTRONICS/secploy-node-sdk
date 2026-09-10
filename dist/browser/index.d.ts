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
import { LiteClient, LiteConfig } from "../lite/client";
import { WebReplayOptions } from "./domRecorder";
export interface BrowserConfig extends LiteConfig {
    replay?: WebReplayOptions;
    /**
     * Name the session yourself - typically the id of the login session the API
     * also sees - so browser and server events join. Hashed before use.
     */
    sessionId?: string;
}
export declare class SecployBrowser extends LiteClient {
    private readonly cleanups;
    private readonly domReplay;
    /** Start the client. Replaces any client started before it. */
    static init(config: Partial<BrowserConfig>): SecployBrowser;
    /** The live client, or null before `init`. */
    static get instance(): SecployBrowser | null;
    constructor(config: Partial<BrowserConfig>);
    start(): void;
    close(): Promise<void>;
}
/** Shorthand for `SecployBrowser.init`. */
export declare function init(config: Partial<BrowserConfig>): SecployBrowser;
export { DomReplayRecorder, WEB_REPLAY_DEFAULTS, buildRecordOptions, isUnmasked, } from "./domRecorder";
export type { RrwebRecord, WebReplayOptions } from "./domRecorder";
export { LiteClient, LITE_DEFAULTS } from "../lite/client";
export type { LiteConfig, ReplayHook } from "../lite/client";
export { hashSessionId } from "../portable/ids";
export { readSegment, writeSegment } from "../replay/segment";
export type { SegmentHeader } from "../replay/segment";
