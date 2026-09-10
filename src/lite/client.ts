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

import { Scrubber } from "../portable/scrub";
import {
  ParsedError,
  ParseStackOptions,
  defaultModuleOf,
  parseError,
} from "../portable/stack";
import { newEventId, newSessionId } from "../portable/ids";
import { FetchLike, fetchWithTimeout } from "../replay/uploader";
import { backoffDelay, classifyStatus, parseRetryAfter } from "../transport";

export interface LiteConfig {
  apiKey: string;
  environmentKey: string;
  organizationId: string;
  /** Where events are POSTed, e.g. https://ingest.secploy.com/ingest */
  ingestUrl: string;
  /** Base API URL, for replay upload URLs. Defaults to https://api.secploy.com */
  apiUrl?: string;
  environment?: string;
  /** Build identifier attached to every error. */
  release?: string;
  /** Install the platform's global error handlers. On by default. */
  captureUncaught?: boolean;
  /** Redact credentials from every event. On by default. */
  scrubEnabled?: boolean;
  /** Extra key names to redact, on top of the built-in denylist. */
  scrubFields?: string[];
  /** Runs on every event before it is queued. Return null to drop it. */
  beforeSend?: (
    payload: Record<string, any>,
  ) => Record<string, any> | null | undefined;
  batchSize?: number;
  /** Seconds between flushes. */
  flushInterval?: number;
  /** Unsent events held before the oldest are discarded. */
  maxQueueSize?: number;
  maxRetry?: number;
  /** Log what the SDK itself is doing. */
  debug?: boolean;
}

/**
 * Defaults tuned for a front end rather than a server.
 *
 * Five seconds, not sixty: a tab is closed or an app is swiped away long before
 * a minute passes, and an error that sits in memory until then is never sent.
 * A smaller queue, because this heap is somebody's phone.
 */
export const LITE_DEFAULTS = {
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

type ResolvedConfig = LiteConfig & typeof LITE_DEFAULTS;

/** What a replay recorder offers the client. */
export interface ReplayHook {
  /**
   * Recording, and able to upload. False once the deployment, the plan or the
   * credentials have refused - an error then must not claim a replay.
   */
  readonly active: boolean;
  /** Upload the window that led to an error. Never throws. */
  flushForError(errorEventId?: string): Promise<string | null>;
  stop(): void;
  diagnostics(): Record<string, unknown>;
}

export interface LitePlatform {
  /** Reported as `context.sdk`. */
  sdkName: string;
  /** Fields only this platform knows, merged into every error's context. */
  platformContext?: () => Record<string, unknown>;
  /** Supply a session id, e.g. one persisted across page loads. */
  sessionId?: string;
  fetchImpl?: FetchLike;
  /** Parse `fn@file:line:col` frames too. Browsers other than Chrome need it. */
  stackOptions?: ParseStackOptions;
}

interface QueuedEvent {
  type: string;
  payload: Record<string, any>;
  timestamp: number;
}

export class LiteClient {
  protected readonly config: ResolvedConfig;
  /** Already in the hashed shape. Joins errors to their replay. */
  readonly sessionId: string;
  protected replay: ReplayHook | null = null;
  protected readonly fetchImpl: FetchLike;

  private readonly sdkName: string;
  private readonly platformContext: () => Record<string, unknown>;
  private readonly stackOptions: ParseStackOptions;
  private readonly scrubber: Scrubber;

  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;
  protected closed = false;

  private droppedEvents = 0;
  private filteredEvents = 0;

  constructor(config: Partial<LiteConfig>, platform: LitePlatform) {
    const resolved = { ...LITE_DEFAULTS, ...config } as ResolvedConfig;
    // Undefined in the caller's object must not erase a default.
    for (const [key, value] of Object.entries(LITE_DEFAULTS)) {
      if ((resolved as any)[key] === undefined) (resolved as any)[key] = value;
    }
    this.config = resolved;

    if (!resolved.apiKey) throw new Error("API key is required");
    if (!resolved.environmentKey) throw new Error("Environment key is required");
    if (!resolved.organizationId) throw new Error("Organization ID is required");
    if (!resolved.ingestUrl) throw new Error("Ingest URL is required");

    const fetchImpl =
      platform.fetchImpl ??
      (typeof (globalThis as any).fetch === "function"
        ? ((globalThis as any).fetch.bind(globalThis) as FetchLike)
        : null);
    if (!fetchImpl) {
      throw new Error("[secploy] fetch is not available in this runtime");
    }
    this.fetchImpl = fetchImpl;

    this.sdkName = platform.sdkName;
    this.platformContext = platform.platformContext ?? (() => ({}));
    this.stackOptions = platform.stackOptions ?? {};
    this.sessionId = platform.sessionId ?? newSessionId();
    this.scrubber = new Scrubber({
      denyKeys: resolved.scrubFields,
      enabled: resolved.scrubEnabled !== false,
    });
  }

  protected diagnostic(message: string): void {
    if (this.config.debug) {
      // eslint-disable-next-line no-console
      console.info(`[secploy] ${message}`);
    }
  }

  protected getHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.config.apiKey,
      "X-Environment-Key": this.config.environmentKey,
      "X-Organization-ID": this.config.organizationId,
    };
  }

  protected get apiUrl(): string {
    return (this.config.apiUrl || LITE_DEFAULTS.apiUrl).replace(/\/+$/, "");
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.drain(this.config.maxRetry);
    }, this.config.flushInterval * 1000);
    // Node only (tests, SSR). A page or an app has no process to hold open.
    (this.timer as any).unref?.();
  }

  /**
   * Queue one event. Never throws.
   *
   * The same door as `EventHandler.sendEvent` in the Node client: the
   * application's hook first, on the real values, then the scrubber, so
   * nothing the hook returns can leave unscrubbed.
   */
  sendEvent(type: string, payload: Record<string, any>): boolean {
    if (this.closed) return false;
    try {
      let prepared: Record<string, any> | null = payload;

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
        } catch (error) {
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
        payload: { event_id: newEventId(), ...(scrubbed as Record<string, any>) },
        timestamp: Date.now(),
      });

      if (this.queue.length >= this.config.batchSize) {
        void this.drain(this.config.maxRetry);
      }
      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[secploy] Failed to queue event:", error);
      return false;
    }
  }

  /**
   * Report an error. Returns the event id, which is also what the replay
   * uploaded for it is indexed under.
   */
  captureException(
    thrown: unknown,
    context: Record<string, unknown> = {},
  ): string | null {
    const { mechanism, handled, level, ...extra } = context;
    return this.report(
      parseError(thrown, defaultModuleOf, this.stackOptions),
      {
        level: String(level ?? "error"),
        mechanism: String(mechanism ?? "manual"),
        handled: handled === undefined ? true : Boolean(handled),
        extra,
      },
    );
  }

  /** Report a message with no exception behind it. */
  captureMessage(
    message: string,
    level: "fatal" | "error" | "warning" | "info" = "info",
    context: Record<string, unknown> = {},
  ): string | null {
    const parsed = parseError(new Error(message), defaultModuleOf, this.stackOptions);
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
  protected report(
    parsed: ParsedError,
    options: {
      level: string;
      mechanism: string;
      handled: boolean;
      extra?: Record<string, unknown>;
    },
  ): string | null {
    if (this.closed) return null;
    try {
      const eventId = newEventId();
      const replay = this.replay;
      const replayActive = Boolean(replay?.active);

      let platformContext: Record<string, unknown> = {};
      try {
        platformContext = this.platformContext();
      } catch {
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
    } catch (failure) {
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
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    const events = this.queue.splice(0);
    for (let i = 0; i < events.length; i += this.config.batchSize) {
      await this.sendBatch(
        events.slice(i, i + this.config.batchSize),
        1,
        Boolean(options.keepalive),
      );
    }
  }

  /** Stop, flush what is left, and release the replay recorder. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.replay?.stop();
    await this.flush();
    this.closed = true;
  }

  diagnostics(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      queued: this.queue.length,
      dropped: this.droppedEvents,
      filtered: this.filteredEvents,
      replay: this.replay?.diagnostics() ?? null,
    };
  }

  private drain(attempts: number): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        while (this.queue.length > 0 && !this.closed) {
          const batch = this.queue.splice(0, this.config.batchSize);
          await this.sendBatch(batch, attempts, false);
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /** Deliver one batch under the shared transport rules. Never throws. */
  private async sendBatch(
    events: QueuedEvent[],
    attempts: number,
    keepalive: boolean,
  ): Promise<void> {
    if (events.length === 0) return;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const { outcome, retryAfterMs } = await this.post(events, keepalive);
      if (outcome === "delivered") return;
      if (outcome === "drop") {
        this.droppedEvents += events.length;
        // eslint-disable-next-line no-console
        console.warn(
          `[secploy] Discarded ${events.length} events the ingest rejected`,
        );
        return;
      }
      if (attempt === attempts - 1 || this.closed) break;
      await new Promise((resolve) =>
        setTimeout(resolve, backoffDelay(attempt, retryAfterMs)),
      );
    }
    this.droppedEvents += events.length;
  }

  private async post(
    events: QueuedEvent[],
    keepalive: boolean,
  ): Promise<{
    outcome: ReturnType<typeof classifyStatus>;
    retryAfterMs: number | null;
  }> {
    try {
      const body = JSON.stringify({ events });
      const response = await fetchWithTimeout(
        this.fetchImpl,
        this.config.ingestUrl,
        {
          method: "POST",
          headers: { ...this.getHeaders(), "Content-Type": "application/json" },
          body,
          credentials: "omit",
          keepalive: keepalive && body.length < 60_000,
        },
        10_000,
      );
      let retryAfter: unknown = null;
      try {
        retryAfter = response.headers?.get?.("retry-after") ?? null;
      } catch {
        retryAfter = null;
      }
      return {
        outcome: classifyStatus(response.status),
        retryAfterMs: parseRetryAfter(retryAfter),
      };
    } catch {
      return { outcome: "retry", retryAfterMs: null };
    }
  }
}
