"use strict";
/**
 * Automatic error capture.
 *
 * Without this the SDK reports only what the application remembers to hand it,
 * which in practice means the errors somebody already knew about. The ones
 * worth having are the crashes nobody anticipated, and those arrive through
 * `uncaughtException` and `unhandledRejection`.
 *
 * Installing process-level handlers inside somebody else's application is
 * intrusive, so the rules here are strict:
 *
 *   * Never change whether the process exits. Node's default for an uncaught
 *     exception is to print it and die, and a monitoring library that silently
 *     converts crashes into hangs has broken the application it was meant to
 *     observe. If we are the only listener, we restore the default behaviour
 *     after reporting.
 *   * Never swallow other listeners. The handlers are added, never assigned.
 *   * Always be removable. `uninstall()` puts the process back exactly as it
 *     was, which matters for tests and for short-lived workers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GlobalErrorHandlers = void 0;
const errors_1 = require("./errors");
/**
 * How long a fatal handler waits for the report to leave before letting the
 * process die.
 *
 * The process is going down either way; this only decides whether the report
 * makes it out first. Long enough for a healthy round trip, short enough that
 * nobody notices the delay in a crash they were already going to see.
 */
const FATAL_FLUSH_TIMEOUT_MS = 2000;
class GlobalErrorHandlers {
    constructor(target) {
        this.target = target;
        this.installed = false;
        this.onUncaught = null;
        this.onRejection = null;
    }
    install() {
        if (this.installed)
            return;
        if (typeof process === "undefined" || typeof process.on !== "function")
            return;
        this.onUncaught = (error) => {
            this.report(error, "uncaughtException", true);
        };
        this.onRejection = (reason) => {
            // Not fatal by default in current Node, and the process may well carry
            // on, so this does not touch the exit path.
            this.report(reason, "unhandledRejection", false);
        };
        process.on("uncaughtException", this.onUncaught);
        process.on("unhandledRejection", this.onRejection);
        this.installed = true;
    }
    uninstall() {
        if (!this.installed)
            return;
        if (this.onUncaught)
            process.removeListener("uncaughtException", this.onUncaught);
        if (this.onRejection)
            process.removeListener("unhandledRejection", this.onRejection);
        this.onUncaught = null;
        this.onRejection = null;
        this.installed = false;
    }
    isInstalled() {
        return this.installed;
    }
    report(thrown, mechanism, fatal) {
        let parsed;
        try {
            parsed = (0, errors_1.parseError)(thrown);
            this.target.capture(parsed, {
                mechanism,
                handled: false,
                // An uncaught exception ends the process; an unhandled rejection
                // usually does not. Triage differs, so the distinction is recorded.
                level: fatal ? "fatal" : "error",
            });
        }
        catch (reportingFailure) {
            // A crash inside the crash reporter must not replace the crash. Say so
            // and get out of the way.
            // eslint-disable-next-line no-console
            console.error("[secploy] Failed to report an uncaught error:", reportingFailure);
            if (fatal)
                this.rethrow(thrown);
            return;
        }
        if (fatal) {
            void this.flushThenRethrow(thrown);
        }
    }
    async flushThenRethrow(thrown) {
        try {
            await Promise.race([
                this.target.flush(),
                new Promise((resolve) => setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS)),
            ]);
        }
        catch {
            // The report did not make it. The crash still has to.
        }
        this.rethrow(thrown);
    }
    /**
     * Restore Node's default behaviour for an uncaught exception.
     *
     * Registering a listener suppresses the default crash. If this SDK is the
     * only listener, staying silent would turn every crash into a process that
     * limps on in an undefined state - a far worse outcome than the crash. So
     * when nobody else is listening, the error is re-raised outside the handler
     * where the default action applies.
     *
     * If the application has its own handler, that is a deliberate choice about
     * how it wants to die, and this leaves it alone.
     */
    rethrow(thrown) {
        const listeners = process.listenerCount("uncaughtException");
        // Only us: nothing else will act on it.
        if (listeners > 1)
            return;
        // Outside the handler, so the default action applies rather than
        // re-entering this same listener.
        setTimeout(() => {
            if (this.onUncaught)
                process.removeListener("uncaughtException", this.onUncaught);
            throw thrown;
        }, 0);
    }
}
exports.GlobalErrorHandlers = GlobalErrorHandlers;
