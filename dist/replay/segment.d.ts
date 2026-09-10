/**
 * The `.sr1` segment container, written from JavaScript.
 *
 * The third implementation of one format: `segment.dart` in the Dart SDK
 * writes it, `lib/replay/segment.ts` in the dashboard reads it, and this file
 * does both for the browser and React Native builds. The three are held
 * together only by the layout below, so it is repeated here verbatim:
 *
 *     "SR01"                     4 bytes, magic
 *     version                    uint16 big-endian
 *     header length              uint32 big-endian
 *     header                     UTF-8 JSON, `header length` bytes
 *     repeated, `frame_count` times:
 *       frame length             uint32 big-endian
 *       frame bytes              `frame length` bytes
 *
 * What a "frame" holds is named by the header's `codec`:
 *
 * - `png` / `jpeg` - one encoded screenshot per frame (Flutter, React Native).
 * - `rrweb` / `rrweb+gzip` - a JSON array of rrweb DOM events per frame,
 *   gzip-compressed in the second form (web). Frames are chunks of one event
 *   stream and are concatenated by the player in order.
 *
 * The container is identical either way, which is the point of `codec`: the
 * signing, the index, the retention sweep and the manifest never need to know
 * what kind of recording they are carrying.
 */
export declare const SEGMENT_MAGIC: number[];
export declare const SEGMENT_VERSION = 1;
/** Frames are encoded screenshots. */
export declare const IMAGE_CODECS: readonly ["png", "jpeg", "webp"];
/** Frames are chunks of an rrweb event stream. */
export declare const DOM_CODECS: readonly ["rrweb", "rrweb+gzip"];
export interface SegmentHeader {
    /** Already hashed by the SDK. This is what joins the segment to its issue. */
    session_id: string;
    seq: number;
    /** ISO 8601, UTC. */
    started_at: string;
    /** Pixel dimensions of the frames, or of the viewport for a DOM recording. */
    width: number;
    height: number;
    frame_count: number;
    /**
     * Nominal gap between image frames. Zero for a DOM recording, whose events
     * carry their own timestamps.
     */
    frame_interval_ms: number;
    codec: string;
}
export interface Segment {
    header: SegmentHeader;
    frames: Uint8Array[];
}
export declare class SegmentFormatError extends Error {
    constructor(message: string);
}
/** The size `writeSegment` will produce, without producing it. */
export declare function segmentSize(header: SegmentHeader, frameLengths: number[]): number;
/** Pack a segment into its wire form. */
export declare function writeSegment(header: SegmentHeader, frames: Uint8Array[]): Uint8Array;
/**
 * Unpack a segment.
 *
 * Present so the writer can be tested against a reader, and so a support
 * engineer can open a segment from a bucket in a Node REPL. Throws rather than
 * returning a partial result.
 */
export declare function readSegment(bytes: Uint8Array): Segment;
