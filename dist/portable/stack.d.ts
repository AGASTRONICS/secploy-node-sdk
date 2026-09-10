/**
 * The platform-free half of `errors.ts`: turning a thrown thing into frames.
 *
 * `errors.ts` needs Node's `path` and `process.cwd()` to decide which frames
 * sit inside the application root. A browser or a React Native bundle has
 * neither, and importing `path` into one either fails the build or drags in a
 * polyfill. So the parsing lives here with no imports, and the one
 * platform-specific decision - what to call a file - is passed in.
 *
 * Every SDK emits the same frame shape. The ingest groups on it, so a frame
 * that differed by platform would split one bug into several issues.
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
/** Maps a frame's filename to the module name reported for it. */
export type ModuleOf = (filename: string) => string;
export interface ParseStackOptions {
    /**
     * Also read the `fn@file:line:col` form that Firefox and Safari print.
     *
     * Off for Node. A V8 message line that happens to contain `user@host:1:2`
     * would otherwise be read as a frame, and Node never prints that form.
     */
    gecko?: boolean;
}
/**
 * The module name when there is no application root to be relative to.
 *
 * A browser frame is a URL. The origin says nothing about the code - the same
 * bundle is served from staging and production - and a query string is a
 * cache-buster, so both are dropped and the path is what identifies the file.
 */
export declare function defaultModuleOf(filename: string): string;
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
 * Firefox and Safari also print innermost first, so the same reversal applies.
 */
export declare function parseStack(stack: string, moduleOf?: ModuleOf, options?: ParseStackOptions): StackFrame[];
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
export declare function parseError(thrown: unknown, moduleOf?: ModuleOf, options?: ParseStackOptions): ParsedError;
/**
 * The culprit: the innermost application frame.
 *
 * "Where is this bug" nearly always means the deepest line of our own code, not
 * the framework internals underneath it. Frames are innermost-last, so this
 * searches from the end.
 */
export declare function culpritFrom(frames: StackFrame[]): string;
