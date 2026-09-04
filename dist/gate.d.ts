/**
 * The Secploy request gate.
 *
 * Decides whether a request may proceed, and enforces the decision. Allowed
 * requests pass through untouched; blocked ones raise `SecurityGateBlocked` or
 * short-circuit the framework's response, depending on how the gate is used.
 *
 * Three modes, set by `gateMode` on the client config:
 *
 * - `remote` asks the API on every gated request. This is the default, so
 *   adopting the gate never silently changes how an app already behaves.
 * - `cached` decides from the local policy snapshot with no network call.
 * - `shadow` decides both ways, reports any disagreement, and returns the
 *   remote answer. Run this first to prove the cache agrees with the API.
 */
import { GateMode, SecurityGateAuthContext, SecurityGateDecision } from "./types";
import { SecurityPolicyCache } from "./policyCache";
import { IdentityReporter } from "./identityReporter";
/** Thrown when the gate blocks a request. */
export declare class SecurityGateBlocked extends Error {
    readonly decision: SecurityGateDecision;
    readonly reason: string;
    readonly actionType?: string;
    readonly target?: string;
    constructor(decision: SecurityGateDecision);
}
export interface GateRequestLike {
    method?: string;
    url?: string;
    originalUrl?: string;
    path?: string;
    headers?: Record<string, any>;
    ip?: string;
    socket?: {
        remoteAddress?: string;
    };
    user?: Record<string, any>;
    session?: Record<string, any>;
    [key: string]: any;
}
export interface SecployGateOptions {
    apiUrl: string;
    apiKey: string;
    environmentKey: string;
    headersCallback: () => Record<string, string>;
    policyCache: SecurityPolicyCache;
    identityReporter: IdentityReporter;
    gateMode?: GateMode;
    failOpen?: boolean;
    timeoutMs?: number;
    sendEvent?: (eventType: string, payload: Record<string, any>) => void;
    /** Override how identity is read off a framework request object. */
    identityResolver?: (request: GateRequestLike) => SecurityGateAuthContext;
}
/** Normalize a URL or path to the path-only form the API matches against. */
export declare function normalizeEndpoint(endpoint: string): string;
export declare class SecployGate {
    private readonly options;
    private readonly policy;
    private readonly identities;
    constructor(options: SecployGateOptions);
    private get mode();
    private get failOpen();
    /**
     * Build a gate decision from a raw decision payload.
     *
     * Both the remote lookup and the local policy cache feed this one builder, so
     * a cached decision is identical to the one the API would have returned. Any
     * divergence shows up as a shadow-mode mismatch rather than silently changing
     * what gets blocked.
     */
    private decisionFromPayload;
    private failOpenDecision;
    /** Ask the API. One network round trip per call. */
    private remoteDecision;
    /** Decide from the in-process snapshot. No I/O. Null if none has loaded yet. */
    private cachedDecision;
    /** The parts of a decision that have to agree for the cache to be correct. */
    private static signature;
    private reportShadowMismatch;
    /** Return the decision for a request without enforcing it. */
    inspect(request: GateRequestLike | {
        method: string;
        endpoint: string;
    }, auth?: SecurityGateAuthContext | Record<string, any>, metadata?: Record<string, any>): Promise<SecurityGateDecision>;
    /** Inspect and throw `SecurityGateBlocked` when the request is not allowed. */
    check(request: GateRequestLike | {
        method: string;
        endpoint: string;
    }, auth?: SecurityGateAuthContext | Record<string, any>, metadata?: Record<string, any>): Promise<SecurityGateDecision>;
    /**
     * Read identity off a framework request.
     *
     * Deliberately forgiving, because every codebase attaches its user somewhere
     * different. Pass `identityResolver` to take this over entirely.
     */
    resolveAuth(request: GateRequestLike): SecurityGateAuthContext;
    /**
     * Express / Connect middleware.
     *
     * Blocked requests get a 403 and never reach the route. Gate failures call
     * `next()` so an outage cannot take the application down with it.
     */
    express(options?: {
        statusCode?: number;
        onBlocked?: (req: any, res: any, error: SecurityGateBlocked) => void;
    }): (req: any, res: any, next: any) => void;
    /** Koa middleware. */
    koa(options?: {
        statusCode?: number;
    }): (ctx: any, next: any) => Promise<void>;
    /** Fastify onRequest hook. */
    fastify(options?: {
        statusCode?: number;
    }): (request: any, reply: any) => Promise<any>;
}
