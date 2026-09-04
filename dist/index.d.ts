import { SecployConfig, LogHandler } from "./types";
import { SecurityPolicyCache } from "./policyCache";
import { IdentityReporter } from "./identityReporter";
import { SecployGate } from "./gate";
export declare class Secploy {
    private readonly config;
    private eventQueue;
    private eventHandler;
    private eventProcessor;
    private logHandlers;
    /** Cached gate policy. Populated only when gateMode is not "remote". */
    readonly securityPolicy: SecurityPolicyCache;
    /** Batched, deduplicated identity telemetry. */
    readonly identities: IdentityReporter;
    /** The request gate. */
    readonly gate: SecployGate;
    private globalHandlers;
    /** Set while restoring console, so uninstall puts back exactly what we took. */
    private restoreConsole;
    constructor(config: Partial<SecployConfig>);
    /**
     * Load the policy snapshot and subscribe to changes.
     *
     * The first fetch is not awaited, so constructing the client never blocks the
     * application on a network call. Until it lands the gate falls back to a
     * remote lookup, so requests are decided correctly from the very first one
     * rather than being waved through.
     */
    private startSecurityPolicy;
    private getHeaders;
    private setupLogging;
    /**
     * Report a parsed error as an event.
     *
     * One place builds the payload so a crash, a console.error and an explicit
     * captureException all arrive in the same shape and group together.
     */
    private reportError;
    /**
     * Report an error that was caught and handled.
     *
     * Accepts anything: JavaScript permits throwing any value, and a rejected
     * promise carrying a plain object is not unusual. Whatever arrives becomes a
     * report rather than a second failure inside the reporter.
     */
    captureException(thrown: unknown, context?: Record<string, unknown>): void;
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
    get errorHandler(): {
        express: () => (error: unknown, req: import("./errorHandlers").RequestLike, _res: unknown, next: (error?: unknown) => void) => void;
        koa: () => (ctx: {
            request?: import("./errorHandlers").RequestLike;
        } & import("./errorHandlers").RequestLike, next: () => Promise<void>) => Promise<void>;
        fastify: () => (request: import("./errorHandlers").RequestLike, _reply: unknown, error: unknown, done?: () => void) => void;
    };
    captureMessage(message: string, level?: "fatal" | "error" | "warning" | "info", context?: Record<string, unknown>): void;
    registerLogHandler(handler: LogHandler): void;
    unregisterLogHandler(handler: LogHandler): void;
    sendEvent(eventType: string, payload: Record<string, any>): boolean;
    start(): void;
    /**
     * Deliver whatever is queued, without shutting anything down.
     *
     * Separate from stop() because a serverless handler or a crash path wants the
     * events out but the client still usable.
     */
    flush(): Promise<void>;
    stop(): Promise<void>;
}
export { expressErrorHandler, fastifyErrorHandler, koaErrorHandler, } from "./errorHandlers";
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
export { Scrubber, hashSessionId, scrubString, normalizeKey, REDACTED } from "./scrubbing";
export type { ScrubberOptions } from "./scrubbing";
export type { BeforeSend } from "./events";
export type { BlockedEndpointRule, ControlAction, DecisionPayload, GateMode, PolicyPayload, SecployConfig, SecurityGateAuthContext, SecurityGateDecision, } from "./types";
export { LogLevel } from "./types";
