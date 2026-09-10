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
import { MaskMeasurement } from "./fiberMasks";
import { ScreenSource } from "./screenRecorder";
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
export declare function SecployMask(props: MarkerProps): React.ReactElement;
/**
 * Marks a subtree as safe to record.
 *
 * Opt **out** of masking, never in. Text, inputs and images everywhere else
 * stay masked. A `SecployMask` inside this masks again.
 */
export declare function SecployUnmask(props: MarkerProps): React.ReactElement;
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
export declare class SecployReplayRoot extends React.Component<RootProps> implements ScreenSource {
    private readonly view;
    componentDidMount(): void;
    componentWillUnmount(): void;
    captureTarget(): unknown | null;
    measureMasks(): Promise<MaskMeasurement>;
    render(): React.ReactNode;
}
export {};
