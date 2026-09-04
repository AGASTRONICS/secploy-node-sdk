"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityPolicyCache = exports.PolicySnapshot = void 0;
const axios_1 = __importDefault(require("axios"));
const realtime_1 = require("./realtime");
const authContext_1 = require("./authContext");
/** Matches the server: a control is enforceable in these states. */
const ACTIVE_CONTROL_STATUSES = new Set(["pending", "applied", "requires_adapter"]);
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
/**
 * How long a snapshot may go unrefreshed before warning. Enforcement continues
 * regardless - a stale policy beats no policy, and working through an outage is
 * the point of caching.
 */
const DEFAULT_MAX_STALENESS_SECONDS = 900;
/**
 * Compile a pattern, or return null when it is not valid regex.
 *
 * The server falls back to exact string comparison when a pattern will not
 * compile, so null here means the caller does the same.
 *
 * No `g` flag: a global RegExp carries lastIndex between calls, which would make
 * repeated tests of the same pattern alternate between matching and not.
 */
function compilePattern(pattern) {
    try {
        return new RegExp(pattern);
    }
    catch {
        return null;
    }
}
function parseDate(value) {
    if (typeof value !== "string" || !value)
        return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
/** One immutable, query-ready view of a project's gate policy. */
class PolicySnapshot {
    constructor(payload) {
        this.version = String(payload?.version ?? "");
        this.generatedAt = payload?.generated_at;
        this.ttlSeconds = Number(payload?.ttl_seconds ?? 300);
        this.fetchedAt = Date.now();
        this.rulesByMethod = new Map();
        let ruleCount = 0;
        for (const rule of payload?.blocked_endpoints ?? []) {
            if (!rule || typeof rule !== "object")
                continue;
            const method = String(rule.method ?? "").trim().toUpperCase();
            const raw = String(rule.path_pattern ?? "");
            const bucket = this.rulesByMethod.get(method) ?? [];
            bucket.push({ regex: compilePattern(raw), raw, rule });
            this.rulesByMethod.set(method, bucket);
            ruleCount += 1;
        }
        this.ruleCount = ruleCount;
        this.controlsByTarget = new Map();
        let controlCount = 0;
        let order = 0;
        for (const control of payload?.controls ?? []) {
            order += 1;
            if (!control || typeof control !== "object")
                continue;
            if (!ACTIVE_CONTROL_STATUSES.has(String(control.status ?? "")))
                continue;
            const targetType = String(control.target_type ?? "").trim();
            const target = String(control.target ?? "").trim();
            if (!targetType || !target)
                continue;
            let scopeRegex = null;
            let scopeRaw = null;
            const scope = control.metadata?.endpoint_scope;
            if (scope && typeof scope === "object") {
                const rawPattern = String(scope.path_pattern ?? "").trim();
                if (rawPattern) {
                    scopeRaw = rawPattern;
                    scopeRegex = compilePattern(rawPattern);
                }
            }
            const key = `${targetType} ${target}`;
            const bucket = this.controlsByTarget.get(key) ?? [];
            bucket.push({ order, control, scopeRegex, scopeRaw });
            this.controlsByTarget.set(key, bucket);
            controlCount += 1;
        }
        this.controlCount = controlCount;
    }
    get ageSeconds() {
        return (Date.now() - this.fetchedAt) / 1000;
    }
}
exports.PolicySnapshot = PolicySnapshot;
/**
 * Port of the server's endpoint-scope check: a control with no `endpoint_scope`
 * stays project-wide, one with a scope applies only to matching methods and paths.
 */
function controlMatchesEndpointScope(indexed, method, endpoint) {
    const scope = indexed.control.metadata?.endpoint_scope;
    if (!scope || typeof scope !== "object")
        return true;
    const scopedMethod = String(scope.method ?? "").trim().toUpperCase();
    if (scopedMethod && scopedMethod !== method)
        return false;
    // Method-only scope, already satisfied.
    if (indexed.scopeRaw === null)
        return true;
    if (indexed.scopeRegex === null)
        return indexed.scopeRaw === endpoint;
    return indexed.scopeRegex.test(endpoint);
}
class SecurityPolicyCache {
    constructor(options) {
        this.snapshotRef = null;
        this.inFlight = null;
        this.realtime = null;
        this.staleWarned = false;
        this.apiUrl = options.apiUrl.replace(/\/$/, "");
        this.getHeaders = options.headersCallback;
        this.maxStaleness = options.maxStaleness ?? DEFAULT_MAX_STALENESS_SECONDS;
    }
    get snapshot() {
        return this.snapshotRef;
    }
    get isLoaded() {
        return this.snapshotRef !== null;
    }
    get version() {
        return this.snapshotRef?.version ?? null;
    }
    /**
     * Pull the current snapshot, or keep the existing one on a 304.
     *
     * Never rejects: a refresh failure must not surface in the host application,
     * it just means the previous snapshot stays in force. Concurrent calls share
     * one request.
     */
    async fetch(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
        if (this.inFlight)
            return this.inFlight;
        this.inFlight = this.doFetch(timeoutMs).finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }
    async doFetch(timeoutMs) {
        const current = this.snapshotRef;
        let headers;
        try {
            headers = { ...this.getHeaders() };
        }
        catch (error) {
            console.warn("[secploy] Security policy fetch: headers failed:", error);
            return current;
        }
        if (current?.version) {
            headers["If-None-Match"] = `"${current.version}"`;
        }
        let response;
        try {
            response = await axios_1.default.get(`${this.apiUrl}/projects/security/policy/`, {
                headers,
                timeout: timeoutMs,
                // 304 is a success for us, and a failed refresh must not throw.
                validateStatus: () => true,
            });
        }
        catch (error) {
            console.warn("[secploy] Security policy fetch failed:", error);
            return current;
        }
        if (response.status === 304) {
            this.staleWarned = false;
            return current;
        }
        if (response.status === 401) {
            console.warn("[secploy] Security policy fetch: invalid API key or environment key.");
            return current;
        }
        if (response.status < 200 || response.status >= 300) {
            console.warn(`[secploy] Security policy fetch failed (${response.status}).`);
            return current;
        }
        const payload = response.data;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            console.warn("[secploy] Security policy response had an unexpected shape.");
            return current;
        }
        let snapshot;
        try {
            snapshot = new PolicySnapshot(payload);
        }
        catch (error) {
            console.warn("[secploy] Security policy snapshot build failed:", error);
            return current;
        }
        this.snapshotRef = snapshot;
        this.staleWarned = false;
        console.info(`[secploy] Security policy loaded: version=${snapshot.version} ` +
            `rules=${snapshot.ruleCount} controls=${snapshot.controlCount}`);
        return snapshot;
    }
    /**
     * Reproduce the API's raw decision payload from the local snapshot.
     *
     * Returns null when no snapshot has loaded yet, so the caller can fall back to
     * a remote lookup instead of guessing at a policy it has not seen.
     */
    evaluate(method, endpoint, auth = {}, projectKey = "", envKey = "") {
        const snapshot = this.snapshotRef;
        if (snapshot === null)
            return null;
        this.warnIfStale(snapshot);
        const rule = this.matchRule(snapshot, method, endpoint);
        // Both spellings are accepted; an unrecognized one would silently match no
        // controls and let the request through.
        const controls = this.matchControls(snapshot, method, endpoint, (0, authContext_1.normalizeAuthContext)(auth), projectKey, envKey);
        const payload = {
            blocked: rule !== null || controls.length > 0,
            method,
            endpoint,
        };
        if (rule !== null) {
            payload.rule = rule;
            payload.reason = "blocked_by_endpoint_rule";
        }
        if (controls.length > 0) {
            payload.controls = controls;
            if (payload.reason === undefined) {
                payload.reason = "blocked_by_control_action";
            }
        }
        return payload;
    }
    /** First matching rule wins, in the snapshot's newest-first order. */
    matchRule(snapshot, method, endpoint) {
        for (const { regex, raw, rule } of snapshot.rulesByMethod.get(method) ?? []) {
            if (regex === null) {
                if (raw === endpoint)
                    return rule;
                continue;
            }
            if (regex.test(endpoint))
                return rule;
        }
        return null;
    }
    /** Match on session, identity, IP or API key, then apply endpoint scoping. */
    matchControls(snapshot, method, endpoint, auth, projectKey, envKey) {
        const clean = (value) => String(value ?? "").trim();
        const identityKey = clean(auth.identityKey);
        const userId = clean(auth.userId);
        const sessionId = clean(auth.sessionId);
        const ipAddress = clean(auth.ipAddress);
        const remoteAddr = clean(auth.remoteAddr);
        const lookups = [];
        const push = (type, value) => {
            if (value)
                lookups.push(`${type} ${value}`);
        };
        push("session", sessionId);
        for (const value of new Set([identityKey, userId]))
            push("identity", value);
        for (const value of new Set([ipAddress, remoteAddr]))
            push("ip", value);
        for (const value of new Set([clean(projectKey), clean(envKey)]))
            push("api_key", value);
        if (lookups.length === 0)
            return [];
        const now = Date.now();
        const matched = new Map();
        for (const key of lookups) {
            for (const indexed of snapshot.controlsByTarget.get(key) ?? []) {
                const controlId = String(indexed.control.id ?? `${key}:${indexed.order}`);
                if (matched.has(controlId))
                    continue;
                // The snapshot can outlive a control's expiry by up to its TTL, so
                // expiry is re-checked here. Enforcing a lapsed control means blocking a
                // request that should now succeed.
                const expiresAt = parseDate(indexed.control.expires_at);
                if (expiresAt !== null && expiresAt.getTime() <= now)
                    continue;
                if (!controlMatchesEndpointScope(indexed, method, endpoint))
                    continue;
                matched.set(controlId, indexed);
            }
        }
        // Restore the server's ordering, which the per-target index does not keep.
        return [...matched.values()]
            .sort((a, b) => a.order - b.order)
            .map((indexed) => indexed.control);
    }
    warnIfStale(snapshot) {
        if (this.staleWarned || snapshot.ageSeconds <= this.maxStaleness)
            return;
        this.staleWarned = true;
        console.warn(`[secploy] Security policy has not refreshed in ${Math.round(snapshot.ageSeconds)}s ` +
            `(version=${snapshot.version}). Still enforcing the last known policy.`);
    }
    startRealtime(wsUrl, headersCallback) {
        if (this.realtime !== null) {
            console.warn("[secploy] Security policy real-time is already running.");
            return;
        }
        this.realtime = new realtime_1.RealtimeChannel({
            wsUrl,
            headersCallback,
            onUpdate: async () => {
                await this.fetch();
            },
            channelName: "security policy",
            updateMessageTypes: ["security.update", "security.subscribed"],
        });
        this.realtime.start();
    }
    stopRealtime() {
        if (this.realtime !== null) {
            this.realtime.stop();
            this.realtime = null;
        }
    }
    get isRealtime() {
        return this.realtime?.isConnected ?? false;
    }
}
exports.SecurityPolicyCache = SecurityPolicyCache;
