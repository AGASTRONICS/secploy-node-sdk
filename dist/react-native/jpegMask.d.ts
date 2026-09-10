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
import { Rect } from "./fiberMasks";
/**
 * Width and height from a JPEG's frame header, without decoding it.
 *
 * Scans the marker segments for a start-of-frame. Returns null for anything
 * that is not a well-formed JPEG, which the caller treats as a failed frame.
 */
export declare function jpegDimensions(bytes: Uint8Array): {
    width: number;
    height: number;
} | null;
/**
 * Fill rectangles, given in image pixels, on an RGBA buffer.
 *
 * Each rectangle is grown by `pad` pixels and its edges rounded outward.
 * Measurements are in layout units and scaled to a smaller image, and a
 * fractional edge rounded inward leaves a column of a glyph showing.
 */
export declare function paintRects(rgba: Uint8Array, width: number, height: number, rects: Rect[], color: [number, number, number], pad?: number): void;
/** Decode, paint, re-encode. Throws on a corrupt frame; the caller drops it. */
export declare function maskJpeg(bytes: Uint8Array, rects: Rect[], options: {
    quality: number;
    color: [number, number, number];
}): Uint8Array;
