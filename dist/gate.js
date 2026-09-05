"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecployGate = exports.SecurityGateBlocked = void 0;
exports.normalizeEndpoint = normalizeEndpoint;
const axios_1 = __importDefault(require("axios"));
const authContext_1 = require("./authContext");
/** Thrown when the gate blocks a request. */
class SecurityGateBlocked extends Error {
    constructor(decision) {
        const controls = decision.controls ?? [];
        const first = controls[0];
        const parts = [
            `Secploy blocked ${decision.method} ${decision.endpoint}`,
            decision.reason,
        ];
        if (first?.action_type)
            parts.push(`${first.action_type} -> ${first.target}`);
        super(parts.filter(Boolean).join(" | "));
        this.name = "SecurityGateBlocked";
        this.decision = decision;
        this.reason = decision.reason || "blocked_by_secploy";
        this.actionType = first?.action_type;
        this.target = first?.target;
    }
}
exports.SecurityGateBlocked = SecurityGateBlocked;
/** Normalize a URL or path to the path-only form the API matches against. */
function normalizeEndpoint(endpoint) {
    const raw = (endpoint ?? "").trim();
    if (!raw)
        return "";
    let path = raw;
    // Strip scheme/host if a full URL was given, and drop query and fragment.
    const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(raw);
    if (schemeMatch) {
        path = schemeMatch[1] ?? "/";
    }
    path = path.split("?")[0].split("#")[0];
    if (!path.startsWith("/"))
        path = `/${path}`;
    return path;
}
class SecployGate {
    constructor(options) {
        this.options = options;
        this.policy = options.policyCache;
        this.identities = options.identityReporter;
    }
    get mode() {
        return this.options.gateMode ?? "remote";
    }
    get failOpen() {
        return this.options.failOpen ?? true;
    }
    // ------------------------------------------------------------------
    // Decision building
    // ------------------------------------------------------------------
    /**
     * Build a gate decision from a raw decision payload.
     *
     * Both the remote lookup and the local policy cache feed this one builder, so
     * a cached decision is identical to the one the API would have returned. Any
     * divergence shows up as a shadow-mode mismatch rather than silently changing
     * what gets blocked.
     */
    decisionFromPayload(payload, method, endpoint, rawUrl) {
        const blocked = Boolean(payload?.blocked);
        const rule = payload?.rule ?? {};
        const controls = payload?.controls ?? payload?.actions ?? [];
        const reason = payload?.reason ||
            rule?.reason ||
            (blocked ? "blocked_by_rule" : "allowed");
        return {
            allowed: !blocked,
            blocked,
            method,
            endpoint,
            url: rawUrl,
            reason: String(reason),
            rule: rule && typeof rule === "object" ? rule : {},
            controls: Array.isArray(controls) ? controls : [],
            raw: payload ?? {},
        };
    }
    failOpenDecision(method, endpoint, rawUrl, reason) {
        return {
            allowed: true,
            blocked: false,
            method,
            endpoint,
            url: rawUrl,
            reason,
            rule: {},
            controls: [],
            raw: {},
        };
    }
    // ------------------------------------------------------------------
    // Lookups
    // ------------------------------------------------------------------
    /** Ask the API. One network round trip per call. */
    async remoteDecision(method, endpoint, rawUrl, auth) {
        const params = { method, endpoint };
        const wire = [
            ["identityKey", "identity_key"],
            ["userId", "user_id"],
            ["sessionId", "session_id"],
            ["authProvider", "auth_provider"],
            ["ipAddress", "ip_address"],
            ["remoteAddr", "remote_addr"],
            ["name", "name"],
            ["username", "username"],
            ["avatar", "avatar"],
            ["email", "email"],
            ["isAuthenticated", "is_authenticated"],
        ];
        for (const [field, name] of wire) {
            const value = auth[field];
            if (value !== undefined && value !== null && value !== "")
                params[name] = value;
        }
        let response;
        try {
            response = await axios_1.default.get(`${this.options.apiUrl.replace(/\/$/, "")}/projects/endpoints/blocked/check/`, {
                headers: this.options.headersCallback(),
                params,
                timeout: this.options.timeoutMs ?? 5000,
                validateStatus: () => true,
            });
        }
        catch (error) {
            console.warn(`[secploy] Gate lookup failed for ${method} ${endpoint}:`, error);
            return this.failOpenDecision(method, endpoint, rawUrl, "lookup_unavailable");
        }
        if (response.status < 200 || response.status >= 300) {
            return this.failOpenDecision(method, endpoint, rawUrl, `http_${response.status}`);
        }
        if (!response.data || typeof response.data !== "object") {
            return this.failOpenDecision(method, endpoint, rawUrl, "invalid_response_payload");
        }
        return this.decisionFromPayload(response.data, method, endpoint, rawUrl);
    }
    /** Decide from the in-process snapshot. No I/O. Null if none has loaded yet. */
    cachedDecision(method, endpoint, rawUrl, auth) {
        let payload;
        try {
            payload = this.policy.evaluate(method, endpoint, auth, this.options.apiKey, this.options.environmentKey);
        }
        catch (error) {
            console.warn("[secploy] Local policy evaluation failed:", error);
            return null;
        }
        if (payload === null)
            return null;
        // The remote path reports identity through its query string; on this path
        // nothing else would, so record it here. Deduplicated and batched, so a
        // repeat visitor costs a map lookup and nothing more.
        try {
            this.identities.record(auth);
        }
        catch (error) {
            console.warn("[secploy] Identity record failed:", error);
        }
        return this.decisionFromPayload(payload, method, endpoint, rawUrl);
    }
    /** The parts of a decision that have to agree for the cache to be correct. */
    static signature(decision) {
        const controlIds = (decision.controls ?? [])
            .map((c) => String(c?.id ?? ""))
            .sort()
            .join(",");
        return [
            decision.blocked,
            decision.reason ?? "",
            decision.rule?.id ?? "",
            controlIds,
        ].join("|");
    }
    reportShadowMismatch(local, remote, method, endpoint) {
        console.warn(`[secploy] Gate shadow mismatch on ${method} ${endpoint}: ` +
            `local=${SecployGate.signature(local)} remote=${SecployGate.signature(remote)}`);
        try {
            this.options.sendEvent?.("secploy.gate.shadow_mismatch", {
                method,
                endpoint,
                policy_version: this.policy.version,
                local: {
                    blocked: local.blocked,
                    reason: local.reason,
                    rule_id: local.rule?.id ?? "",
                    control_ids: (local.controls ?? []).map((c) => c?.id ?? ""),
                },
                remote: {
                    blocked: remote.blocked,
                    reason: remote.reason,
                    rule_id: remote.rule?.id ?? "",
                    control_ids: (remote.controls ?? []).map((c) => c?.id ?? ""),
                },
            });
        }
        catch (error) {
            console.warn("[secploy] Failed to report shadow mismatch:", error);
        }
    }
    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    /** Return the decision for a request without enforcing it. */
    async inspect(request, auth, metadata) {
        const method = String(request.method ?? "GET")
            .trim()
            .toUpperCase();
        const rawUrl = String(request.endpoint ??
            request.originalUrl ??
            request.url ??
            request.path ??
            "");
        const endpoint = normalizeEndpoint(rawUrl);
        const resolvedAuth = auth
            ? (0, authContext_1.normalizeAuthContext)(auth)
            : this.resolveAuth(request);
        if (!method || !endpoint) {
            return this.failOpenDecision(method, endpoint, rawUrl, "missing_method_or_endpoint");
        }
        let decision;
        if (this.mode === "cached") {
            const local = this.cachedDecision(method, endpoint, rawUrl, resolvedAuth);
            decision =
                local ??
                    // No snapshot yet, usually the first request after start-up. Falling
                    // back keeps early requests correct instead of waving them through.
                    (await this.remoteDecision(method, endpoint, rawUrl, resolvedAuth));
        }
        else if (this.mode === "shadow") {
            const local = this.cachedDecision(method, endpoint, rawUrl, resolvedAuth);
            const remote = await this.remoteDecision(method, endpoint, rawUrl, resolvedAuth);
            if (local !== null && remote.reason !== "lookup_unavailable") {
                if (SecployGate.signature(local) !== SecployGate.signature(remote)) {
                    this.reportShadowMismatch(local, remote, method, endpoint);
                }
            }
            // The API stays authoritative in shadow mode.
            decision = remote;
        }
        else {
            decision = await this.remoteDecision(method, endpoint, rawUrl, resolvedAuth);
        }
        if (!this.failOpen && decision.reason === "lookup_unavailable") {
            throw new Error(`Secploy decision lookup failed for ${method} ${endpoint}: ${decision.reason}`);
        }
        decision.auth = resolvedAuth;
        decision.metadata = metadata ?? {};
        return decision;
    }
    /** Inspect and throw `SecurityGateBlocked` when the request is not allowed. */
    async check(request, auth, metadata) {
        const decision = await this.inspect(request, auth, metadata);
        if (decision.blocked)
            throw new SecurityGateBlocked(decision);
        return decision;
    }
    /**
     * Read identity off a framework request.
     *
     * Deliberately forgiving, because every codebase attaches its user somewhere
     * different. Pass `identityResolver` to take this over entirely.
     */
    resolveAuth(request) {
        if (this.options.identityResolver) {
            try {
                return (0, authContext_1.normalizeAuthContext)(this.options.identityResolver(request));
            }
            catch (error) {
                console.warn("[secploy] identityResolver threw; falling back to defaults:", error);
            }
        }
        const headers = request?.headers ?? {};
        const user = request?.user ?? {};
        const session = request?.session ?? {};
        const headerValue = (name) => {
            const value = headers[name] ?? headers[name.toLowerCase()];
            if (value === undefined || value === null)
                return undefined;
            return Array.isArray(value) ? value[0] : String(value);
        };
        const forwarded = headerValue("x-forwarded-for");
        const ipAddress = (forwarded ? forwarded.split(",")[0].trim() : undefined) ??
            headerValue("x-real-ip") ??
            request?.ip ??
            request?.socket?.remoteAddress;
        const userId = user.id ?? user.userId ?? user.sub ?? session.userId;
        const sessionId = session.id ?? session.sessionId ?? headerValue("x-session-id");
        const auth = {};
        if (userId !== undefined && userId !== null) {
            auth.userId = String(userId);
            auth.identityKey = String(userId);
        }
        if (sessionId !== undefined && sessionId !== null)
            auth.sessionId = String(sessionId);
        if (ipAddress) {
            auth.ipAddress = String(ipAddress);
            auth.remoteAddr = String(request?.socket?.remoteAddress ?? ipAddress);
        }
        if (user.email)
            auth.email = String(user.email);
        if (user.name)
            auth.name = String(user.name);
        if (user.username)
            auth.username = String(user.username);
        if (user.avatar)
            auth.avatar = String(user.avatar);
        auth.isAuthenticated = Boolean(userId);
        // Through the normaliser like every other path, rather than returned
        // directly. It is what hashes the session identifier, and a path that
        // skipped it would both ship a live cookie and stop matching controls
        // targeting the hashed value - enforcement failing silently, which is the
        // worst way for a gate to fail.
        return (0, authContext_1.normalizeAuthContext)(auth);
    }
    // ------------------------------------------------------------------
    // Framework adapters
    // ------------------------------------------------------------------
    /**
     * Express / Connect middleware.
     *
     * Blocked requests get a 403 and never reach the route. Gate failures call
     * `next()` so an outage cannot take the application down with it.
     */
    express(options = {}) {
        const statusCode = options.statusCode ?? 403;
        return (req, res, next) => {
            this.check(req)
                .then(() => next())
                .catch((error) => {
                if (error instanceof SecurityGateBlocked) {
                    if (options.onBlocked)
                        return options.onBlocked(req, res, error);
                    return res.status(statusCode).json({
                        error: "Forbidden",
                        reason: error.reason,
                        controls: error.decision.controls?.map((c) => c.action_type) ?? [],
                    });
                }
                next(error);
            });
        };
    }
    /** Koa middleware. */
    koa(options = {}) {
        const statusCode = options.statusCode ?? 403;
        return async (ctx, next) => {
            try {
                await this.check({
                    method: ctx.method,
                    url: ctx.url,
                    headers: ctx.headers,
                    ip: ctx.ip,
                    user: ctx.state?.user,
                    session: ctx.session,
                });
            }
            catch (error) {
                if (error instanceof SecurityGateBlocked) {
                    ctx.status = statusCode;
                    ctx.body = { error: "Forbidden", reason: error.reason };
                    return;
                }
                throw error;
            }
            await next();
        };
    }
    /** Fastify onRequest hook. */
    fastify(options = {}) {
        const statusCode = options.statusCode ?? 403;
        return async (request, reply) => {
            try {
                await this.check(request);
            }
            catch (error) {
                if (error instanceof SecurityGateBlocked) {
                    return reply
                        .status(statusCode)
                        .send({ error: "Forbidden", reason: error.reason });
                }
                throw error;
            }
        };
    }
}
exports.SecployGate = SecployGate;
