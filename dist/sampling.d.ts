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
/** Event types that carry the signal this product exists for. */
export declare const ALWAYS_SENT_TYPES: ReadonlySet<string>;
/**
 * Namespaced security signals the SDK emits. These are deliberate - an
 * application calling out that something happened - and never volume traffic.
 */
export declare const ALWAYS_SENT_PREFIXES: readonly string[];
/**
 * Fields that identify who an event is about, most specific first, so sampling
 * follows a person where it can and a machine otherwise.
 */
export declare const ACTOR_FIELDS: readonly string[];
/** Whether an event must be sent whatever the rate. */
export declare function neverSampled(eventType: unknown, hasStacktrace?: boolean): boolean;
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
export declare function bucket(value: string): number;
/** The most specific identifier available for whoever this event is about. */
export declare function actorKey(payload: Record<string, any> | null | undefined): string;
/**
 * Whether one event survives sampling.
 *
 * Never throws: this sits on the path every event takes, and a sampler that
 * failed on an unusual payload would stop the application reporting at all.
 */
export declare function shouldSend(eventType: unknown, payload: Record<string, any> | null | undefined, rate: number): boolean;
