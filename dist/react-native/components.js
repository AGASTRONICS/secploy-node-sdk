"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecployReplayRoot = void 0;
exports.SecployMask = SecployMask;
exports.SecployUnmask = SecployUnmask;
const React = __importStar(require("react"));
const fiberMasks_1 = require("./fiberMasks");
const screenRecorder_1 = require("./screenRecorder");
// Resolved at runtime rather than imported for types. React Native ships its
// own typings, and depending on them would make every consumer of this package
// - including the Node server build - resolve react-native to typecheck.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require("react-native");
/**
 * Forces a subtree to be masked, for content the defaults do not recognise -
 * a custom-drawn chart of somebody's salary is not a Text and would not be
 * found otherwise.
 *
 * Renders a real, non-collapsable View: the recorder measures that view, and
 * Android removes views that only lay out their children unless told not to.
 */
function SecployMask(props) {
    return React.createElement(RN.View, { collapsable: false, style: props.style }, props.children);
}
/**
 * Marks a subtree as safe to record.
 *
 * Opt **out** of masking, never in. Text, inputs and images everywhere else
 * stay masked. A `SecployMask` inside this masks again.
 */
function SecployUnmask(props) {
    return React.createElement(RN.View, { collapsable: false, style: props.style }, props.children);
}
/**
 * Wrap the app so replay has something to capture.
 *
 * A class component on purpose: the recorder finds React's current fiber tree
 * through the instance, which a function component does not have.
 */
class SecployReplayRoot extends React.Component {
    constructor() {
        super(...arguments);
        this.view = React.createRef();
    }
    componentDidMount() {
        (0, screenRecorder_1.registerSource)(this);
    }
    componentWillUnmount() {
        (0, screenRecorder_1.unregisterSource)(this);
    }
    captureTarget() {
        return this.view.current ?? null;
    }
    async measureMasks() {
        const root = this.view.current;
        if (!root || typeof root.measureInWindow !== "function") {
            return { ok: false, reason: "not_mounted" };
        }
        const fiber = (0, fiberMasks_1.currentFiberOf)(this);
        if (!fiber)
            return { ok: false, reason: "fiber_unavailable" };
        const walk = (0, fiberMasks_1.collectMaskTargets)(fiber, { mask: SecployMask, unmask: SecployUnmask });
        if (!walk.ok)
            return walk;
        return (0, fiberMasks_1.measureTargets)(walk.targets, root);
    }
    render() {
        return React.createElement(RN.View, {
            ref: this.view,
            // Captured by reference, so it must survive Android's view flattening.
            collapsable: false,
            style: [{ flex: 1 }, this.props.style],
        }, this.props.children);
    }
}
exports.SecployReplayRoot = SecployReplayRoot;
