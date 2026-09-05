/**
 * Removing secrets before anything leaves the application.
 *
 * Mirrors `secploy/scrubbing.py` in the Python SDK. The two clients feed one
 * ingest, and a rule that exists on one side only is a leak on the other.
 *
 * An observability SDK is a pipe out of somebody else's process, and whatever
 * goes into that pipe gets stored, indexed, and shown on a dashboard to whoever
 * has access. Until now nothing stood between the application's data and that
 * pipe: no denylist, no redaction, no hook.
 *
 * Two rules shape what is here.
 *
 * **Scrub at the boundary, not at the call site.** Every event passes through
 * one function on its way to the queue, and the scrubbing happens there.
 * Redacting at each place that builds a payload guarantees that the next
 * payload someone adds is the one that leaks.
 *
 * **Credentials are not identifiers.** A general error tracker turns personal
 * data off by default, because it does not need to know who you are. This one
 * does: the identity, the session and the IP address are the signal - impossible
 * travel, actor correlation and every control action are built on them. So they
 * stay, and what is removed is the class of thing that grants access rather than
 * describes a person. The session identifier is kept but hashed, because the
 * product needs to recognise a session, not to be able to replay it.
 */

import { createHash } from "crypto";

export const REDACTED = "[secploy:redacted]";

/**
 * Key names whose value is never sent.
 *
 * Compared after normalising the key - lowercased, separators removed - so
 * "API-Key", "api_key" and "apiKey" are one entry rather than three.
 */
export const DEFAULT_DENY_KEYS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "clientsecret",
  "appsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "apikey",
  "apisecret",
  "apitoken",
  "xapikey",
  "auth",
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "setcookie",
  "sessionkey",
  "sessiontoken",
  "sessid",
  "sid",
  "csrf",
  "csrftoken",
  "xsrftoken",
  "privatekey",
  "publickey",
  "signingkey",
  "encryptionkey",
  "signature",
  "credentials",
  "credential",
  "creditcard",
  "cardnumber",
  "cardnum",
  "cvv",
  "cvc",
  "pin",
  "ssn",
  "socialsecurity",
  "socialsecuritynumber",
  "taxid",
  "otp",
  "mfacode",
  "totp",
  "twofactorcode",
  "dbpassword",
  "databaseurl",
  "connectionstring",
  "dsn",
]);

/**
 * Keys the SDK produces itself and has already made safe.
 *
 * `session_id` normalises to "sessionid", which the denylist above would
 * otherwise catch - and it must not, because it is how a session is recognised
 * across events. It arrives here already hashed.
 */
export const EXEMPT_KEYS: ReadonlySet<string> = new Set([
  "sessionid",
  "identitykey",
]);

/**
 * Value shapes worth removing wherever they appear, including inside a message
 * or under a key nobody thought to deny.
 */
const VALUE_PATTERNS: RegExp[] = [
  // JSON Web Tokens. Three base64url segments; the leading "eyJ" is the
  // encoded '{"' that begins every JWT header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // PEM private key blocks, including everything between the markers.
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  // Credentials embedded in a URL: https://user:password@host
  /(?<=:\/\/)[^/\s:@]+:[^/\s:@]+(?=@)/g,
  // An Authorization header value that turned up in free text.
  /\b(?:[Bb]earer|[Bb]asic|[Tt]oken)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  // Provider-issued keys, recognisable by their prefixes.
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
];

/**
 * Candidate card numbers: 13-19 digits, optionally separated.
 *
 * Checked against Luhn before redacting, because this shape also matches order
 * numbers, timestamps and database ids - and redacting those would make the
 * product worse at its job for no security benefit.
 */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * Bounds on how much of a structure is walked.
 *
 * Not only about cost: a cyclic or absurdly deep payload should end in a
 * truncated event rather than a stack overflow inside the SDK.
 */
export const MAX_DEPTH = 8;
export const MAX_ITEMS = 200;
export const MAX_STRING = 8192;

/** The exact shape hashSessionId emits, used to recognise its own output. */
const HASHED_SESSION = /^sess_[0-9a-f]{32}$/;

/** Lowercase a key and drop separators, so naming style stops mattering. */
export function normalizeKey(key: unknown): string {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** The checksum every real card number satisfies. */
function luhnValid(digits: string): boolean {
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let value = digits.charCodeAt(i) - 48;
    if (i % 2 === parity) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
  }
  return total % 10 === 0;
}

function redactCards(text: string): string {
  // A fresh lastIndex each call: these patterns carry the g flag, which makes
  // exec/replace stateful across calls on a shared regex.
  CARD_CANDIDATE.lastIndex = 0;
  return text.replace(CARD_CANDIDATE, (match) =>
    luhnValid(match.replace(/[ -]/g, "")) ? REDACTED : match,
  );
}

/** Remove secret-shaped substrings from free text. */
export function scrubString(value: string): string {
  if (!value) return value;

  let scrubbed = value;
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }
  scrubbed = redactCards(scrubbed);

  if (scrubbed.length > MAX_STRING) {
    scrubbed = scrubbed.slice(0, MAX_STRING) + "…[truncated]";
  }

  return scrubbed;
}

/**
 * Turn a session identifier into something that identifies without granting.
 *
 * A session cookie is a live credential: anyone who reads one out of an event
 * store can use it. But the product genuinely needs to recognise a session - to
 * correlate an actor's activity and to target a revocation - so dropping it is
 * not an option either.
 *
 * A hash keeps every property actually needed. It is stable, so the same
 * session matches across events and processes; it is unique, so sessions stay
 * distinct; and it cannot be replayed. Unsalted deliberately: a salt would have
 * to be shared by every process and service that compares these values, and the
 * input is already high-entropy enough that hashing it is not worth attacking.
 *
 * Must stay byte-identical to `hash_session_id` in the Python SDK, or the same
 * session reported by two services would look like two.
 */
export function hashSessionId(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";

  // Idempotent on purpose. Auth context is normalised at more than one layer -
  // the gate does it, and the policy cache does it again - and hashing an
  // already-hashed value would produce something that matches no control at
  // all. A gate that silently stops enforcing is the worst way for this to
  // fail, so applying it twice has to be the same as applying it once.
  if (HASHED_SESSION.test(text)) return text;

  return (
    "sess_" +
    createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32)
  );
}

export interface ScrubberOptions {
  denyKeys?: Iterable<string>;
  enabled?: boolean;
}

/** Removes credentials from an event payload. */
export class Scrubber {
  readonly enabled: boolean;
  private readonly denyKeys: Set<string>;

  constructor(options: ScrubberOptions = {}) {
    this.enabled = options.enabled !== false;
    this.denyKeys = new Set(DEFAULT_DENY_KEYS);
    for (const key of options.denyKeys ?? []) {
      this.denyKeys.add(normalizeKey(key));
    }
  }

  isDenied(key: unknown): boolean {
    const normalized = normalizeKey(key);
    if (!normalized || EXEMPT_KEYS.has(normalized)) return false;
    if (this.denyKeys.has(normalized)) return true;

    // Substring match so "user_password", "stripe_api_key" and "x_auth_token"
    // are caught without enumerating every prefix a framework might use.
    for (const denied of this.denyKeys) {
      if (denied.length >= 5 && normalized.includes(denied)) return true;
    }
    return false;
  }

  /**
   * Walk a payload, redacting as it goes.
   *
   * Never throws. This runs on the path every event takes, and a scrubber that
   * failed on an unusual object would stop the application reporting anything.
   */
  scrub(value: unknown): unknown {
    if (!this.enabled) return value;

    try {
      return this.walk(value, 0, new WeakSet());
    } catch {
      // Something in the payload defeated the walk. Returning it unscrubbed
      // would be exactly the leak this exists to prevent, so it does not go
      // out.
      return REDACTED;
    }
  }

  private walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth > MAX_DEPTH) return "[secploy:max-depth]";

    if (typeof value === "string") return scrubString(value);
    if (value === null || value === undefined) return value;
    if (typeof value === "number" || typeof value === "boolean") return value;

    if (Array.isArray(value)) {
      // Cycles are rare but real - a request object graph, a logger context
      // that references itself - and would otherwise burn the whole depth
      // budget.
      if (seen.has(value)) return "[secploy:circular]";
      seen.add(value);
      return value
        .slice(0, MAX_ITEMS)
        .map((item) => this.walk(item, depth + 1, seen));
    }

    if (typeof value === "object") {
      if (seen.has(value as object)) return "[secploy:circular]";
      seen.add(value as object);

      // An Error carries its own shape and would otherwise stringify to
      // "Error: message", losing the stack the report is built on.
      if (value instanceof Error) {
        return {
          name: value.name,
          message: scrubString(value.message ?? ""),
          stack: scrubString(value.stack ?? ""),
        };
      }

      const scrubbed: Record<string, unknown> = {};
      let index = 0;
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (index >= MAX_ITEMS) {
          scrubbed["[secploy:truncated]"] =
            Object.keys(value as object).length - MAX_ITEMS;
          break;
        }
        index++;

        if (this.isDenied(key)) {
          scrubbed[key] = REDACTED;
          continue;
        }

        // Reading a property can run arbitrary code - a getter, a Proxy trap -
        // and this is the last place that should be able to throw.
        let item: unknown;
        try {
          item = (value as Record<string, unknown>)[key];
        } catch {
          scrubbed[key] = REDACTED;
          continue;
        }
        scrubbed[key] = this.walk(item, depth + 1, seen);
      }
      return scrubbed;
    }

    // Functions, symbols, bigints: describe rather than send.
    try {
      return scrubString(String(value));
    } catch {
      return REDACTED;
    }
  }
}
