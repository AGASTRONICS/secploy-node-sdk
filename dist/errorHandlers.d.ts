/**
 * Framework error handlers.
 *
 * A web framework catches what a request handler throws and turns it into a
 * 500. That is exactly the moment the error stops being visible: the process
 * survives, so the global handlers never see it, and unless something is
 * plugged into the framework's own error path the failure leaves nothing behind
 * but a status code.
 *
 * These adapters are that plug. Each one reports and then hands the error
 * straight back to the framework, because deciding what the user sees is the
 * application's job and always was.
 */
export interface ErrorReporter {
    captureException(thrown: unknown, context?: Record<string, unknown>): void;
}
export interface RequestLike {
    method?: string;
    originalUrl?: string;
    url?: string;
    path?: string;
    route?: {
        path?: string;
    };
    ip?: string;
    headers?: Record<string, unknown>;
}
/**
 * Express error middleware.
 *
 * Must be registered last, after the routes, and must keep all four
 * parameters: Express identifies error middleware by arity alone, and a
 * three-argument function is silently treated as ordinary middleware that
 * never runs on the error path.
 */
export declare function expressErrorHandler(client: ErrorReporter): (error: unknown, req: RequestLike, _res: unknown, next: (error?: unknown) => void) => void;
/**
 * Koa middleware.
 *
 * Wraps the downstream chain rather than listening on `app.on("error")`,
 * because an error the application handles itself never reaches that event -
 * and a handled 500 is still an issue worth seeing.
 */
export declare function koaErrorHandler(client: ErrorReporter): (ctx: {
    request?: RequestLike;
} & RequestLike, next: () => Promise<void>) => Promise<void>;
/**
 * Fastify error hook, for `fastify.setErrorHandler` or `onError`.
 *
 * Returns a function matching the onError hook signature, which reports and
 * then calls done() so Fastify's own error handling proceeds untouched.
 */
export declare function fastifyErrorHandler(client: ErrorReporter): (request: RequestLike, _reply: unknown, error: unknown, done?: () => void) => void;
