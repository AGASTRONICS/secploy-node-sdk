/**
 * Deciding what must not be seen on a React Native screen.
 *
 * `react-native-view-shot` returns the screen exactly as the user sees it, so
 * masking is a step performed on the captured frame (see `jpegMask.ts`). This
 * file answers the question that step needs: where, in the frame, is anything
 * that must be painted over?
 *
 * The rule is the Flutter SDK's, for the same reason: **mask by default, opt
 * out explicitly.** Every text, text input, image, web view, video, map and
 * camera is masked unless it sits inside `SecployUnmask`; anything inside
 * `SecployMask` is masked whatever it is. The failure mode of the other
 * default is a credential on a support ticket.
 *
 * React Native offers no public API to enumerate the views on screen, so this
 * walks React's own fiber tree. That is an internal structure, and the code is
 * written for the day it changes: every step that cannot find what it expects
 * reports failure, and a failed walk means the frame is dropped - never sent
 * unmasked. A half-walked tree means an unknown set of regions was missed,
 * which is indistinguishable from a clean screen.
 *
 * Nothing here imports React or React Native, so it is testable in plain Node
 * against hand-built fiber trees.
 */

/** The parts of a React fiber this module reads. */
export interface FiberLike {
  tag?: number;
  type?: unknown;
  stateNode?: any;
  child?: FiberLike | null;
  sibling?: FiberLike | null;
  return?: FiberLike | null;
}

/** React's WorkTag values. Stable since React 16. */
export const HOST_ROOT = 3;
export const HOST_COMPONENT = 5;

/**
 * Host view names that always hide their content.
 *
 * Matched by pattern on the native view name rather than an exact list, the
 * same trade the Flutter SDK makes by matching on type names: the names differ
 * between iOS and Android and between the old and new architectures
 * (`RCTText`, `RCTSinglelineTextInputView`, `AndroidTextInput`,
 * `RCTImageView`, `RNCWebView`, `RCTVideo`, `AIRMap`...). A pattern that
 * over-matches masks a region too many; an exact list that misses one ships
 * someone's data.
 */
export const MASKED_HOST_TYPES = /text|image|webview|video|camera|map|pdf/i;

/** Walk budget. A screen deeper than this is refused rather than half-walked. */
const MAX_FIBERS = 50_000;

export interface Measurable {
  measureInWindow(
    callback: (x: number, y: number, width: number, height: number) => void,
  ): void;
}

export interface MaskTarget {
  instance: Measurable;
  /** Diagnostics only; never travels with a frame. */
  reason: string;
}

export type MaskWalk =
  | { ok: true; targets: MaskTarget[] }
  | { ok: false; reason: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MaskMeasurement =
  | { ok: true; root: { width: number; height: number }; rects: Rect[] }
  | { ok: false; reason: string };

/**
 * The measurable public instance behind a host fiber's `stateNode`.
 *
 * The shape differs by architecture: the old one stores the public instance
 * directly; Fabric stores `{ node, canonical }`, and React 19 moved the public
 * instance one level further in. Tried in turn; none matching is a failure.
 */
export function hostInstance(stateNode: any): Measurable | null {
  const candidates = [
    stateNode,
    stateNode?.canonical,
    stateNode?.canonical?.publicInstance,
    stateNode?.publicInstance,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.measureInWindow === "function") {
      return candidate as Measurable;
    }
  }
  return null;
}

/**
 * The fiber for a class component instance, in React's *current* tree.
 *
 * `instance._reactInternals` points at one of the component's two fibers, and
 * after an update it may be the stale one - whose children are the screen as
 * it was, not as it is. Walking that would miss a text node added since, and
 * send it unmasked. So the walk climbs to the root, takes `root.current`,
 * which React keeps pointing at the committed tree, and finds the component
 * again from there.
 */
export function currentFiberOf(componentInstance: any): FiberLike | null {
  const fiber: FiberLike | undefined =
    componentInstance?._reactInternals ?? componentInstance?._reactInternalFiber;
  if (!fiber) return null;

  let node: FiberLike = fiber;
  for (let guard = 0; node.return && guard < MAX_FIBERS; guard++) {
    node = node.return;
  }
  if (node.tag !== HOST_ROOT) return null;

  const root: FiberLike | undefined = node.stateNode?.current;
  if (!root) return null;

  const stack: FiberLike[] = [root];
  for (let visited = 0; stack.length > 0 && visited < MAX_FIBERS; visited++) {
    const next = stack.pop()!;
    if (next.stateNode === componentInstance) return next;
    if (next.sibling) stack.push(next.sibling);
    if (next.child) stack.push(next.child);
  }
  return null;
}

/** The first host fiber at or below `fiber`, within its own subtree. */
function firstHostDescendant(fiber: FiberLike): FiberLike | null {
  const stack: FiberLike[] = fiber.child ? [fiber.child] : [];
  for (let visited = 0; stack.length > 0 && visited < MAX_FIBERS; visited++) {
    const next = stack.pop()!;
    if (next.tag === HOST_COMPONENT) return next;
    if (next.sibling) stack.push(next.sibling);
    if (next.child) stack.push(next.child);
  }
  return null;
}

/**
 * Everything under `subtreeRoot` that must be painted over.
 *
 * `markers` are the `SecployMask` and `SecployUnmask` component functions,
 * recognised by identity on `fiber.type`.
 */
export function collectMaskTargets(
  subtreeRoot: FiberLike,
  markers: { mask: unknown; unmask: unknown },
): MaskWalk {
  const targets: MaskTarget[] = [];
  // [fiber, whether an ancestor unmasked it]
  const stack: Array<[FiberLike, boolean]> = [];
  if (subtreeRoot.child) stack.push([subtreeRoot.child, false]);

  let visited = 0;
  try {
    while (stack.length > 0) {
      if (++visited > MAX_FIBERS) return { ok: false, reason: "tree_too_large" };

      const [fiber, unmaskedByAncestor] = stack.pop()!;
      // A sibling inherits the parent's state, not this fiber's.
      if (fiber.sibling) stack.push([fiber.sibling, unmaskedByAncestor]);

      if (fiber.type === markers.mask) {
        // A forced mask covers its whole subtree. Descending would only add
        // rects inside a region already painted over.
        const host = firstHostDescendant(fiber);
        if (!host) continue; // renders nothing, so nothing to hide
        const instance = hostInstance(host.stateNode);
        if (!instance) return { ok: false, reason: "unmeasurable_mask" };
        targets.push({ instance, reason: "SecployMask" });
        continue;
      }

      const unmasked = unmaskedByAncestor || fiber.type === markers.unmask;

      if (
        !unmasked &&
        fiber.tag === HOST_COMPONENT &&
        typeof fiber.type === "string" &&
        MASKED_HOST_TYPES.test(fiber.type)
      ) {
        const instance = hostInstance(fiber.stateNode);
        if (!instance) return { ok: false, reason: "unmeasurable_host" };
        targets.push({ instance, reason: fiber.type });
        // Nested text is virtual and lies inside this one's rectangle.
        continue;
      }

      if (fiber.child) stack.push([fiber.child, unmasked]);
    }
  } catch {
    return { ok: false, reason: "walk_failed" };
  }

  return { ok: true, targets };
}

function measure(instance: Measurable, timeoutMs: number): Promise<Rect | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    try {
      instance.measureInWindow((x, y, width, height) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const values = [x, y, width, height];
        resolve(values.every((v) => Number.isFinite(v)) ? { x, y, width, height } : null);
      });
    } catch {
      settled = true;
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Measure every target, relative to the captured root, in layout units.
 *
 * One unmeasurable target fails the whole measurement. A rectangle that could
 * not be placed is a rectangle that would not be painted.
 */
export async function measureTargets(
  targets: MaskTarget[],
  root: Measurable,
  timeoutMs = 1000,
): Promise<MaskMeasurement> {
  const rootRect = await measure(root, timeoutMs);
  if (!rootRect || rootRect.width <= 0 || rootRect.height <= 0) {
    return { ok: false, reason: "root_not_laid_out" };
  }

  const measured = await Promise.all(
    targets.map((target) => measure(target.instance, timeoutMs)),
  );
  if (measured.some((rect) => rect === null)) {
    return { ok: false, reason: "measure_failed" };
  }

  const rects: Rect[] = [];
  for (const rect of measured as Rect[]) {
    // Views that are laid out but empty - collapsed, off to one side - have
    // nothing to hide.
    if (rect.width <= 0 || rect.height <= 0) continue;
    rects.push({
      x: rect.x - rootRect.x,
      y: rect.y - rootRect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  return {
    ok: true,
    root: { width: rootRect.width, height: rootRect.height },
    rects,
  };
}
