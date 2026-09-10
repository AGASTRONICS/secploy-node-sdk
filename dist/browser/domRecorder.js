"use strict";
/**
 * Session replay for the web: a DOM recording, not a screen recording.
 *
 * The mobile SDKs capture screenshots because a native app offers nothing
 * else to capture. A page does: rrweb records the DOM once and then only its
 * mutations, which costs the host page almost nothing in steady state. The
 * alternative - rasterising the DOM to an image every second - means
 * serialising and re-rendering the whole document on the main thread of
 * somebody else's page, every second, forever, to support a feature that is
 * used only when an error fires.
 *
 * **Masking happens before the recording exists.** rrweb replaces masked text
 * and input values while it serialises the DOM, so the real characters are
 * never in an event, never in this buffer and never on the wire. That is
 * stronger than the mobile SDKs can manage, where an unmasked bitmap exists for
 * a moment before it is painted over.
 *
 * **Error-buffer mode only**, as on mobile. Events are held in memory and
 * thrown away; only an error causes an upload. What makes that work for a DOM
 * recording is the checkout: a recording is playable only from a full
 * snapshot, so rrweb is asked to take a fresh one every `bufferSeconds`, and
 * two generations are kept - the previous checkout and the current one. The
 * window uploaded for an error therefore always begins with a snapshot and
 * covers between one and two buffer lengths of history.
 *
 * rrweb is not imported here. The application passes its `record` function in,
 * so the package carries no hard dependency on it and a page that leaves
 * replay off ships none of its code.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomReplayRecorder = exports.WEB_REPLAY_DEFAULTS = void 0;
exports.isUnmasked = isUnmasked;
exports.mediaBlockSelector = mediaBlockSelector;
exports.buildRecordOptions = buildRecordOptions;
exports.gzip = gzip;
const sha256_1 = require("../portable/sha256");
const segment_1 = require("../replay/segment");
const uploader_1 = require("../replay/uploader");
exports.WEB_REPLAY_DEFAULTS = {
    bufferSeconds: 30,
    maxBufferBytes: 8 * 1024 * 1024,
    maxSegmentBytes: 2 * 1024 * 1024,
    maskAllText: true,
    blockMedia: true,
    maskSelector: "[data-secploy-mask]",
    unmaskSelector: "[data-secploy-unmask]",
    blockSelector: "[data-secploy-block]",
};
/** rrweb's EventType values this module cares about. */
const FULL_SNAPSHOT = 2;
const META = 4;
/** Frames are chunks of the event stream, each under this many characters. */
const CHUNK_CHARS = 256 * 1024;
const MEDIA = ["img", "picture", "video", "audio", "canvas", "iframe", "embed", "object"];
function safeClosest(element, selector) {
    try {
        return element && typeof element.closest === "function"
            ? element.closest(selector)
            : null;
    }
    catch {
        return null;
    }
}
/**
 * Whether an element sits in an unmasked region, with the nearer marker
 * winning - a `data-secploy-mask` inside an unmasked card masks again.
 */
function isUnmasked(element, options) {
    const unmask = safeClosest(element, options.unmaskSelector || exports.WEB_REPLAY_DEFAULTS.unmaskSelector);
    if (!unmask)
        return false;
    const mask = safeClosest(element, options.maskSelector || exports.WEB_REPLAY_DEFAULTS.maskSelector);
    if (!mask)
        return true;
    // Both apply: whichever is deeper is nearer. If the mask region contains the
    // unmask region, the unmask is nearer.
    try {
        return mask !== unmask && typeof mask.contains === "function" && mask.contains(unmask);
    }
    catch {
        return false;
    }
}
function selectorWorks(selector) {
    try {
        const doc = globalThis.document;
        if (!doc || typeof doc.createDocumentFragment !== "function")
            return true;
        doc.createDocumentFragment().querySelector(selector);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The block selector for media, honouring unmasked regions.
 *
 * `:not()` with a complex selector inside is Selectors Level 4. A browser that
 * rejects it would make rrweb throw on every node, so it is tested first and
 * the fallback blocks all media - more than asked for, which is the safe way to
 * be wrong.
 */
function mediaBlockSelector(unmaskSelector) {
    const scoped = MEDIA.map((tag) => `${tag}:not(${unmaskSelector} *):not(${unmaskSelector})`).join(",");
    return selectorWorks(scoped) ? scoped : MEDIA.join(",");
}
/** rrweb's options, with the privacy settings this SDK will not let slip. */
function buildRecordOptions(options, emit, onRecorderError = () => undefined) {
    const blockSelectors = [options.blockSelector];
    if (options.blockMedia)
        blockSelectors.push(mediaBlockSelector(options.unmaskSelector));
    const maskChars = (text) => text.replace(/\S/g, "*");
    return {
        // Cheaper traffic by default; the application may tune it.
        sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
        slimDOMOptions: "all",
        ...options.recordOptions,
        emit,
        checkoutEveryNms: options.bufferSeconds * 1000,
        // Every input value is masked, and password fields cannot be unmasked at
        // all. `maskInputFn` is consulted for each input rrweb has already decided
        // to mask; it gives back the real value only inside an unmasked region.
        maskAllInputs: true,
        maskInputFn: (text, element) => {
            const type = String(element?.type ?? element?.getAttribute?.("type") ?? "").toLowerCase();
            if (type !== "password" && isUnmasked(element, options))
                return text;
            return "*".repeat(String(text ?? "").length);
        },
        maskTextSelector: options.maskAllText ? "*" : options.maskSelector,
        maskTextFn: (text, element) => isUnmasked(element, options) ? text : maskChars(String(text ?? "")),
        blockSelector: blockSelectors.filter(Boolean).join(","),
        // Heavier capture that would need its own masking story. Off, whatever
        // recordOptions said.
        recordCanvas: false,
        inlineImages: false,
        collectFonts: false,
        // An error inside rrweb is ours, not the application's. Swallowed and
        // counted rather than surfacing as an issue in their project.
        errorHandler: (error) => {
            onRecorderError(error);
            return true;
        },
    };
}
const newGeneration = () => ({
    events: [],
    bytes: 0,
    firstTs: null,
    lastTs: null,
    hasSnapshot: false,
    width: 0,
    height: 0,
});
function encodeText(text) {
    const Encoder = globalThis.TextEncoder;
    return Encoder ? new Encoder().encode(text) : (0, sha256_1.utf8Encode)(text);
}
/** gzip via the platform's CompressionStream, or null where there is none. */
async function gzip(bytes) {
    const g = globalThis;
    if (!g.CompressionStream || !g.Blob || !g.Response)
        return null;
    try {
        const stream = new g.Blob([bytes]).stream().pipeThrough(new g.CompressionStream("gzip"));
        return new Uint8Array(await new g.Response(stream).arrayBuffer());
    }
    catch {
        return null;
    }
}
class DomReplayRecorder {
    constructor(args) {
        this.previous = null;
        this.current = newGeneration();
        this.stopRecording = null;
        this.recording = false;
        this.uploading = false;
        this.forcingCheckout = false;
        /**
         * Set when the deployment, the plan, the credentials or the page itself
         * have said no. None of those change mid-session.
         */
        this.stoppedReason = null;
        this.counters = {
            events: 0,
            unserializable: 0,
            generationsEvicted: 0,
            recorderErrors: 0,
            segmentsUploaded: 0,
            segmentsTooLarge: 0,
        };
        this.options = { ...exports.WEB_REPLAY_DEFAULTS, ...args.options };
        for (const [key, value] of Object.entries(exports.WEB_REPLAY_DEFAULTS)) {
            if (this.options[key] === undefined)
                this.options[key] = value;
        }
        this.sessionId = args.sessionId;
        this.uploader = args.uploader;
        this.sequence = args.sequence;
        this.emit = args.emit;
        this.onDiagnostic = args.onDiagnostic ?? (() => undefined);
        this.compress = args.compress ?? gzip;
    }
    get active() {
        return this.recording && this.stoppedReason === null;
    }
    start() {
        if (this.recording || this.stoppedReason)
            return this.recording;
        try {
            const stop = this.options.record(buildRecordOptions(this.options, (event, isCheckout) => this.onEvent(event, isCheckout), () => {
                this.counters.recorderErrors++;
            }));
            this.stopRecording = typeof stop === "function" ? stop : null;
            // rrweb emits its first snapshot synchronously, inside `record()`. If
            // that snapshot alone halted the recorder, the halt ran before there was
            // a stop handle to call - so rrweb is still observing the page, and has
            // to be stopped now that the handle exists.
            if (this.stoppedReason) {
                this.stop();
                return false;
            }
            this.recording = true;
        }
        catch (error) {
            this.halt("record_failed");
            this.onDiagnostic(`Session replay could not start: ${error}`);
        }
        return this.recording;
    }
    stop() {
        try {
            this.stopRecording?.();
        }
        catch {
            // Tearing down rrweb must not break the application's shutdown.
        }
        this.stopRecording = null;
        this.recording = false;
        this.previous = null;
        this.current = newGeneration();
    }
    halt(reason) {
        this.stoppedReason = reason;
        this.stop();
    }
    /** rrweb's emit callback. Must be cheap and must never throw. */
    onEvent(event, isCheckout) {
        if (this.stoppedReason)
            return;
        let json;
        try {
            json = JSON.stringify(event);
        }
        catch {
            this.counters.unserializable++;
            return;
        }
        if (typeof json !== "string")
            return;
        // A checkout begins with a Meta event. That is where a generation turns
        // over, so the new one starts with the snapshot that makes it playable.
        if (isCheckout && event?.type === META) {
            this.previous = this.current;
            this.current = newGeneration();
        }
        const generation = this.current;
        generation.events.push(json);
        generation.bytes += json.length;
        this.counters.events++;
        const ts = Number(event?.timestamp);
        if (Number.isFinite(ts)) {
            if (generation.firstTs === null)
                generation.firstTs = ts;
            generation.lastTs = ts;
        }
        if (event?.type === META) {
            generation.width = Number(event?.data?.width) || generation.width;
            generation.height = Number(event?.data?.height) || generation.height;
        }
        if (event?.type === FULL_SNAPSHOT)
            generation.hasSnapshot = true;
        this.enforceBudget();
    }
    /**
     * Keep the held events under `maxBufferBytes`.
     *
     * The previous generation goes first; it is the older history. If the
     * current one alone is over, a new checkout is forced, which turns it into
     * the previous generation and then evicts it. A page whose single snapshot
     * exceeds the budget cannot be recorded inside it at all, and recording
     * stops rather than churning snapshots on every event.
     */
    enforceBudget() {
        const max = this.options.maxBufferBytes;
        if (this.previous && this.previous.bytes + this.current.bytes > max) {
            this.previous = null;
            this.counters.generationsEvicted++;
        }
        if (this.current.bytes <= max || this.forcingCheckout)
            return;
        if (this.current.events.length <= 2) {
            this.halt("page_too_large");
            this.onDiagnostic("Session replay stopped: one snapshot of this page exceeds maxBufferBytes");
            return;
        }
        this.forcingCheckout = true;
        try {
            if (this.options.record.takeFullSnapshot) {
                this.options.record.takeFullSnapshot(true);
            }
            else {
                this.current = newGeneration();
            }
        }
        catch {
            this.current = newGeneration();
        }
        finally {
            this.forcingCheckout = false;
        }
        if (this.previous && this.previous.bytes + this.current.bytes > max) {
            this.previous = null;
            this.counters.generationsEvicted++;
        }
        if (this.current.bytes > max) {
            this.halt("page_too_large");
        }
    }
    /** Chunk, encode and (where possible) compress a run of events. */
    async pack(generations) {
        const frames = [];
        let chunk = [];
        let chunkChars = 0;
        const raw = [];
        const closeChunk = () => {
            if (chunk.length === 0)
                return;
            raw.push(encodeText(`[${chunk.join(",")}]`));
            chunk = [];
            chunkChars = 0;
        };
        for (const generation of generations) {
            for (const json of generation.events) {
                if (chunkChars + json.length > CHUNK_CHARS && chunk.length > 0)
                    closeChunk();
                chunk.push(json);
                chunkChars += json.length + 1;
            }
        }
        closeChunk();
        if (raw.length === 0)
            return null;
        let codec = "rrweb+gzip";
        for (const bytes of raw) {
            const compressed = await this.compress(bytes);
            if (!compressed) {
                codec = "rrweb";
                break;
            }
            frames.push(compressed);
        }
        if (codec === "rrweb") {
            frames.length = 0;
            frames.push(...raw);
        }
        const bytes = frames.reduce((total, frame) => total + frame.length + 4, 0);
        return { frames, codec, bytes };
    }
    /**
     * Upload the window that led to an error.
     *
     * Returns the object key, or null if nothing was sent. Never throws: it is
     * called from the error path.
     */
    async flushForError(errorEventId) {
        if (!this.active)
            return null;
        // One upload at a time. A crash often produces several errors within a few
        // milliseconds, and each would otherwise drain a window the first had taken.
        if (this.uploading)
            return null;
        const previous = this.previous?.hasSnapshot ? this.previous : null;
        const current = this.current;
        const candidates = previous ? [previous, current] : current.hasSnapshot ? [current] : [];
        if (candidates.length === 0)
            return null;
        // Take the window and start a new one with its own snapshot, so an error a
        // few seconds from now is playable too rather than waiting for a checkout.
        this.previous = null;
        this.current = newGeneration();
        this.uploading = true;
        try {
            try {
                this.options.record.takeFullSnapshot?.(true);
            }
            catch {
                // The next scheduled checkout will provide one.
            }
            const headroom = 2048;
            let window = candidates;
            let packed = await this.pack(window);
            if (packed && packed.bytes + headroom > this.options.maxSegmentBytes && window.length > 1) {
                // Too large with both generations: the current one alone still starts
                // with a snapshot and holds the seconds nearest the error.
                window = [current];
                packed = await this.pack(window);
            }
            if (!packed)
                return null;
            if (packed.bytes + headroom > this.options.maxSegmentBytes) {
                this.counters.segmentsTooLarge++;
                this.onDiagnostic(`Replay segment of ~${packed.bytes} bytes exceeds maxSegmentBytes; not uploaded`);
                return null;
            }
            const first = window[0];
            const last = window[window.length - 1];
            const startedAt = first.firstTs ?? Date.now();
            const durationMs = Math.max(0, (last.lastTs ?? startedAt) - startedAt);
            const sized = window.find((g) => g.width > 0 && g.height > 0);
            const eventCount = window.reduce((total, g) => total + g.events.length, 0);
            const header = {
                session_id: this.sessionId,
                seq: this.sequence.peek(),
                started_at: new Date(startedAt).toISOString(),
                // The width and height the index requires. For a DOM recording that is
                // the viewport, which the player uses for its aspect ratio.
                width: Math.min(10000, Math.max(1, sized?.width ?? 1)),
                height: Math.min(10000, Math.max(1, sized?.height ?? 1)),
                frame_count: packed.frames.length,
                frame_interval_ms: 0,
                codec: packed.codec,
            };
            const bytes = (0, segment_1.writeSegment)(header, packed.frames);
            const outcome = await this.uploader.upload({ header, bytes, durationMs });
            if (!outcome.objectKey) {
                if (outcome.permanent) {
                    this.halt(outcome.failure ?? "rejected");
                    this.onDiagnostic(`Session replay stopped for this session: ${outcome.failure}`);
                }
                return null;
            }
            this.sequence.commit();
            this.counters.segmentsUploaded++;
            // Object first, index second. See uploader.ts.
            this.emit("replay.segment", (0, uploader_1.replaySegmentEvent)({
                header,
                objectKey: outcome.objectKey,
                byteSize: bytes.length,
                durationMs,
                errorEventId,
                extra: { event_count: eventCount },
            }));
            return outcome.objectKey;
        }
        catch (error) {
            this.onDiagnostic(`Replay upload failed: ${error}`);
            return null;
        }
        finally {
            this.uploading = false;
        }
    }
    diagnostics() {
        return {
            kind: "dom",
            recording: this.recording,
            stopped_reason: this.stoppedReason,
            buffered_bytes: (this.previous?.bytes ?? 0) + this.current.bytes,
            buffered_events: (this.previous?.events.length ?? 0) + this.current.events.length,
            ...this.counters,
        };
    }
}
exports.DomReplayRecorder = DomReplayRecorder;
