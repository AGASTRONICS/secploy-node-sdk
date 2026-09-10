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
import { ParsedError, StackFrame } from "./portable/stack";
export type { ParsedError, StackFrame } from "./portable/stack";
export { normalizeError, formatStack, culpritFrom } from "./portable/stack";
/** Parse a V8 `stack` string into frames, innermost last. */
export declare function parseStack(stack: string, root?: string): StackFrame[];
/** Everything above, for one thrown value. */
export declare function parseError(thrown: unknown, root?: string): ParsedError;
