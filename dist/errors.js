"use strict";
/**
 * Turning a thrown thing into a reportable event.
 *
 * Two jobs. The first is accepting whatever was actually thrown: JavaScript
 * permits throwing anything, and a `throw "nope"` or a rejected promise
 * carrying a plain object is not rare in real code. Reporting those as
 * "undefined" - or worse, crashing inside the reporter - loses exactly the
 * failures nobody expected.
 *
 * The second is producing structured frames rather than a wall of text. The
 * ingest can parse a formatted stack, and does, but it has to guess which
 * frames belong to the application from path markers alone. The SDK is running
 * inside that application and simply knows: it has `process.cwd()`, it can see
 * `node_modules` in a resolved path, it knows which files are its own. Sending
 * that judgement rather than making the server infer it is both more accurate
 * and cheaper.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseStack = parseStack;
exports.normalizeError = normalizeError;
exports.formatStack = formatStack;
exports.parseError = parseError;
exports.culpritFrom = culpritFrom;
const path_1 = require("path");
/** Path fragments that mean "not our code". */
const VENDOR_MARKERS = ["node_modules", "internal/modules/cjs"];
/**
 * Node builtins arrive as `node:fs`, `node:diagnostics_channel` and so on.
 *
 * Matching only `node:internal` missed every public builtin, so a frame inside
 * the runtime could be classified as application code - and then be named as
 * the culprit, pointing at Node's own source instead of the bug.
 */
const BUILTIN_PREFIX = "node:";
/**
 * Frames beyond this are dropped.
 *
 * A deep async stack can run to hundreds of frames whose outer half is
 * identical on every occurrence, and the payload is charged for all of them.
 * The innermost frames are the ones that identify the bug.
 */
const MAX_FRAMES = 50;
const FRAME_WITH_FUNCTION = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/;
const FRAME_BARE = /^\s*at\s+(.+?):(\d+):(\d+)$/;
const FRAME_NATIVE = /^\s*at\s+(.+?)\s+\((native|<anonymous>|unknown location)\)$/;
/**
 * Read a string property without trusting the object.
 *
 * Property access can run arbitrary code - a getter, a Proxy trap - and the one
 * place that must never throw is the code describing something that already
 * went wrong.
 */
function readStringProperty(source, key) {
    try {
        const value = source[key];
        return typeof value === "string" && value ? value : null;
    }
    catch {
        return null;
    }
}
function appRoot() {
    try {
        return process.cwd();
    }
    catch {
        return "";
    }
}
function isVendor(filename) {
    const lowered = filename.toLowerCase();
    if (lowered.startsWith(BUILTIN_PREFIX))
        return true;
    return VENDOR_MARKERS.some((marker) => lowered.includes(marker));
}
function toModule(filename, root) {
    if (!filename || filename.startsWith("<"))
        return filename;
    if (root && filename.startsWith(root)) {
        const rel = (0, path_1.relative)(root, filename);
        // A relative path that climbs out of the root is not inside it.
        if (rel && !rel.startsWith(".."))
            return rel.split(path_1.sep).join("/");
    }
    // Outside the app: keep the tail, which is what identifies the module.
    const parts = filename.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/") || filename;
}
/**
 * Parse a `stack` string into frames, innermost last.
 *
 * V8 puts the message on the first line and frames after it; the message can
 * itself contain newlines, so lines are classified by shape rather than by
 * position.
 *
 * The result is reversed out of V8's native order. V8 writes the failing call
 * first; Python writes it last, and the ingest reads the last frame as "where
 * the bug is" and truncates from the front. Sending V8's order would name the
 * outermost frame as the culprit and then discard the frames that actually
 * identify the failure, so both SDKs speak the same convention: innermost last.
 */
function parseStack(stack, root = appRoot()) {
    if (!stack)
        return [];
    const frames = [];
    for (const line of stack.split("\n")) {
        let filename = "";
        let fn = "";
        let lineno = null;
        let colno = null;
        const withFunction = FRAME_WITH_FUNCTION.exec(line);
        const bare = withFunction ? null : FRAME_BARE.exec(line);
        const native = withFunction || bare ? null : FRAME_NATIVE.exec(line);
        if (withFunction) {
            fn = withFunction[1];
            filename = withFunction[2];
            lineno = Number(withFunction[3]);
            colno = Number(withFunction[4]);
        }
        else if (bare) {
            filename = bare[1];
            lineno = Number(bare[2]);
            colno = Number(bare[3]);
        }
        else if (native) {
            fn = native[1];
            filename = native[2];
        }
        else {
            continue;
        }
        // V8 decorates names with qualifiers that vary between invocations.
        fn = fn.replace(/^(async|new)\s+/, "").trim();
        frames.push({
            filename,
            module: toModule(filename, root),
            function: fn,
            lineno,
            colno,
            in_app: !isVendor(filename) &&
                !filename.startsWith("<") &&
                filename !== "native",
        });
    }
    // Keep the innermost frames, which are where the failure is - still V8's
    // order at this point, so that is the front.
    const kept = frames.length > MAX_FRAMES ? frames.slice(0, MAX_FRAMES) : frames;
    // Into the canonical order.
    return kept.reverse();
}
/**
 * Coerce anything that was thrown into an Error.
 *
 * `throw "nope"`, `Promise.reject({ code: 500 })` and `throw null` are all
 * legal and all happen. Each needs to arrive as a report rather than as a
 * second failure inside the reporter.
 */
function normalizeError(thrown) {
    if (thrown instanceof Error) {
        return {
            type: thrown.name || "Error",
            value: thrown.message || String(thrown),
            stack: thrown.stack || "",
        };
    }
    if (typeof thrown === "string") {
        return { type: "Error", value: thrown, stack: "" };
    }
    if (thrown === null || thrown === undefined) {
        return {
            type: "Error",
            value: `Non-error thrown: ${String(thrown)}`,
            stack: "",
        };
    }
    if (typeof thrown === "object") {
        // Some libraries reject with an error-shaped object that is not an Error.
        // Read the properties defensively: reading one *invokes* it if it is a
        // getter, and a getter that throws would turn describing a failure into a
        // second failure - inside the reporter, where nothing is left to catch it.
        const message = readStringProperty(thrown, "message");
        if (message !== null) {
            return {
                type: readStringProperty(thrown, "name") || "Error",
                value: message,
                stack: readStringProperty(thrown, "stack") || "",
            };
        }
        let described;
        try {
            described = JSON.stringify(thrown);
        }
        catch {
            // Circular, or a getter that throws. Never let describing a failure fail.
            described = Object.prototype.toString.call(thrown);
        }
        return {
            type: "Error",
            value: `Non-error thrown: ${described}`.slice(0, 1000),
            stack: "",
        };
    }
    return {
        type: "Error",
        value: `Non-error thrown: ${String(thrown)}`,
        stack: "",
    };
}
/**
 * Render frames back into the text form the ingest has always accepted.
 *
 * Both shapes go on the wire: the structured frames for grouping and display,
 * these strings so that an ingest that has not been updated still understands
 * the event.
 */
function formatStack(type, value, frames) {
    const lines = [`${type}: ${value}`];
    // Back into V8's display order, so a person reading the raw event sees the
    // stack the way their runtime would have printed it.
    for (const frame of [...frames].reverse()) {
        const where = frame.lineno !== null
            ? `${frame.filename}:${frame.lineno}:${frame.colno ?? 0}`
            : frame.filename;
        lines.push(frame.function
            ? `    at ${frame.function} (${where})`
            : `    at ${where}`);
    }
    return lines;
}
/** Everything above, for one thrown value. */
function parseError(thrown, root = appRoot()) {
    const { type, value, stack } = normalizeError(thrown);
    const frames = parseStack(stack, root);
    return {
        type,
        value,
        frames,
        // When there was no stack - a thrown string, a rejected plain object - the
        // formatted form is still emitted so the event is never blank.
        stacktrace: stack
            ? stack.split("\n").filter((line) => line.trim() !== "")
            : formatStack(type, value, frames),
    };
}
/**
 * The culprit: the innermost application frame.
 *
 * "Where is this bug" nearly always means the deepest line of our own code, not
 * the framework internals underneath it. Frames are innermost-last, so this
 * searches from the end.
 */
function culpritFrom(frames) {
    let frame;
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].in_app) {
            frame = frames[i];
            break;
        }
    }
    frame = frame ?? frames[frames.length - 1];
    if (!frame)
        return "";
    return frame.function ? `${frame.module} in ${frame.function}` : frame.module;
}
