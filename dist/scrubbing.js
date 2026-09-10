"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashSessionId = hashSessionId;
const crypto_1 = require("crypto");
const scrub_1 = require("./portable/scrub");
// The denylist, the value patterns and the Scrubber itself live in a module
// with no imports, so the browser and React Native builds share them exactly.
__exportStar(require("./portable/scrub"), exports);
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
function hashSessionId(value) {
    const text = String(value ?? "");
    if (!text)
        return "";
    // Idempotent on purpose. Auth context is normalised at more than one layer -
    // the gate does it, and the policy cache does it again - and hashing an
    // already-hashed value would produce something that matches no control at
    // all. A gate that silently stops enforcing is the worst way for this to
    // fail, so applying it twice has to be the same as applying it once.
    if (scrub_1.HASHED_SESSION.test(text))
        return text;
    return ("sess_" +
        (0, crypto_1.createHash)("sha256").update(text, "utf8").digest("hex").slice(0, 32));
}
