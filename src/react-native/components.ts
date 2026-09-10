/**
 * The React Native components: the root that replay captures, and the two
 * markers that adjust what it masks.
 *
 * ```tsx
 * <SecployReplayRoot>
 *   <App />
 * </SecployReplayRoot>
 * ```
 *
 * Written with `createElement` rather than JSX so the package compiles with
 * plain `tsc` and ships no JSX transform assumptions.
 */

import * as React from "react";

import { collectMaskTargets, currentFiberOf, measureTargets, MaskMeasurement } from "./fiberMasks";
import { ScreenSource, registerSource, unregisterSource } from "./screenRecorder";

// Resolved at runtime rather than imported for types. React Native ships its
// own typings, and depending on them would make every consumer of this package
// - including the Node server build - resolve react-native to typecheck.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require("react-native");

interface MarkerProps {
  children?: React.ReactNode;
  style?: unknown;
}

/**
 * Forces a subtree to be masked, for content the defaults do not recognise -
 * a custom-drawn chart of somebody's salary is not a Text and would not be
 * found otherwise.
 *
 * Renders a real, non-collapsable View: the recorder measures that view, and
 * Android removes views that only lay out their children unless told not to.
 */
export function SecployMask(props: MarkerProps): React.ReactElement {
  return React.createElement(RN.View, { collapsable: false, style: props.style }, props.children);
}

/**
 * Marks a subtree as safe to record.
 *
 * Opt **out** of masking, never in. Text, inputs and images everywhere else
 * stay masked. A `SecployMask` inside this masks again.
 */
export function SecployUnmask(props: MarkerProps): React.ReactElement {
  return React.createElement(RN.View, { collapsable: false, style: props.style }, props.children);
}

interface RootProps {
  children?: React.ReactNode;
  style?: unknown;
}

/**
 * Wrap the app so replay has something to capture.
 *
 * A class component on purpose: the recorder finds React's current fiber tree
 * through the instance, which a function component does not have.
 */
export class SecployReplayRoot
  extends React.Component<RootProps>
  implements ScreenSource
{
  private readonly view = React.createRef<any>();

  componentDidMount(): void {
    registerSource(this);
  }

  componentWillUnmount(): void {
    unregisterSource(this);
  }

  captureTarget(): unknown | null {
    return this.view.current ?? null;
  }

  async measureMasks(): Promise<MaskMeasurement> {
    const root = this.view.current;
    if (!root || typeof root.measureInWindow !== "function") {
      return { ok: false, reason: "not_mounted" };
    }

    const fiber = currentFiberOf(this);
    if (!fiber) return { ok: false, reason: "fiber_unavailable" };

    const walk = collectMaskTargets(fiber, { mask: SecployMask, unmask: SecployUnmask });
    if (!walk.ok) return walk;

    return measureTargets(walk.targets, root);
  }

  render(): React.ReactNode {
    return React.createElement(
      RN.View,
      {
        ref: this.view,
        // Captured by reference, so it must survive Android's view flattening.
        collapsable: false,
        style: [{ flex: 1 }, this.props.style],
      },
      this.props.children,
    );
  }
}
