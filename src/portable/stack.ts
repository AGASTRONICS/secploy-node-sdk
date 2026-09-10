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
const FRAME_NATIVE =
  /^\s*at\s+(.+?)\s+\((native|<anonymous>|unknown location)\)$/;
/** Firefox and Safari: `fn@https://host/app.js:10:5`, or `@...` when anonymous. */
const FRAME_GECKO = /^\s*(.*?)@(.+?):(\d+)(?::(\d+))?\s*$/;

/**
 * Read a string property without trusting the object.
 *
 * Property access can run arbitrary code - a getter, a Proxy trap - and the one
 * place that must never throw is the code describing something that already
 * went wrong.
 */
function readStringProperty(source: unknown, key: string): string | null {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function isVendor(filename: string): boolean {
  const lowered = filename.toLowerCase();
  if (lowered.startsWith(BUILTIN_PREFIX)) return true;
  return VENDOR_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * The module name when there is no application root to be relative to.
 *
 * A browser frame is a URL. The origin says nothing about the code - the same
 * bundle is served from staging and production - and a query string is a
 * cache-buster, so both are dropped and the path is what identifies the file.
 */
export function defaultModuleOf(filename: string): string {
  if (!filename || filename.startsWith("<")) return filename;

  const withoutQuery = filename.split(/[?#]/)[0];
  const withoutOrigin = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const parts = withoutOrigin.split(/[\\/]/).filter(Boolean);
  return parts.join("/") || filename;
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
 * Firefox and Safari also print innermost first, so the same reversal applies.
 */
export function parseStack(
  stack: string,
  moduleOf: ModuleOf = defaultModuleOf,
  options: ParseStackOptions = {},
): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];

  for (const line of stack.split("\n")) {
    let filename = "";
    let fn = "";
    let lineno: number | null = null;
    let colno: number | null = null;

    const withFunction = FRAME_WITH_FUNCTION.exec(line);
    const bare = withFunction ? null : FRAME_BARE.exec(line);
    const native = withFunction || bare ? null : FRAME_NATIVE.exec(line);
    const gecko =
      withFunction || bare || native || !options.gecko
        ? null
        : FRAME_GECKO.exec(line);

    if (withFunction) {
      fn = withFunction[1];
      filename = withFunction[2];
      lineno = Number(withFunction[3]);
      colno = Number(withFunction[4]);
    } else if (bare) {
      filename = bare[1];
      lineno = Number(bare[2]);
      colno = Number(bare[3]);
    } else if (native) {
      fn = native[1];
      filename = native[2];
    } else if (gecko) {
      fn = gecko[1];
      filename = gecko[2];
      lineno = Number(gecko[3]);
      colno = gecko[4] !== undefined ? Number(gecko[4]) : null;
    } else {
      continue;
    }

    // V8 decorates names with qualifiers that vary between invocations.
    fn = fn.replace(/^(async|new)\s+/, "").trim();

    frames.push({
      filename,
      module: moduleOf(filename),
      function: fn,
      lineno,
      colno,
      in_app:
        !isVendor(filename) &&
        !filename.startsWith("<") &&
        filename !== "native",
    });
  }

  // Keep the innermost frames, which are where the failure is - still V8's
  // order at this point, so that is the front.
  const kept =
    frames.length > MAX_FRAMES ? frames.slice(0, MAX_FRAMES) : frames;

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
export function normalizeError(thrown: unknown): {
  type: string;
  value: string;
  stack: string;
} {
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

    let described: string;
    try {
      described = JSON.stringify(thrown);
    } catch {
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
export function formatStack(
  type: string,
  value: string,
  frames: StackFrame[],
): string[] {
  const lines = [`${type}: ${value}`];
  // Back into V8's display order, so a person reading the raw event sees the
  // stack the way their runtime would have printed it.
  for (const frame of [...frames].reverse()) {
    const where =
      frame.lineno !== null
        ? `${frame.filename}:${frame.lineno}:${frame.colno ?? 0}`
        : frame.filename;
    lines.push(
      frame.function
        ? `    at ${frame.function} (${where})`
        : `    at ${where}`,
    );
  }
  return lines;
}

/** Everything above, for one thrown value. */
export function parseError(
  thrown: unknown,
  moduleOf: ModuleOf = defaultModuleOf,
  options: ParseStackOptions = {},
): ParsedError {
  const { type, value, stack } = normalizeError(thrown);
  const frames = parseStack(stack, moduleOf, options);

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
export function culpritFrom(frames: StackFrame[]): string {
  let frame: StackFrame | undefined;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].in_app) {
      frame = frames[i];
      break;
    }
  }
  frame = frame ?? frames[frames.length - 1];
  if (!frame) return "";
  return frame.function ? `${frame.module} in ${frame.function}` : frame.module;
}
