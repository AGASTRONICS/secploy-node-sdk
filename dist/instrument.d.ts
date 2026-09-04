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
import { ParsedError } from "./errors";
export interface Instrumentation {
    /** Report a captured error, returning once it has been queued. */
    capture: (parsed: ParsedError, context: Record<string, unknown>) => void;
    /** Best-effort flush before the process dies. */
    flush: () => Promise<void>;
}
export declare class GlobalErrorHandlers {
    private readonly target;
    private installed;
    private onUncaught;
    private onRejection;
    constructor(target: Instrumentation);
    install(): void;
    uninstall(): void;
    isInstalled(): boolean;
    private report;
    private flushThenRethrow;
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
    private rethrow;
}
