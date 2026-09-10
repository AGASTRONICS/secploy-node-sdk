/**
 * The platform-free half of `scrubbing.ts`.
 *
 * Everything here runs unchanged in Node, a browser and React Native: it
 * imports nothing. `hashSessionId` stays behind in `scrubbing.ts` because it
 * reaches for Node's `crypto`, and the browser and React Native entry points
 * carry their own byte-identical version (see `portable/ids.ts`). A bundler
 * that pulled `crypto` into a web build would fail it, or worse, polyfill it.
 *
 * See `scrubbing.ts` for why scrubbing exists and what it deliberately keeps.
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
/** The exact shape hashSessionId emits, used to recognise its own output. */
export declare const HASHED_SESSION: RegExp;
/** Lowercase a key and drop separators, so naming style stops mattering. */
export declare function normalizeKey(key: unknown): string;
/** Remove secret-shaped substrings from free text. */
export declare function scrubString(value: string): string;
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
