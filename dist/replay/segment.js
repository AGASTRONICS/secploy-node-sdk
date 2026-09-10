"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SegmentFormatError = exports.DOM_CODECS = exports.IMAGE_CODECS = exports.SEGMENT_VERSION = exports.SEGMENT_MAGIC = void 0;
exports.segmentSize = segmentSize;
exports.writeSegment = writeSegment;
exports.readSegment = readSegment;
const sha256_1 = require("../portable/sha256");
exports.SEGMENT_MAGIC = [0x53, 0x52, 0x30, 0x31]; // "SR01"
exports.SEGMENT_VERSION = 1;
/** Frames are encoded screenshots. */
exports.IMAGE_CODECS = ["png", "jpeg", "webp"];
/** Frames are chunks of an rrweb event stream. */
exports.DOM_CODECS = ["rrweb", "rrweb+gzip"];
class SegmentFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = "SegmentFormatError";
    }
}
exports.SegmentFormatError = SegmentFormatError;
/**
 * The header as JSON, with keys in the order the Dart writer uses.
 *
 * Nothing reads the order. It is kept identical so that two segments of the
 * same recording from two SDKs can be diffed byte for byte when one of them is
 * suspected of being wrong.
 */
function headerJson(header) {
    return JSON.stringify({
        session_id: header.session_id,
        seq: header.seq,
        started_at: header.started_at,
        width: header.width,
        height: header.height,
        frame_count: header.frame_count,
        frame_interval_ms: header.frame_interval_ms,
        codec: header.codec,
    });
}
/** The size `writeSegment` will produce, without producing it. */
function segmentSize(header, frameLengths) {
    let total = exports.SEGMENT_MAGIC.length + 2 + 4 + (0, sha256_1.utf8Encode)(headerJson(header)).length;
    for (const length of frameLengths)
        total += 4 + length;
    return total;
}
/** Pack a segment into its wire form. */
function writeSegment(header, frames) {
    if (header.frame_count !== frames.length) {
        // The reader loops `frame_count` times. A mismatch is a segment that
        // parses as truncated or silently drops its tail.
        throw new SegmentFormatError(`header says ${header.frame_count} frames, ${frames.length} given`);
    }
    const headerBytes = (0, sha256_1.utf8Encode)(headerJson(header));
    let total = exports.SEGMENT_MAGIC.length + 2 + 4 + headerBytes.length;
    for (const frame of frames)
        total += 4 + frame.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let offset = 0;
    out.set(exports.SEGMENT_MAGIC, offset);
    offset += exports.SEGMENT_MAGIC.length;
    view.setUint16(offset, exports.SEGMENT_VERSION);
    offset += 2;
    view.setUint32(offset, headerBytes.length);
    offset += 4;
    out.set(headerBytes, offset);
    offset += headerBytes.length;
    for (const frame of frames) {
        view.setUint32(offset, frame.length);
        offset += 4;
        out.set(frame, offset);
        offset += frame.length;
    }
    return out;
}
function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") {
        return new TextDecoder().decode(bytes);
    }
    // The header is JSON the SDK wrote; ASCII in practice. Good enough for the
    // test-only reader on a runtime without TextDecoder.
    let text = "";
    for (let i = 0; i < bytes.length; i++)
        text += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(text));
}
/**
 * Unpack a segment.
 *
 * Present so the writer can be tested against a reader, and so a support
 * engineer can open a segment from a bucket in a Node REPL. Throws rather than
 * returning a partial result.
 */
function readSegment(bytes) {
    if (bytes.length < exports.SEGMENT_MAGIC.length + 6) {
        throw new SegmentFormatError("too short to be a segment");
    }
    for (let i = 0; i < exports.SEGMENT_MAGIC.length; i++) {
        if (bytes[i] !== exports.SEGMENT_MAGIC[i]) {
            throw new SegmentFormatError("bad magic; not an .sr1 segment");
        }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = exports.SEGMENT_MAGIC.length;
    const version = view.getUint16(offset);
    offset += 2;
    if (version !== exports.SEGMENT_VERSION) {
        throw new SegmentFormatError(`unsupported segment version ${version}`);
    }
    const headerLength = view.getUint32(offset);
    offset += 4;
    if (offset + headerLength > bytes.length) {
        throw new SegmentFormatError("header runs past the end of the segment");
    }
    let header;
    try {
        header = JSON.parse(utf8Decode(bytes.subarray(offset, offset + headerLength)));
    }
    catch {
        throw new SegmentFormatError("segment header is not valid JSON");
    }
    offset += headerLength;
    const frames = [];
    for (let i = 0; i < header.frame_count; i++) {
        if (offset + 4 > bytes.length) {
            throw new SegmentFormatError("frame length runs past the end");
        }
        const length = view.getUint32(offset);
        offset += 4;
        if (offset + length > bytes.length) {
            throw new SegmentFormatError("frame runs past the end");
        }
        frames.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    return { header, frames };
}
