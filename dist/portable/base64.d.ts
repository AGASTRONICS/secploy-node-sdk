/**
 * Base64 to bytes, without `atob` or `Buffer`.
 *
 * `react-native-view-shot` hands a capture back as a base64 string. Hermes has
 * `atob` only on recent releases and `Buffer` only when the app polyfills it,
 * and a replay feature that worked or failed depending on the app's polyfills
 * would be a support ticket per customer.
 */
/**
 * Decode base64, accepting a `data:` URI prefix, whitespace and missing
 * padding. Throws on a character outside the alphabet: a corrupt capture must
 * be dropped, not decoded into a plausible-looking wrong image.
 */
export declare function base64ToBytes(input: string): Uint8Array;
