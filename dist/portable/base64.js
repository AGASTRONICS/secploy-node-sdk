"use strict";
/**
 * Base64 to bytes, without `atob` or `Buffer`.
 *
 * `react-native-view-shot` hands a capture back as a base64 string. Hermes has
 * `atob` only on recent releases and `Buffer` only when the app polyfills it,
 * and a replay feature that worked or failed depending on the app's polyfills
 * would be a support ticket per customer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.base64ToBytes = base64ToBytes;
const LOOKUP = new Int16Array(256).fill(-1);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let i = 0; i < ALPHABET.length; i++) {
    LOOKUP[ALPHABET.charCodeAt(i)] = i;
}
// The URL-safe alphabet too, so either form decodes.
LOOKUP["-".charCodeAt(0)] = 62;
LOOKUP["_".charCodeAt(0)] = 63;
/**
 * Decode base64, accepting a `data:` URI prefix, whitespace and missing
 * padding. Throws on a character outside the alphabet: a corrupt capture must
 * be dropped, not decoded into a plausible-looking wrong image.
 */
function base64ToBytes(input) {
    let text = input;
    const comma = text.indexOf(",");
    if (text.startsWith("data:") && comma !== -1) {
        text = text.slice(comma + 1);
    }
    text = text.replace(/[\s=]/g, "");
    const out = new Uint8Array(Math.floor((text.length * 3) / 4));
    let buffer = 0;
    let bits = 0;
    let written = 0;
    for (let i = 0; i < text.length; i++) {
        const value = LOOKUP[text.charCodeAt(i) & 0xff];
        if (value < 0 || text.charCodeAt(i) > 0xff) {
            throw new Error(`invalid base64 character at ${i}`);
        }
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[written++] = (buffer >> bits) & 0xff;
        }
    }
    return written === out.length ? out : out.subarray(0, written);
}
