/**
 * Identifiers for the browser and React Native builds.
 *
 * Node has `crypto.randomUUID` and `createHash`; these runtimes may have
 * neither. Hermes ships no `crypto` global at all unless the app installs a
 * polyfill, so everything here degrades rather than throws.
 */
/** A version 4 UUID, the same shape Node's `randomUUID` produces. */
export declare function newEventId(): string;
/**
 * A fresh session identifier, already in the hashed shape.
 *
 * The ingest and the replay upload endpoint both refuse a session id that is
 * not `sess_` plus 32 hex characters - that is their check that the client
 * scrubbed at all. A random value in that shape is indistinguishable from a
 * hashed one and needs no hashing: there is no underlying credential to hide.
 */
export declare function newSessionId(): string;
/**
 * The portable twin of `hashSessionId` in `scrubbing.ts`.
 *
 * Same algorithm, same output, no Node. Use it when an application wants to
 * report its own session identifier - one the server side also sees - so the
 * browser's events and the API's events name the same session.
 */
export declare function hashSessionId(value: unknown): string;
