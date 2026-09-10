/**
 * Identifiers for the browser and React Native builds.
 *
 * Node has `crypto.randomUUID` and `createHash`; these runtimes may have
 * neither. Hermes ships no `crypto` global at all unless the app installs a
 * polyfill, so everything here degrades rather than throws.
 */

import { HASHED_SESSION } from "./scrub";
import { sha256Hex } from "./sha256";

/**
 * Random bytes, from the platform's CSPRNG when there is one.
 *
 * The fallback is `Math.random`, and that is acceptable only because of what
 * these bytes become: event ids and a session label. Neither is a credential -
 * nothing is authorised by knowing one - so predictability costs uniqueness at
 * worst, never access.
 */
function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  const cryptoImpl = (globalThis as any).crypto;
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === "function") {
    try {
      cryptoImpl.getRandomValues(out);
      return out;
    } catch {
      // Some polyfills throw rather than being absent. Fall through.
    }
  }
  for (let i = 0; i < count; i++) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** A version 4 UUID, the same shape Node's `randomUUID` produces. */
export function newEventId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * A fresh session identifier, already in the hashed shape.
 *
 * The ingest and the replay upload endpoint both refuse a session id that is
 * not `sess_` plus 32 hex characters - that is their check that the client
 * scrubbed at all. A random value in that shape is indistinguishable from a
 * hashed one and needs no hashing: there is no underlying credential to hide.
 */
export function newSessionId(): string {
  return "sess_" + toHex(randomBytes(16));
}

/**
 * The portable twin of `hashSessionId` in `scrubbing.ts`.
 *
 * Same algorithm, same output, no Node. Use it when an application wants to
 * report its own session identifier - one the server side also sees - so the
 * browser's events and the API's events name the same session.
 */
export function hashSessionId(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";
  if (HASHED_SESSION.test(text)) return text;
  return "sess_" + sha256Hex(text).slice(0, 32);
}
