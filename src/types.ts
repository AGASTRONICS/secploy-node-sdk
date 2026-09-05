export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

/**
 * How the gate reaches a decision.
 *
 * - `remote` asks the API on every gated request.
 * - `cached` decides from a locally held policy snapshot, with no network call.
 * - `shadow` decides both ways, reports any disagreement, and returns the
 *   remote answer. Run this in production to prove the cache agrees with the
 *   API before switching to `cached`.
 */
export type GateMode = "remote" | "cached" | "shadow";

export interface SecployConfig {
  apiKey: string;
  environmentKey: string;
  organizationId: string;
  environment?: string;
  samplingRate?: number;
  ingestUrl: string;
  /** Base API URL. Defaults to https://api.secploy.com */
  apiUrl?: string;
  maxRetry?: number;
  debug?: boolean;
  logLevel?: LogLevel;
  batchSize?: number;
  flushInterval?: number;
  /** Maximum unsent events held before the oldest are discarded. */
  maxQueueSize?: number;
  /**
   * The version of the application being observed, e.g. a git sha or "2.4.1".
   *
   * Attached to every error. Without it an issue cannot say which build it
   * first appeared in, and "this regressed in 2.4.1" is unanswerable.
   */
  release?: string;
  /**
   * Install process-level handlers for uncaughtException and
   * unhandledRejection. On by default: the errors worth reporting are the ones
   * nobody wrote a try/catch for.
   */
  captureUncaught?: boolean;
  /**
   * Mirror console output into events, and turn console.error(someError) into
   * a reported issue. On by default.
   */
  captureConsole?: boolean;
  /**
   * Redact credentials from every outgoing event. On by default; turn it off
   * only for a deployment that scrubs in front of the SDK.
   */
  scrubEnabled?: boolean;
  /** Extra key names to redact, on top of the built-in denylist. */
  scrubFields?: string[];
  /**
   * Run on every event before it is queued, with the real values. Return the
   * event to send it, or null to drop it. Runs before scrubbing, so anything
   * it returns is still scrubbed on the way out.
   */
  beforeSend?: (
    payload: Record<string, any>,
  ) => Record<string, any> | null | undefined;
  /** Gate decision strategy. Defaults to "remote". */
  gateMode?: GateMode;
  /** Seconds before an unrefreshed policy snapshot starts warning. */
  maxPolicyStaleness?: number;
  /** Seconds an unchanged identity stays suppressed before being re-reported. */
  identityReportInterval?: number;
  /** Seconds between identity batch flushes. */
  identityFlushInterval?: number;
  /** Subscribe to policy pushes over WebSocket. Defaults to true. */
  realtime?: boolean;
  /** Allow requests through when a decision cannot be reached. Defaults to true. */
  failOpen?: boolean;
}

/** Identity attached to a gated request. */
export interface SecurityGateAuthContext {
  identityKey?: string;
  userId?: string;
  sessionId?: string;
  authProvider?: string;
  ipAddress?: string;
  remoteAddr?: string;
  name?: string;
  username?: string;
  avatar?: string;
  email?: string;
  isAuthenticated?: boolean;
}

/** A blocked-endpoint rule as the API serves it. */
export interface BlockedEndpointRule {
  id?: string;
  method?: string;
  path_pattern?: string;
  reason?: string | null;
  is_active?: boolean;
  [key: string]: any;
}

/** An active security control action as the API serves it. */
export interface ControlAction {
  id?: string;
  action_type?: string;
  target_type?: string;
  target?: string;
  reason?: string | null;
  status?: string;
  source?: string;
  identity_key?: string | null;
  session_id?: string | null;
  auth_provider?: string | null;
  risk_score?: number | null;
  expires_at?: string | null;
  metadata?: Record<string, any> | null;
  [key: string]: any;
}

/** The API's raw decision body, and what the local cache reproduces. */
export interface DecisionPayload {
  blocked: boolean;
  method: string;
  endpoint: string;
  reason?: string;
  rule?: BlockedEndpointRule;
  controls?: ControlAction[];
  [key: string]: any;
}

/** A full policy snapshot as served by /projects/security/policy/. */
export interface PolicyPayload {
  version: string;
  generated_at?: string;
  ttl_seconds?: number;
  blocked_endpoints?: BlockedEndpointRule[];
  controls?: ControlAction[];
  [key: string]: any;
}

export interface SecurityGateDecision {
  allowed: boolean;
  blocked: boolean;
  method: string;
  endpoint: string;
  url: string;
  reason: string;
  rule: BlockedEndpointRule;
  controls: ControlAction[];
  raw: Record<string, any>;
  auth?: SecurityGateAuthContext;
  metadata?: Record<string, any>;
}

export interface SecployOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export interface EventData {
  type: string;
  payload: Record<string, any>;
  timestamp: number;
}

export interface EventBatch {
  events: EventData[];
  size: number;
  lastFlush: number;
}

export interface LoggerOptions {
  name?: string;
  levels?: LogLevel[];
}

export interface LogHandler {
  handleLog(level: LogLevel, message: string, meta?: Record<string, any>): void;
}
