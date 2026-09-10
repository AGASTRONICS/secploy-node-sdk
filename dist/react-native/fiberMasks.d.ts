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
export declare const HOST_ROOT = 3;
export declare const HOST_COMPONENT = 5;
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
export declare const MASKED_HOST_TYPES: RegExp;
export interface Measurable {
    measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}
export interface MaskTarget {
    instance: Measurable;
    /** Diagnostics only; never travels with a frame. */
    reason: string;
}
export type MaskWalk = {
    ok: true;
    targets: MaskTarget[];
} | {
    ok: false;
    reason: string;
};
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export type MaskMeasurement = {
    ok: true;
    root: {
        width: number;
        height: number;
    };
    rects: Rect[];
} | {
    ok: false;
    reason: string;
};
/**
 * The measurable public instance behind a host fiber's `stateNode`.
 *
 * The shape differs by architecture: the old one stores the public instance
 * directly; Fabric stores `{ node, canonical }`, and React 19 moved the public
 * instance one level further in. Tried in turn; none matching is a failure.
 */
export declare function hostInstance(stateNode: any): Measurable | null;
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
export declare function currentFiberOf(componentInstance: any): FiberLike | null;
/**
 * Everything under `subtreeRoot` that must be painted over.
 *
 * `markers` are the `SecployMask` and `SecployUnmask` component functions,
 * recognised by identity on `fiber.type`.
 */
export declare function collectMaskTargets(subtreeRoot: FiberLike, markers: {
    mask: unknown;
    unmask: unknown;
}): MaskWalk;
/**
 * Measure every target, relative to the captured root, in layout units.
 *
 * One unmeasurable target fails the whole measurement. A rectangle that could
 * not be placed is a rectangle that would not be painted.
 */
export declare function measureTargets(targets: MaskTarget[], root: Measurable, timeoutMs?: number): Promise<MaskMeasurement>;
