/**
 * SHA-256 in plain JavaScript, synchronously.
 *
 * Exists for one caller: hashing a session identifier in a browser or on React
 * Native, where Node's `crypto` is absent. `crypto.subtle.digest` is async and
 * missing on Hermes entirely, and an async hash would make every event wait on
 * a promise before it could be scrubbed.
 *
 * The output must be byte-identical to `createHash("sha256")` in Node and
 * `hashlib.sha256` in Python - a session hashed differently by two services
 * looks like two sessions. The tests hold it to Node's.
 */
/**
 * UTF-8 bytes of a string.
 *
 * Hand-rolled rather than `TextEncoder`, which older Hermes builds lack. A lone
 * surrogate becomes U+FFFD, which is what Node's utf8 encoding does too - so a
 * malformed identifier still hashes the same on both sides.
 */
export declare function utf8Encode(text: string): Uint8Array;
/** Lowercase hex SHA-256 of a string's UTF-8 bytes, or of raw bytes. */
export declare function sha256Hex(input: string | Uint8Array): string;
