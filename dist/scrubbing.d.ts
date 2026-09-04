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
export declare const REDACTED = "[secploy:redacted]";
/**
 * Key names whose value is never sent.
 *
 * Compared after normalising the key - lowercased, separators removed - so
 * "API-Key", "api_key" and "apiKey" are one entry rather than three.
 */
export declare const DEFAULT_DENY_KEYS: ReadonlySet<string>;
/**
 * Keys the SDK produces itself and has already made safe.
 *
 * `session_id` normalises to "sessionid", which the denylist above would
 * otherwise catch - and it must not, because it is how a session is recognised
 * across events. It arrives here already hashed.
 */
export declare const EXEMPT_KEYS: ReadonlySet<string>;
/**
 * Bounds on how much of a structure is walked.
 *
 * Not only about cost: a cyclic or absurdly deep payload should end in a
 * truncated event rather than a stack overflow inside the SDK.
 */
export declare const MAX_DEPTH = 8;
export declare const MAX_ITEMS = 200;
export declare const MAX_STRING = 8192;
/** Lowercase a key and drop separators, so naming style stops mattering. */
export declare function normalizeKey(key: unknown): string;
/** Remove secret-shaped substrings from free text. */
export declare function scrubString(value: string): string;
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
export declare function hashSessionId(value: unknown): string;
export interface ScrubberOptions {
    denyKeys?: Iterable<string>;
    enabled?: boolean;
}
/** Removes credentials from an event payload. */
export declare class Scrubber {
    readonly enabled: boolean;
    private readonly denyKeys;
    constructor(options?: ScrubberOptions);
    isDenied(key: unknown): boolean;
    /**
     * Walk a payload, redacting as it goes.
     *
     * Never throws. This runs on the path every event takes, and a scrubber that
     * failed on an unusual object would stop the application reporting anything.
     */
    scrub(value: unknown): unknown;
    private walk;
}
