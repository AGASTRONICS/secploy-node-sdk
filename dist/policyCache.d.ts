/**
 * Local security policy cache for the Secploy gate.
 *
 * Without it the gate asks the API whether each individual request is allowed,
 * which puts a network round trip on the caller's request path - and, on the
 * server, a tenant lookup, a schema switch, and rule matching per request. This
 * holds the whole policy in process instead, so a gate decision is a map lookup
 * and a pre-compiled regex.
 *
 * Correctness rests on one rule: the decision must match what the API would have
 * returned. `evaluate()` therefore reproduces the server's raw response payload
 * rather than a decision object, and the gate builds the final decision from that
 * payload using the same code it uses for a remote response. One decision
 * builder, two payload sources - which is what makes shadow mode a real
 * comparison instead of two implementations drifting apart.
 */
import { BlockedEndpointRule, ControlAction, DecisionPayload, PolicyPayload, SecurityGateAuthContext } from "./types";
interface CompiledRule {
    regex: RegExp | null;
    raw: string;
    rule: BlockedEndpointRule;
}
interface IndexedControl {
    order: number;
    control: ControlAction;
    scopeRegex: RegExp | null;
    scopeRaw: string | null;
}
/** One immutable, query-ready view of a project's gate policy. */
export declare class PolicySnapshot {
    readonly version: string;
    readonly generatedAt?: string;
    readonly ttlSeconds: number;
    readonly fetchedAt: number;
    readonly rulesByMethod: Map<string, CompiledRule[]>;
    readonly controlsByTarget: Map<string, IndexedControl[]>;
    readonly ruleCount: number;
    readonly controlCount: number;
    constructor(payload: PolicyPayload);
    get ageSeconds(): number;
}
export interface SecurityPolicyCacheOptions {
    apiUrl: string;
    headersCallback: () => Record<string, string>;
    maxStaleness?: number;
}
export declare class SecurityPolicyCache {
    private apiUrl;
    private getHeaders;
    private maxStaleness;
    private snapshotRef;
    private inFlight;
    private realtime;
    private staleWarned;
    constructor(options: SecurityPolicyCacheOptions);
    get snapshot(): PolicySnapshot | null;
    get isLoaded(): boolean;
    get version(): string | null;
    /**
     * Pull the current snapshot, or keep the existing one on a 304.
     *
     * Never rejects: a refresh failure must not surface in the host application,
     * it just means the previous snapshot stays in force. Concurrent calls share
     * one request.
     */
    fetch(timeoutMs?: number): Promise<PolicySnapshot | null>;
    private doFetch;
    /**
     * Reproduce the API's raw decision payload from the local snapshot.
     *
     * Returns null when no snapshot has loaded yet, so the caller can fall back to
     * a remote lookup instead of guessing at a policy it has not seen.
     */
    evaluate(method: string, endpoint: string, auth?: SecurityGateAuthContext | Record<string, any>, projectKey?: string, envKey?: string): DecisionPayload | null;
    /** First matching rule wins, in the snapshot's newest-first order. */
    private matchRule;
    /** Match on session, identity, IP or API key, then apply endpoint scoping. */
    private matchControls;
    private warnIfStale;
    startRealtime(wsUrl: string, headersCallback: () => Record<string, string>): void;
    stopRealtime(): void;
    get isRealtime(): boolean;
}
export {};
