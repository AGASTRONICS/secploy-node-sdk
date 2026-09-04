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

import axios from "axios";

import {
  BlockedEndpointRule,
  ControlAction,
  DecisionPayload,
  PolicyPayload,
  SecurityGateAuthContext,
} from "./types";
import { RealtimeChannel } from "./realtime";
import { normalizeAuthContext } from "./authContext";

/** Matches the server: a control is enforceable in these states. */
const ACTIVE_CONTROL_STATUSES = new Set(["pending", "applied", "requires_adapter"]);

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * How long a snapshot may go unrefreshed before warning. Enforcement continues
 * regardless - a stale policy beats no policy, and working through an outage is
 * the point of caching.
 */
const DEFAULT_MAX_STALENESS_SECONDS = 900;

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

/**
 * Compile a pattern, or return null when it is not valid regex.
 *
 * The server falls back to exact string comparison when a pattern will not
 * compile, so null here means the caller does the same.
 *
 * No `g` flag: a global RegExp carries lastIndex between calls, which would make
 * repeated tests of the same pattern alternate between matching and not.
 */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** One immutable, query-ready view of a project's gate policy. */
export class PolicySnapshot {
  readonly version: string;
  readonly generatedAt?: string;
  readonly ttlSeconds: number;
  readonly fetchedAt: number;
  readonly rulesByMethod: Map<string, CompiledRule[]>;
  readonly controlsByTarget: Map<string, IndexedControl[]>;
  readonly ruleCount: number;
  readonly controlCount: number;

  constructor(payload: PolicyPayload) {
    this.version = String(payload?.version ?? "");
    this.generatedAt = payload?.generated_at;
    this.ttlSeconds = Number(payload?.ttl_seconds ?? 300);
    this.fetchedAt = Date.now();

    this.rulesByMethod = new Map();
    let ruleCount = 0;
    for (const rule of payload?.blocked_endpoints ?? []) {
      if (!rule || typeof rule !== "object") continue;
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
      if (!control || typeof control !== "object") continue;
      if (!ACTIVE_CONTROL_STATUSES.has(String(control.status ?? ""))) continue;

      const targetType = String(control.target_type ?? "").trim();
      const target = String(control.target ?? "").trim();
      if (!targetType || !target) continue;

      let scopeRegex: RegExp | null = null;
      let scopeRaw: string | null = null;
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

  get ageSeconds(): number {
    return (Date.now() - this.fetchedAt) / 1000;
  }
}

/**
 * Port of the server's endpoint-scope check: a control with no `endpoint_scope`
 * stays project-wide, one with a scope applies only to matching methods and paths.
 */
function controlMatchesEndpointScope(
  indexed: IndexedControl,
  method: string,
  endpoint: string,
): boolean {
  const scope = indexed.control.metadata?.endpoint_scope;
  if (!scope || typeof scope !== "object") return true;

  const scopedMethod = String(scope.method ?? "").trim().toUpperCase();
  if (scopedMethod && scopedMethod !== method) return false;

  // Method-only scope, already satisfied.
  if (indexed.scopeRaw === null) return true;

  if (indexed.scopeRegex === null) return indexed.scopeRaw === endpoint;
  return indexed.scopeRegex.test(endpoint);
}

export interface SecurityPolicyCacheOptions {
  apiUrl: string;
  headersCallback: () => Record<string, string>;
  maxStaleness?: number;
}

export class SecurityPolicyCache {
  private apiUrl: string;
  private getHeaders: () => Record<string, string>;
  private maxStaleness: number;

  private snapshotRef: PolicySnapshot | null = null;
  private inFlight: Promise<PolicySnapshot | null> | null = null;
  private realtime: RealtimeChannel | null = null;
  private staleWarned = false;

  constructor(options: SecurityPolicyCacheOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.getHeaders = options.headersCallback;
    this.maxStaleness = options.maxStaleness ?? DEFAULT_MAX_STALENESS_SECONDS;
  }

  get snapshot(): PolicySnapshot | null {
    return this.snapshotRef;
  }

  get isLoaded(): boolean {
    return this.snapshotRef !== null;
  }

  get version(): string | null {
    return this.snapshotRef?.version ?? null;
  }

  /**
   * Pull the current snapshot, or keep the existing one on a 304.
   *
   * Never rejects: a refresh failure must not surface in the host application,
   * it just means the previous snapshot stays in force. Concurrent calls share
   * one request.
   */
  async fetch(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<PolicySnapshot | null> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doFetch(timeoutMs).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFetch(timeoutMs: number): Promise<PolicySnapshot | null> {
    const current = this.snapshotRef;

    let headers: Record<string, string>;
    try {
      headers = { ...this.getHeaders() };
    } catch (error) {
      console.warn("[secploy] Security policy fetch: headers failed:", error);
      return current;
    }
    if (current?.version) {
      headers["If-None-Match"] = `"${current.version}"`;
    }

    let response: any;
    try {
      response = await axios.get(`${this.apiUrl}/projects/security/policy/`, {
        headers,
        timeout: timeoutMs,
        // 304 is a success for us, and a failed refresh must not throw.
        validateStatus: () => true,
      });
    } catch (error) {
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

    let snapshot: PolicySnapshot;
    try {
      snapshot = new PolicySnapshot(payload as PolicyPayload);
    } catch (error) {
      console.warn("[secploy] Security policy snapshot build failed:", error);
      return current;
    }

    this.snapshotRef = snapshot;
    this.staleWarned = false;
    console.info(
      `[secploy] Security policy loaded: version=${snapshot.version} ` +
        `rules=${snapshot.ruleCount} controls=${snapshot.controlCount}`,
    );
    return snapshot;
  }

  /**
   * Reproduce the API's raw decision payload from the local snapshot.
   *
   * Returns null when no snapshot has loaded yet, so the caller can fall back to
   * a remote lookup instead of guessing at a policy it has not seen.
   */
  evaluate(
    method: string,
    endpoint: string,
    auth: SecurityGateAuthContext | Record<string, any> = {},
    projectKey = "",
    envKey = "",
  ): DecisionPayload | null {
    const snapshot = this.snapshotRef;
    if (snapshot === null) return null;

    this.warnIfStale(snapshot);

    const rule = this.matchRule(snapshot, method, endpoint);
    // Both spellings are accepted; an unrecognized one would silently match no
    // controls and let the request through.
    const controls = this.matchControls(
      snapshot,
      method,
      endpoint,
      normalizeAuthContext(auth),
      projectKey,
      envKey,
    );

    const payload: DecisionPayload = {
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
  private matchRule(
    snapshot: PolicySnapshot,
    method: string,
    endpoint: string,
  ): BlockedEndpointRule | null {
    for (const { regex, raw, rule } of snapshot.rulesByMethod.get(method) ?? []) {
      if (regex === null) {
        if (raw === endpoint) return rule;
        continue;
      }
      if (regex.test(endpoint)) return rule;
    }
    return null;
  }

  /** Match on session, identity, IP or API key, then apply endpoint scoping. */
  private matchControls(
    snapshot: PolicySnapshot,
    method: string,
    endpoint: string,
    auth: SecurityGateAuthContext,
    projectKey: string,
    envKey: string,
  ): ControlAction[] {
    const clean = (value: unknown) => String(value ?? "").trim();

    const identityKey = clean(auth.identityKey);
    const userId = clean(auth.userId);
    const sessionId = clean(auth.sessionId);
    const ipAddress = clean(auth.ipAddress);
    const remoteAddr = clean(auth.remoteAddr);

    const lookups: string[] = [];
    const push = (type: string, value: string) => {
      if (value) lookups.push(`${type} ${value}`);
    };
    push("session", sessionId);
    for (const value of new Set([identityKey, userId])) push("identity", value);
    for (const value of new Set([ipAddress, remoteAddr])) push("ip", value);
    for (const value of new Set([clean(projectKey), clean(envKey)])) push("api_key", value);

    if (lookups.length === 0) return [];

    const now = Date.now();
    const matched = new Map<string, IndexedControl>();

    for (const key of lookups) {
      for (const indexed of snapshot.controlsByTarget.get(key) ?? []) {
        const controlId = String(indexed.control.id ?? `${key}:${indexed.order}`);
        if (matched.has(controlId)) continue;

        // The snapshot can outlive a control's expiry by up to its TTL, so
        // expiry is re-checked here. Enforcing a lapsed control means blocking a
        // request that should now succeed.
        const expiresAt = parseDate(indexed.control.expires_at);
        if (expiresAt !== null && expiresAt.getTime() <= now) continue;

        if (!controlMatchesEndpointScope(indexed, method, endpoint)) continue;

        matched.set(controlId, indexed);
      }
    }

    // Restore the server's ordering, which the per-target index does not keep.
    return [...matched.values()]
      .sort((a, b) => a.order - b.order)
      .map((indexed) => indexed.control);
  }

  private warnIfStale(snapshot: PolicySnapshot): void {
    if (this.staleWarned || snapshot.ageSeconds <= this.maxStaleness) return;
    this.staleWarned = true;
    console.warn(
      `[secploy] Security policy has not refreshed in ${Math.round(snapshot.ageSeconds)}s ` +
        `(version=${snapshot.version}). Still enforcing the last known policy.`,
    );
  }

  startRealtime(wsUrl: string, headersCallback: () => Record<string, string>): void {
    if (this.realtime !== null) {
      console.warn("[secploy] Security policy real-time is already running.");
      return;
    }
    this.realtime = new RealtimeChannel({
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

  stopRealtime(): void {
    if (this.realtime !== null) {
      this.realtime.stop();
      this.realtime = null;
    }
  }

  get isRealtime(): boolean {
    return this.realtime?.isConnected ?? false;
  }
}
