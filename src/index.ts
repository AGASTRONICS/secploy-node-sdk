import { SecployConfig, LogLevel, LogHandler } from "./types";
import { DEFAULT_MAX_QUEUE_SIZE, EventQueue, EventHandler } from "./events";
import { Scrubber } from "./scrubbing";
import { EventProcessor } from "./processor";
import { SecurityPolicyCache } from "./policyCache";
import { IdentityReporter } from "./identityReporter";
import { SecployGate } from "./gate";
import { ParsedError, parseError } from "./errors";
import { GlobalErrorHandlers } from "./instrument";
import {
  expressErrorHandler,
  fastifyErrorHandler,
  koaErrorHandler,
} from "./errorHandlers";

const DEFAULT_CONFIG: Partial<SecployConfig> = {
  environment: "development",
  samplingRate: 1.0,
  maxRetry: 5,
  debug: false,
  logLevel: LogLevel.INFO,
  batchSize: 100,
  flushInterval: 60,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
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

const GATE_MODES = ["remote", "cached", "shadow"] as const;

/** Severity order, for comparing against the configured logLevel. */
const LEVEL_ORDER: Record<string, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARNING]: 2,
  [LogLevel.ERROR]: 3,
  [LogLevel.CRITICAL]: 4,
};

/**
 * JSON.stringify that cannot throw.
 *
 * A logged object may be circular or carry a getter that raises; neither is a
 * reason for the log line to be lost.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export class Secploy {
  private readonly config: SecployConfig;
  private eventQueue: EventQueue;
  private eventHandler: EventHandler;
  private eventProcessor: EventProcessor;
  private logHandlers: Set<LogHandler> = new Set();

  /** Cached gate policy. Populated only when gateMode is not "remote". */
  readonly securityPolicy: SecurityPolicyCache;
  /** Batched, deduplicated identity telemetry. */
  readonly identities: IdentityReporter;
  /** The request gate. */
  readonly gate: SecployGate;

  private globalHandlers: GlobalErrorHandlers | null = null;
  /** Set while restoring console, so uninstall puts back exactly what we took. */
  private restoreConsole: (() => void) | null = null;

  constructor(config: Partial<SecployConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as SecployConfig;

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
    if (!GATE_MODES.includes(this.config.gateMode as any)) {
      throw new Error(
        `Invalid gateMode: ${this.config.gateMode}. Must be one of: ${GATE_MODES.join(", ")}.`,
      );
    }

    this.eventQueue = new EventQueue(this.config.maxQueueSize);
    // Credentials never leave the process. See scrubbing.ts for what counts as
    // one, and why identifiers deliberately do not.
    this.eventHandler = new EventHandler(
      this.eventQueue,
      new Scrubber({
        denyKeys: this.config.scrubFields,
        enabled: this.config.scrubEnabled !== false,
      }),
      this.config.beforeSend,
      // Applied at last. It has been in the configuration - documented and
      // defaulted - and never read, so a project that turned its volume down
      // was still sending all of it.
      this.config.samplingRate,
    );
    this.eventProcessor = new EventProcessor(
      this.eventQueue,
      this.config.ingestUrl,
      () => this.getHeaders(),
      this.config.batchSize,
      this.config.flushInterval,
      this.config.maxRetry,
    );

    const apiUrl = (this.config.apiUrl ?? "https://api.secploy.com").replace(
      /\/$/,
      "",
    );

    this.securityPolicy = new SecurityPolicyCache({
      apiUrl,
      headersCallback: () => this.getHeaders(),
      maxStaleness: this.config.maxPolicyStaleness,
    });

    // With the gate cached there is no per-request call to carry identity to
    // the API, so it is batched and deduplicated here instead.
    this.identities = new IdentityReporter({
      apiUrl,
      headersCallback: () => this.getHeaders(),
      reportInterval: this.config.identityReportInterval,
      flushInterval: this.config.identityFlushInterval,
    });

    this.gate = new SecployGate({
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
  private startSecurityPolicy(): void {
    const wsUrl =
      (this.config.apiUrl ?? "https://api.secploy.com")
        .replace(/\/$/, "")
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://") + "/ws/sdk/security/";

    this.securityPolicy
      .fetch()
      .catch((error) =>
        console.warn("[secploy] Initial security policy fetch failed:", error),
      )
      .then(() => {
        if (!this.config.realtime) return;
        try {
          this.securityPolicy.startRealtime(wsUrl, () => this.getHeaders());
        } catch (error) {
          console.warn(
            "[secploy] Security policy real-time failed to start:",
            error,
          );
        }
      });

    this.identities.start();
  }

  private getHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.config.apiKey,
      "X-Environment-Key": this.config.environmentKey,
      "X-Organization-ID": this.config.organizationId,
      "Content-Type": "application/json",
    };
  }

  private setupLogging(): void {
    const logLevels: Record<string, LogLevel> = {
      log: LogLevel.INFO,
      info: LogLevel.INFO,
      warn: LogLevel.WARNING,
      error: LogLevel.ERROR,
      debug: LogLevel.DEBUG,
    };

    // `logLevel` was declared, defaulted, and never read: every console level
    // was captured whatever it was set to, so an application asking for errors
    // only still shipped its debug output.
    const threshold = LEVEL_ORDER[this.config.logLevel ?? LogLevel.INFO] ?? 0;

    // Capture the exact functions being replaced, so stop() can put those back
    // rather than a snapshot of whatever console looked like. If another
    // library patched console after us, restoring a copy would silently undo
    // their instrumentation too.
    const originals: Record<string, unknown> = {};

    Object.entries(logLevels).forEach(([method, level]) => {
      const original = (console as any)[method];
      originals[method] = original;

      // Below the configured level: leave the method alone entirely rather
      // than wrapping it and discarding the result, so quiet levels cost
      // nothing at all.
      if ((LEVEL_ORDER[level] ?? 0) < threshold) {
        delete originals[method];
        return;
      }

      (console as any)[method] = (...args: any[]) => {
        // The application's own output goes out first and unchanged. Whatever
        // happens below must never come between a developer and their logs.
        if (typeof original === "function") original.apply(console, args);

        try {
          const message = args
            .map((arg) =>
              typeof arg === "object" ? safeStringify(arg) : String(arg),
            )
            .join(" ");

          this.logHandlers.forEach((handler) => {
            handler.handleLog(level, message);
          });

          // An error logged rather than thrown is still an error. Without this
          // the most common way applications record a handled failure -
          // console.error(err) - produced a log line and no issue.
          if (level === LogLevel.ERROR) {
            const thrown = args.find((arg) => arg instanceof Error);
            if (thrown) {
              this.reportError(parseError(thrown), {
                mechanism: "console",
                handled: true,
                level: "error",
              });
            }
          }
        } catch {
          // Capturing a log must never break logging.
        }
      };
    });

    this.restoreConsole = () => {
      Object.entries(originals).forEach(([method, original]) => {
        (console as any)[method] = original;
      });
    };
  }

  /**
   * Report a parsed error as an event.
   *
   * One place builds the payload so a crash, a console.error and an explicit
   * captureException all arrive in the same shape and group together.
   */
  private reportError(
    parsed: ParsedError,
    context: Record<string, unknown> = {},
  ): string | null {
    try {
      const payload: Record<string, any> = {
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
          ...(context.extra as Record<string, unknown> | undefined),
          mechanism: context.mechanism ?? "manual",
          handled: context.handled ?? true,
        },
      };

      this.sendEvent(String(context.level ?? "error"), payload);
      return parsed.type;
    } catch (failure) {
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
  captureException(
    thrown: unknown,
    context: Record<string, unknown> = {},
  ): void {
    this.reportError(parseError(thrown), {
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
      express: () => expressErrorHandler(this),
      koa: () => koaErrorHandler(this),
      fastify: () => fastifyErrorHandler(this),
    };
  }

  captureMessage(
    message: string,
    level: "fatal" | "error" | "warning" | "info" = "info",
    context: Record<string, unknown> = {},
  ): void {
    const carrier = new Error(message);
    const parsed = parseError(carrier);
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

  registerLogHandler(handler: LogHandler): void {
    this.logHandlers.add(handler);
  }

  unregisterLogHandler(handler: LogHandler): void {
    this.logHandlers.delete(handler);
  }

  sendEvent(eventType: string, payload: Record<string, any>): boolean {
    return this.eventHandler.sendEvent(eventType, payload);
  }

  start(): void {
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
      console.info(
        `[secploy] started: gate=${this.config.gateMode} ` +
          `sampling=${this.config.samplingRate} ` +
          `scrubbing=${this.config.scrubEnabled !== false} ` +
          `queue=${this.eventQueue.maxSize()} ` +
          `captureUncaught=${this.config.captureUncaught} ` +
          `release=${this.config.release ?? "unset"}`,
      );
    }

    // The crashes worth having are the ones nobody anticipated.
    if (this.config.captureUncaught && !this.globalHandlers) {
      this.globalHandlers = new GlobalErrorHandlers({
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
  async flush(): Promise<void> {
    await this.eventProcessor.flushNow();
  }

  async stop(): Promise<void> {
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

export {
  expressErrorHandler,
  fastifyErrorHandler,
  koaErrorHandler,
} from "./errorHandlers";
export type { ErrorReporter, RequestLike } from "./errorHandlers";
export { parseError, parseStack, normalizeError, culpritFrom } from "./errors";
export type { ParsedError, StackFrame } from "./errors";
export { GlobalErrorHandlers } from "./instrument";
export { SecployGate, SecurityGateBlocked, normalizeEndpoint } from "./gate";
export type { GateRequestLike, SecployGateOptions } from "./gate";
export { SecurityPolicyCache, PolicySnapshot } from "./policyCache";
export { IdentityReporter } from "./identityReporter";
export { RealtimeChannel } from "./realtime";
export { normalizeAuthContext } from "./authContext";
export { shouldSend, neverSampled, actorKey, bucket } from "./sampling";
export {
  Scrubber,
  hashSessionId,
  scrubString,
  normalizeKey,
  REDACTED,
} from "./scrubbing";
export type { ScrubberOptions } from "./scrubbing";
export type { BeforeSend } from "./events";
export type {
  BlockedEndpointRule,
  ControlAction,
  DecisionPayload,
  GateMode,
  PolicyPayload,
  SecployConfig,
  SecurityGateAuthContext,
  SecurityGateDecision,
} from "./types";
export { LogLevel } from "./types";
