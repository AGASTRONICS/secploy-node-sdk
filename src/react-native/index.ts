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
import { MemorySequence } from "../replay/sequence";
import { SegmentUploader } from "../replay/uploader";
import {
  ScreenReplayOptions,
  ScreenReplayRecorder,
  setActiveRecorder,
} from "./screenRecorder";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require("react-native");

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

let current: SecployReactNative | null = null;

function deviceContext(): Record<string, unknown> {
  return {
    platform: RN?.Platform?.OS ?? "react-native",
    os_version: String(RN?.Platform?.Version ?? ""),
  };
}

export class SecployReactNative extends LiteClient {
  private readonly cleanups: Array<() => void> = [];
  private readonly screenReplay: ScreenReplayRecorder | null = null;
  private readonly rnConfig: Partial<ReactNativeConfig>;
  private pendingUploads: Promise<unknown>[] = [];

  /** Start the client. Replaces any client started before it. */
  static init(config: Partial<ReactNativeConfig>): SecployReactNative {
    if (current) void current.close();
    const client = new SecployReactNative(config);
    current = client;
    client.start();
    return client;
  }

  /** The live client, or null before `init`. */
  static get instance(): SecployReactNative | null {
    return current;
  }

  constructor(config: Partial<ReactNativeConfig>) {
    super(config, { sdkName: "secploy-react-native", platformContext: deviceContext });
    this.rnConfig = config;

    const replay = config.replay;
    if (replay?.enabled) {
      if (typeof replay.captureRef !== "function") {
        // eslint-disable-next-line no-console
        console.warn(
          "[secploy] replay.enabled needs replay.captureRef - pass `captureRef` from react-native-view-shot. Replay is off.",
        );
      } else {
        const recorder = new ScreenReplayRecorder({
          options: { ...replay, captureRef: replay.captureRef },
          sessionId: this.sessionId,
          // A React Native session is one process, like Flutter's.
          sequence: new MemorySequence(),
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
        this.screenReplay = recorder;
        this.replay = {
          get active() {
            return recorder.active;
          },
          // Tracked so a fatal error can wait for its own recording.
          flushForError: (errorEventId?: string) => {
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

  start(): void {
    super.start();
    if (this.cleanups.length > 0) return;

    if (this.screenReplay) {
      setActiveRecorder(this.screenReplay);
      this.cleanups.push(() => setActiveRecorder(null));
    }

    if (this.config.captureUncaught) this.installErrorHandlers();

    const AppState = RN?.AppState;
    if (AppState?.addEventListener) {
      const subscription = AppState.addEventListener("change", (state: string) => {
        if (state === "active") {
          this.screenReplay?.resume();
        } else {
          this.screenReplay?.pause();
          // Backgrounded apps get killed without notice. This is the last
          // moment a report can be expected to leave.
          void this.flush();
        }
      });
      this.cleanups.push(() => subscription?.remove?.());
    }
  }

  private installErrorHandlers(): void {
    const g = globalThis as any;

    const ErrorUtils = g.ErrorUtils;
    if (ErrorUtils?.getGlobalHandler && ErrorUtils?.setGlobalHandler) {
      const previous = ErrorUtils.getGlobalHandler();
      const handler = (error: unknown, isFatal?: boolean) => {
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
        if (ErrorUtils.getGlobalHandler() === handler) ErrorUtils.setGlobalHandler(previous);
      });
    }

    const hermes = g.HermesInternal;
    if (
      this.rnConfig.captureUnhandledRejections !== false &&
      typeof hermes?.enablePromiseRejectionTracker === "function"
    ) {
      hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (id: number, rejection: unknown) => {
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

  async close(): Promise<void> {
    while (this.cleanups.length) {
      try {
        this.cleanups.pop()!();
      } catch {
        // Never let teardown block the rest of it.
      }
    }
    if (current === this) current = null;
    await super.close();
  }
}

/** Shorthand for `SecployReactNative.init`. */
export function init(config: Partial<ReactNativeConfig>): SecployReactNative {
  return SecployReactNative.init(config);
}

export { SecployReplayRoot, SecployMask, SecployUnmask } from "./components";
export { ScreenReplayRecorder, SCREEN_REPLAY_DEFAULTS } from "./screenRecorder";
export type { CaptureRef, ScreenReplayOptions } from "./screenRecorder";
export { LiteClient, LITE_DEFAULTS } from "../lite/client";
export type { LiteConfig, ReplayHook } from "../lite/client";
export { hashSessionId } from "../portable/ids";
