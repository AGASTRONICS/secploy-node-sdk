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

import axios from "axios";

import {
  ControlAction,
  DecisionPayload,
  GateMode,
  SecurityGateAuthContext,
  SecurityGateDecision,
} from "./types";
import { SecurityPolicyCache } from "./policyCache";
import { IdentityReporter } from "./identityReporter";
import { normalizeAuthContext } from "./authContext";

/** Thrown when the gate blocks a request. */
export class SecurityGateBlocked extends Error {
  readonly decision: SecurityGateDecision;
  readonly reason: string;
  readonly actionType?: string;
  readonly target?: string;

  constructor(decision: SecurityGateDecision) {
    const controls = decision.controls ?? [];
    const first = controls[0];
    const parts = [`Secploy blocked ${decision.method} ${decision.endpoint}`, decision.reason];
    if (first?.action_type) parts.push(`${first.action_type} -> ${first.target}`);
    super(parts.filter(Boolean).join(" | "));

    this.name = "SecurityGateBlocked";
    this.decision = decision;
    this.reason = decision.reason || "blocked_by_secploy";
    this.actionType = first?.action_type;
    this.target = first?.target;
  }
}

export interface GateRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  headers?: Record<string, any>;
  ip?: string;
  socket?: { remoteAddress?: string };
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
export function normalizeEndpoint(endpoint: string): string {
  const raw = (endpoint ?? "").trim();
  if (!raw) return "";

  let path = raw;
  // Strip scheme/host if a full URL was given, and drop query and fragment.
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(raw);
  if (schemeMatch) {
    path = schemeMatch[1] ?? "/";
  }
  path = path.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

export class SecployGate {
  private readonly options: SecployGateOptions;
  private readonly policy: SecurityPolicyCache;
  private readonly identities: IdentityReporter;

  constructor(options: SecployGateOptions) {
    this.options = options;
    this.policy = options.policyCache;
    this.identities = options.identityReporter;
  }

  private get mode(): GateMode {
    return this.options.gateMode ?? "remote";
  }

  private get failOpen(): boolean {
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
  private decisionFromPayload(
    payload: DecisionPayload | Record<string, any>,
    method: string,
    endpoint: string,
    rawUrl: string,
  ): SecurityGateDecision {
    const blocked = Boolean(payload?.blocked);
    const rule = payload?.rule ?? {};
    const controls: ControlAction[] = payload?.controls ?? payload?.actions ?? [];
    const reason =
      payload?.reason || rule?.reason || (blocked ? "blocked_by_rule" : "allowed");

    return {
      allowed: !blocked,
      blocked,
      method,
      endpoint,
      url: rawUrl,
      reason: String(reason),
      rule: rule && typeof rule === "object" ? rule : {},
      controls: Array.isArray(controls) ? controls : [],
      raw: (payload as Record<string, any>) ?? {},
    };
  }

  private failOpenDecision(
    method: string,
    endpoint: string,
    rawUrl: string,
    reason: string,
  ): SecurityGateDecision {
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
  private async remoteDecision(
    method: string,
    endpoint: string,
    rawUrl: string,
    auth: SecurityGateAuthContext,
  ): Promise<SecurityGateDecision> {
    const params: Record<string, any> = { method, endpoint };
    const wire: Array<[keyof SecurityGateAuthContext, string]> = [
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
      if (value !== undefined && value !== null && value !== "") params[name] = value;
    }

    let response: any;
    try {
      response = await axios.get(
        `${this.options.apiUrl.replace(/\/$/, "")}/projects/endpoints/blocked/check/`,
        {
          headers: this.options.headersCallback(),
          params,
          timeout: this.options.timeoutMs ?? 5000,
          validateStatus: () => true,
        },
      );
    } catch (error) {
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
  private cachedDecision(
    method: string,
    endpoint: string,
    rawUrl: string,
    auth: SecurityGateAuthContext,
  ): SecurityGateDecision | null {
    let payload: DecisionPayload | null;
    try {
      payload = this.policy.evaluate(
        method,
        endpoint,
        auth,
        this.options.apiKey,
        this.options.environmentKey,
      );
    } catch (error) {
      console.warn("[secploy] Local policy evaluation failed:", error);
      return null;
    }
    if (payload === null) return null;

    // The remote path reports identity through its query string; on this path
    // nothing else would, so record it here. Deduplicated and batched, so a
    // repeat visitor costs a map lookup and nothing more.
    try {
      this.identities.record(auth);
    } catch (error) {
      console.warn("[secploy] Identity record failed:", error);
    }

    return this.decisionFromPayload(payload, method, endpoint, rawUrl);
  }

  /** The parts of a decision that have to agree for the cache to be correct. */
  private static signature(decision: SecurityGateDecision): string {
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

  private reportShadowMismatch(
    local: SecurityGateDecision,
    remote: SecurityGateDecision,
    method: string,
    endpoint: string,
  ): void {
    console.warn(
      `[secploy] Gate shadow mismatch on ${method} ${endpoint}: ` +
        `local=${SecployGate.signature(local)} remote=${SecployGate.signature(remote)}`,
    );
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
    } catch (error) {
      console.warn("[secploy] Failed to report shadow mismatch:", error);
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Return the decision for a request without enforcing it. */
  async inspect(
    request: GateRequestLike | { method: string; endpoint: string },
    auth?: SecurityGateAuthContext | Record<string, any>,
    metadata?: Record<string, any>,
  ): Promise<SecurityGateDecision> {
    const method = String((request as any).method ?? "GET").trim().toUpperCase();
    const rawUrl = String(
      (request as any).endpoint ??
        (request as any).originalUrl ??
        (request as any).url ??
        (request as any).path ??
        "",
    );
    const endpoint = normalizeEndpoint(rawUrl);
    const resolvedAuth = auth
      ? normalizeAuthContext(auth)
      : this.resolveAuth(request as GateRequestLike);

    if (!method || !endpoint) {
      return this.failOpenDecision(method, endpoint, rawUrl, "missing_method_or_endpoint");
    }

    let decision: SecurityGateDecision;

    if (this.mode === "cached") {
      const local = this.cachedDecision(method, endpoint, rawUrl, resolvedAuth);
      decision =
        local ??
        // No snapshot yet, usually the first request after start-up. Falling
        // back keeps early requests correct instead of waving them through.
        (await this.remoteDecision(method, endpoint, rawUrl, resolvedAuth));
    } else if (this.mode === "shadow") {
      const local = this.cachedDecision(method, endpoint, rawUrl, resolvedAuth);
      const remote = await this.remoteDecision(method, endpoint, rawUrl, resolvedAuth);
      if (local !== null && remote.reason !== "lookup_unavailable") {
        if (SecployGate.signature(local) !== SecployGate.signature(remote)) {
          this.reportShadowMismatch(local, remote, method, endpoint);
        }
      }
      // The API stays authoritative in shadow mode.
      decision = remote;
    } else {
      decision = await this.remoteDecision(method, endpoint, rawUrl, resolvedAuth);
    }

    if (!this.failOpen && decision.reason === "lookup_unavailable") {
      throw new Error(
        `Secploy decision lookup failed for ${method} ${endpoint}: ${decision.reason}`,
      );
    }

    decision.auth = resolvedAuth;
    decision.metadata = metadata ?? {};
    return decision;
  }

  /** Inspect and throw `SecurityGateBlocked` when the request is not allowed. */
  async check(
    request: GateRequestLike | { method: string; endpoint: string },
    auth?: SecurityGateAuthContext | Record<string, any>,
    metadata?: Record<string, any>,
  ): Promise<SecurityGateDecision> {
    const decision = await this.inspect(request, auth, metadata);
    if (decision.blocked) throw new SecurityGateBlocked(decision);
    return decision;
  }

  /**
   * Read identity off a framework request.
   *
   * Deliberately forgiving, because every codebase attaches its user somewhere
   * different. Pass `identityResolver` to take this over entirely.
   */
  resolveAuth(request: GateRequestLike): SecurityGateAuthContext {
    if (this.options.identityResolver) {
      try {
        return normalizeAuthContext(this.options.identityResolver(request));
      } catch (error) {
        console.warn("[secploy] identityResolver threw; falling back to defaults:", error);
      }
    }

    const headers = request?.headers ?? {};
    const user = request?.user ?? {};
    const session = request?.session ?? {};

    const headerValue = (name: string): string | undefined => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      if (value === undefined || value === null) return undefined;
      return Array.isArray(value) ? value[0] : String(value);
    };

    const forwarded = headerValue("x-forwarded-for");
    const ipAddress =
      (forwarded ? forwarded.split(",")[0].trim() : undefined) ??
      headerValue("x-real-ip") ??
      request?.ip ??
      request?.socket?.remoteAddress;

    const userId = user.id ?? user.userId ?? user.sub ?? session.userId;
    const sessionId = session.id ?? session.sessionId ?? headerValue("x-session-id");

    const auth: SecurityGateAuthContext = {};
    if (userId !== undefined && userId !== null) {
      auth.userId = String(userId);
      auth.identityKey = String(userId);
    }
    if (sessionId !== undefined && sessionId !== null) auth.sessionId = String(sessionId);
    if (ipAddress) {
      auth.ipAddress = String(ipAddress);
      auth.remoteAddr = String(request?.socket?.remoteAddress ?? ipAddress);
    }
    if (user.email) auth.email = String(user.email);
    if (user.name) auth.name = String(user.name);
    if (user.username) auth.username = String(user.username);
    if (user.avatar) auth.avatar = String(user.avatar);
    auth.isAuthenticated = Boolean(userId);

    // Through the normaliser like every other path, rather than returned
    // directly. It is what hashes the session identifier, and a path that
    // skipped it would both ship a live cookie and stop matching controls
    // targeting the hashed value - enforcement failing silently, which is the
    // worst way for a gate to fail.
    return normalizeAuthContext(auth);
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
  express(options: { statusCode?: number; onBlocked?: (req: any, res: any, error: SecurityGateBlocked) => void } = {}) {
    const statusCode = options.statusCode ?? 403;
    return (req: any, res: any, next: any) => {
      this.check(req)
        .then(() => next())
        .catch((error) => {
          if (error instanceof SecurityGateBlocked) {
            if (options.onBlocked) return options.onBlocked(req, res, error);
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
  koa(options: { statusCode?: number } = {}) {
    const statusCode = options.statusCode ?? 403;
    return async (ctx: any, next: any) => {
      try {
        await this.check({
          method: ctx.method,
          url: ctx.url,
          headers: ctx.headers,
          ip: ctx.ip,
          user: ctx.state?.user,
          session: ctx.session,
        });
      } catch (error) {
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
  fastify(options: { statusCode?: number } = {}) {
    const statusCode = options.statusCode ?? 403;
    return async (request: any, reply: any) => {
      try {
        await this.check(request);
      } catch (error) {
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
