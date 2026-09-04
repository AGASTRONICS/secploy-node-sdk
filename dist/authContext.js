"use strict";
/**
 * Auth context normalization.
 *
 * The public TypeScript API is camelCase because that is what a Node developer
 * expects, while the API and the Python SDK speak snake_case. Both spellings are
 * accepted here and reduced to one canonical shape.
 *
 * This is not cosmetic. Control matching is keyed on these fields, so an
 * unrecognized spelling does not raise an error - it silently finds no controls
 * and lets the request through. A gate that quietly stops enforcing because a
 * caller wrote `identity_key` instead of `identityKey` is worse than one that
 * fails loudly, so both are understood.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTH_FIELD_ALIASES = void 0;
exports.normalizeAuthContext = normalizeAuthContext;
const scrubbing_1 = require("./scrubbing");
/** camelCase field -> the snake_case spelling also accepted for it. */
exports.AUTH_FIELD_ALIASES = [
    ["identityKey", "identity_key"],
    ["userId", "user_id"],
    ["sessionId", "session_id"],
    ["authProvider", "auth_provider"],
    ["ipAddress", "ip_address"],
    ["remoteAddr", "remote_addr"],
    ["name", "name"],
    ["username", "username"],
    ["avatar", "avatar"],
    ["email", "email"],
    ["isAuthenticated", "is_authenticated"],
];
/**
 * Accept either spelling for every field and return the canonical camelCase
 * form. camelCase wins when both are present.
 */
function normalizeAuthContext(input) {
    if (!input || typeof input !== "object")
        return {};
    const source = input;
    const normalized = {};
    for (const [field, alias] of exports.AUTH_FIELD_ALIASES) {
        const value = source[field] ?? source[alias];
        if (value !== undefined && value !== null)
            normalized[field] = value;
    }
    // "avater" is accepted because the Python SDK's public register_identity does.
    if (normalized.avatar === undefined && source.avater !== undefined) {
        normalized.avatar = source.avater;
    }
    // The session identifier is a live credential: a session cookie read out of
    // an event store can be replayed. Hashing here, at the one point every path
    // converges on, keeps everything the product actually needs - the value is
    // stable, so a session is still recognisable across events and processes, and
    // unique, so sessions stay distinct - while removing the ability to reuse it.
    //
    // The gate hashes the incoming request through this same function, so a
    // control targeting a session still matches. Byte-identical to
    // hash_session_id in the Python SDK, or one session reported by two services
    // would look like two.
    if (normalized.sessionId !== undefined && normalized.sessionId !== "") {
        normalized.sessionId = (0, scrubbing_1.hashSessionId)(normalized.sessionId);
    }
    return normalized;
}
