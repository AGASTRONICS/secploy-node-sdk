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
/** One stack frame, already classified. */
export interface StackFrame {
    /** File as the runtime reported it. */
    filename: string;
    /** Path relative to the application root, when it is inside it. */
    module: string;
    function: string;
    lineno: number | null;
    colno: number | null;
    /**
     * Whether this frame is the application's own code.
     *
     * Decided here rather than on the server. Grouping leans on this: an error's
     * identity should not change because a dependency was upgraded and its line
     * numbers moved.
     */
    in_app: boolean;
}
/** Everything worth knowing about one thrown value. */
export interface ParsedError {
    type: string;
    value: string;
    frames: StackFrame[];
    /**
     * The formatted stack, as the ingest has always received it. Kept alongside
     * the structured frames so an older ingest still groups these events and a
     * person reading the raw event still sees something familiar.
     */
    stacktrace: string[];
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
export declare function parseStack(stack: string, root?: string): StackFrame[];
/**
 * Coerce anything that was thrown into an Error.
 *
 * `throw "nope"`, `Promise.reject({ code: 500 })` and `throw null` are all
 * legal and all happen. Each needs to arrive as a report rather than as a
 * second failure inside the reporter.
 */
export declare function normalizeError(thrown: unknown): {
    type: string;
    value: string;
    stack: string;
};
/**
 * Render frames back into the text form the ingest has always accepted.
 *
 * Both shapes go on the wire: the structured frames for grouping and display,
 * these strings so that an ingest that has not been updated still understands
 * the event.
 */
export declare function formatStack(type: string, value: string, frames: StackFrame[]): string[];
/** Everything above, for one thrown value. */
export declare function parseError(thrown: unknown, root?: string): ParsedError;
/**
 * The culprit: the innermost application frame.
 *
 * "Where is this bug" nearly always means the deepest line of our own code, not
 * the framework internals underneath it. Frames are innermost-last, so this
 * searches from the end.
 */
export declare function culpritFrom(frames: StackFrame[]): string;
