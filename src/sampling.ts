/**
 * Sampling, without breaking detection.
 *
 * Mirrors `secploy/sampling.py` in the Python SDK and `services/sampling.go` in
 * the ingest. All three have to agree, for reasons the bucketing note below
 * explains.
 *
 * `samplingRate` has been in the configuration since the beginning. It is
 * documented, defaulted, and stored on the client - and it was never read.
 * Setting `0.1` sent everything, so a project that had deliberately turned its
 * volume down was paying for all of it and did not know.
 *
 * Making it work is easy. Making it safe is the part that needs a decision, and
 * the answer is not the one a general error tracker would give.
 *
 * **Some events are never sampled.** A general tracker samples errors because
 * volume is its problem. This product's value is the rare event: the one failed
 * login that mattered, the one probe that succeeded. Dropping nine errors in ten
 * would be dropping the thing it exists to find. So errors, warnings and every
 * namespaced security signal always go, whatever the rate. What gets thinned is
 * the high-volume, low-signal traffic that made sampling desirable in the first
 * place: logs, metrics, ordinary requests.
 *
 * **What is sampled is sampled per actor, not per event.** Several detectors
 * read a *sequence* - how many object ids one caller walked, how a parameter's
 * shape changed, how a response size drifted. A uniform one-in-ten sample
 * leaves every sequence with holes, so a scan of two hundred ids arrives as
 * twenty scattered requests and no detector fires. Bucketing on the actor
 * instead means a caller is either fully observed or not observed at all: the
 * same fraction of traffic is kept, but what is kept is coherent enough to
 * still detect something.
 */

import { createHash } from "crypto";

/** Event types that carry the signal this product exists for. */
export const ALWAYS_SENT_TYPES: ReadonlySet<string> = new Set([
  "error",
  "critical",
  "fatal",
  "warning",
  "warn",
  "exception",
]);

/**
 * Namespaced security signals the SDK emits. These are deliberate - an
 * application calling out that something happened - and never volume traffic.
 */
export const ALWAYS_SENT_PREFIXES: readonly string[] = [
  "auth.",
  "account.",
  "security.",
  "access.",
  "data.",
  "secret.",
  "incident.",
  "fraud.",
  "compliance.",
  "payment.",
  "api.abuse",
  "dependency_scan.",
  // Session replay index events. By the time one is sent the bytes are already
  // in object storage, so dropping it saves nothing - it strands an object no
  // issue points at. The ingest and the Flutter SDK carry the same entry.
  "replay.",
];

/**
 * Fields that identify who an event is about, most specific first, so sampling
 * follows a person where it can and a machine otherwise.
 */
export const ACTOR_FIELDS: readonly string[] = [
  "identity_key",
  "user_id",
  "session_id",
  "ip_address",
  "remote_addr",
];

/**
 * What the SDK fills in when it knows nothing. Treating these as an actor would
 * put every anonymous request in one bucket, so they would all be sampled in or
 * all out together.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "anonymous",
  "unknown",
  "none",
  "",
]);

/** Whether an event must be sent whatever the rate. */
export function neverSampled(
  eventType: unknown,
  hasStacktrace = false,
): boolean {
  // A stacktrace is unambiguous evidence that something threw, whatever the
  // event was labelled.
  if (hasStacktrace) return true;

  const normalized = String(eventType ?? "")
    .trim()
    .toLowerCase();
  if (ALWAYS_SENT_TYPES.has(normalized)) return true;
  return ALWAYS_SENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Map a string onto `[0, 1)` deterministically.
 *
 * The first four bytes of a SHA-256 read as a big-endian unsigned 32-bit
 * integer, divided by the full range. Chosen because it is expressible
 * identically in JavaScript, Python and Go - all three handle a uint32 without
 * loss - so every service buckets an actor the same way. An actor bucketed
 * differently by different services would be sampled in by one and out by
 * another, which is the incoherence this design exists to avoid.
 */
export function bucket(value: string): number {
  const digest = createHash("sha256").update(String(value), "utf8").digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** The most specific identifier available for whoever this event is about. */
export function actorKey(
  payload: Record<string, any> | null | undefined,
): string {
  if (!payload || typeof payload !== "object") return "";

  const sources: Record<string, any>[] = [];
  if (payload.context && typeof payload.context === "object")
    sources.push(payload.context);
  sources.push(payload);

  for (const field of ACTOR_FIELDS) {
    for (const source of sources) {
      const value = String(source[field] ?? "").trim();
      if (value && !PLACEHOLDERS.has(value.toLowerCase())) {
        return `${field}:${value}`;
      }
    }
  }
  return "";
}

function hasStacktrace(
  payload: Record<string, any> | null | undefined,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  for (const source of [payload.context, payload]) {
    if (source && typeof source === "object" && source.stacktrace) return true;
  }
  return false;
}

/**
 * Whether one event survives sampling.
 *
 * Never throws: this sits on the path every event takes, and a sampler that
 * failed on an unusual payload would stop the application reporting at all.
 */
export function shouldSend(
  eventType: unknown,
  payload: Record<string, any> | null | undefined,
  rate: number,
): boolean {
  const parsed = Number(rate);
  if (!Number.isFinite(parsed)) return true;
  if (parsed >= 1.0) return true;

  let protectedEvent: boolean;
  try {
    protectedEvent = neverSampled(eventType, hasStacktrace(payload));
  } catch {
    return true;
  }

  if (parsed <= 0) {
    // A rate of zero still sends what must never be dropped, which is the
    // difference between "quiet" and "blind".
    return protectedEvent;
  }
  if (protectedEvent) return true;

  let key = "";
  try {
    key = actorKey(payload);
  } catch {
    key = "";
  }

  return bucket(key || String(eventType)) < parsed;
}
