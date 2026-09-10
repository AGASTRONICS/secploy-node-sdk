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
import { SegmentUploader } from "../replay/uploader";
import { DomReplayRecorder, WebReplayOptions } from "./domRecorder";
import { loadBrowserSession } from "./session";

export interface BrowserConfig extends LiteConfig {
  replay?: WebReplayOptions;
  /**
   * Name the session yourself - typically the id of the login session the API
   * also sees - so browser and server events join. Hashed before use.
   */
  sessionId?: string;
}

let current: SecployBrowser | null = null;

function pageContext(): Record<string, unknown> {
  const g = globalThis as any;
  const context: Record<string, unknown> = { platform: "web" };
  try {
    // Origin and path only. A query string routinely carries tokens - reset
    // links, OAuth codes, signed URLs - that no pattern in the scrubber knows.
    if (g.location) context.url = `${g.location.origin}${g.location.pathname}`;
    if (g.navigator?.userAgent) context.user_agent = g.navigator.userAgent;
  } catch {
    // Opaque origins and sandboxed frames can refuse these reads.
  }
  return context;
}

export class SecployBrowser extends LiteClient {
  private readonly cleanups: Array<() => void> = [];
  private readonly domReplay: DomReplayRecorder | null = null;

  /** Start the client. Replaces any client started before it. */
  static init(config: Partial<BrowserConfig>): SecployBrowser {
    if (current) void current.close();
    const client = new SecployBrowser(config);
    current = client;
    client.start();
    return client;
  }

  /** The live client, or null before `init`. */
  static get instance(): SecployBrowser | null {
    return current;
  }

  constructor(config: Partial<BrowserConfig>) {
    const session = loadBrowserSession(config.sessionId);
    super(config, {
      sdkName: "secploy-browser",
      sessionId: session.id,
      platformContext: pageContext,
      // Firefox and Safari print `fn@url:line:col`.
      stackOptions: { gecko: true },
    });

    const replay = config.replay;
    if (replay?.enabled) {
      if (typeof replay.record !== "function") {
        // eslint-disable-next-line no-console
        console.warn(
          "[secploy] replay.enabled needs replay.record - pass `record` from the rrweb package. Replay is off.",
        );
      } else if (typeof (globalThis as any).document === "undefined") {
        this.diagnostic("No document to record; replay is off (server render?).");
      } else {
        this.domReplay = new DomReplayRecorder({
          options: { ...replay, record: replay.record },
          sessionId: this.sessionId,
          sequence: session.sequence,
          uploader: new SegmentUploader({
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

  start(): void {
    super.start();
    if (this.cleanups.length > 0) return;

    const g = globalThis as any;
    if (typeof g.addEventListener !== "function") return;

    if (this.config.captureUncaught) {
      const onError = (event: any) => {
        // Failed resource loads (a 404 image) dispatch `error` too, with no
        // error and no message. They are not exceptions.
        if (!event || (event.error === undefined && !event.message)) return;
        this.captureException(event.error ?? event.message, {
          mechanism: "onerror",
          handled: false,
        });
      };
      const onRejection = (event: any) => {
        this.captureException(event?.reason, {
          mechanism: "onunhandledrejection",
          handled: false,
        });
      };
      g.addEventListener("error", onError);
      g.addEventListener("unhandledrejection", onRejection);
      this.cleanups.push(() => g.removeEventListener("error", onError));
      this.cleanups.push(() =>
        g.removeEventListener("unhandledrejection", onRejection),
      );
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
    this.cleanups.push(() =>
      g.document?.removeEventListener?.("visibilitychange", onHidden),
    );
    this.cleanups.push(() => g.removeEventListener("pagehide", onPageHide));

    this.domReplay?.start();
  }

  async close(): Promise<void> {
    while (this.cleanups.length) {
      try {
        this.cleanups.pop()!();
      } catch {
        // Removing a listener cannot meaningfully fail; never let it block.
      }
    }
    if (current === this) current = null;
    await super.close();
  }
}

/** Shorthand for `SecployBrowser.init`. */
export function init(config: Partial<BrowserConfig>): SecployBrowser {
  return SecployBrowser.init(config);
}

export {
  DomReplayRecorder,
  WEB_REPLAY_DEFAULTS,
  buildRecordOptions,
  isUnmasked,
} from "./domRecorder";
export type { RrwebRecord, WebReplayOptions } from "./domRecorder";
export { LiteClient, LITE_DEFAULTS } from "../lite/client";
export type { LiteConfig, ReplayHook } from "../lite/client";
export { hashSessionId } from "../portable/ids";
export { readSegment, writeSegment } from "../replay/segment";
export type { SegmentHeader } from "../replay/segment";
