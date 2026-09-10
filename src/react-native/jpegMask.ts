/**
 * Painting over a captured frame.
 *
 * The capture comes back as a JPEG. To mask it, the JPEG is decoded to pixels,
 * the rectangles are filled with an opaque colour, and the result is encoded
 * again - in plain JavaScript via `jpeg-js`, because React Native has no image
 * API a library can reach without shipping native code of its own.
 *
 * The frames are small - a third of the screen's layout size, around 120 by
 * 260 pixels - so a decode and an encode cost a few milliseconds once a second.
 *
 * **The unmasked pixels die in this function.** Nothing below stores the
 * decoded buffer, and the caller discards the original bytes once this
 * returns. What reaches the ring buffer is only ever the masked encoding.
 *
 * Opaque fill rather than a blur: a blur of a six-digit code is still a
 * six-digit code to anyone with the patience to deconvolve it.
 */

import * as jpeg from "jpeg-js";

import { Rect } from "./fiberMasks";

/**
 * Width and height from a JPEG's frame header, without decoding it.
 *
 * Scans the marker segments for a start-of-frame. Returns null for anything
 * that is not a well-formed JPEG, which the caller treats as a failed frame.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Padding bytes between markers.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Fill rectangles, given in image pixels, on an RGBA buffer.
 *
 * Each rectangle is grown by `pad` pixels and its edges rounded outward.
 * Measurements are in layout units and scaled to a smaller image, and a
 * fractional edge rounded inward leaves a column of a glyph showing.
 */
export function paintRects(
  rgba: Uint8Array,
  width: number,
  height: number,
  rects: Rect[],
  color: [number, number, number],
  pad = 1,
): void {
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x) - pad);
    const y0 = Math.max(0, Math.floor(rect.y) - pad);
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width) + pad);
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height) + pad);
    for (let y = y0; y < y1; y++) {
      let index = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++) {
        rgba[index] = color[0];
        rgba[index + 1] = color[1];
        rgba[index + 2] = color[2];
        rgba[index + 3] = 255;
        index += 4;
      }
    }
  }
}

/**
 * Run `fn` with a stand-in `Buffer`, if the runtime has none.
 *
 * jpeg-js's encoder ends in `Buffer.from(bytes)` whenever `module` is defined -
 * which, under Metro's CommonJS wrapper, it always is - and React Native has no
 * `Buffer` unless the app installs a polyfill. The stand-in exists only for
 * the duration of one synchronous call, so nothing else in the app can observe
 * it, and it is removed even if the encoder throws.
 */
function withBuffer<T>(fn: () => T): T {
  const g = globalThis as any;
  if (typeof g.Buffer !== "undefined") return fn();
  g.Buffer = { from: (data: ArrayLike<number>) => Uint8Array.from(data) };
  try {
    return fn();
  } finally {
    delete g.Buffer;
  }
}

/** Decode, paint, re-encode. Throws on a corrupt frame; the caller drops it. */
export function maskJpeg(
  bytes: Uint8Array,
  rects: Rect[],
  options: { quality: number; color: [number, number, number] },
): Uint8Array {
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    // Bounds on what a hostile or corrupt frame can make the decoder allocate.
    maxResolutionInMP: 20,
    maxMemoryUsageInMB: 64,
  });

  const rgba = decoded.data as Uint8Array;
  paintRects(rgba, decoded.width, decoded.height, rects, options.color);

  const encoded = withBuffer(() =>
    jpeg.encode(
      { data: rgba, width: decoded.width, height: decoded.height },
      Math.round(Math.min(100, Math.max(1, options.quality))),
    ),
  );

  // Whatever the encoder handed back - Buffer, Uint8Array, or the stand-in's
  // Uint8Array - as a plain view.
  const data = encoded.data as unknown as Uint8Array;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
