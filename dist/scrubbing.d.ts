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
export * from "./portable/scrub";
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
