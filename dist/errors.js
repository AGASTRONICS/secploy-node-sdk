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
 *
 * The parsing itself lives in `portable/stack.ts`, shared with the browser and
 * React Native builds. What stays here is the one part only Node can answer:
 * where the application root is.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.culpritFrom = exports.formatStack = exports.normalizeError = void 0;
exports.parseStack = parseStack;
exports.parseError = parseError;
const path_1 = require("path");
const stack_1 = require("./portable/stack");
var stack_2 = require("./portable/stack");
Object.defineProperty(exports, "normalizeError", { enumerable: true, get: function () { return stack_2.normalizeError; } });
Object.defineProperty(exports, "formatStack", { enumerable: true, get: function () { return stack_2.formatStack; } });
Object.defineProperty(exports, "culpritFrom", { enumerable: true, get: function () { return stack_2.culpritFrom; } });
function appRoot() {
    try {
        return process.cwd();
    }
    catch {
        return "";
    }
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
/** Parse a V8 `stack` string into frames, innermost last. */
function parseStack(stack, root = appRoot()) {
    return (0, stack_1.parseStack)(stack, (filename) => toModule(filename, root));
}
/** Everything above, for one thrown value. */
function parseError(thrown, root = appRoot()) {
    return (0, stack_1.parseError)(thrown, (filename) => toModule(filename, root));
}
