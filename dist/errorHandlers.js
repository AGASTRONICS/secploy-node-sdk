"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.expressErrorHandler = expressErrorHandler;
exports.koaErrorHandler = koaErrorHandler;
exports.fastifyErrorHandler = fastifyErrorHandler;
/**
 * What is worth attaching from the request.
 *
 * Deliberately narrow. The SDK has no scrubbing layer yet, so this takes the
 * routing facts an error needs to be triaged and nothing that could carry a
 * credential or a person's data: no bodies, no query strings, no cookies, no
 * headers.
 */
function requestContext(req) {
    if (!req)
        return {};
    const url = req.originalUrl ?? req.url ?? req.path ?? "";
    return {
        http_method: req.method ? String(req.method).toUpperCase() : undefined,
        // The route pattern when the framework knows it: /users/:id groups, while
        // /users/4821 would make every request its own issue.
        http_url: req.route?.path ?? url,
        http_raw_url: url,
    };
}
/**
 * Express error middleware.
 *
 * Must be registered last, after the routes, and must keep all four
 * parameters: Express identifies error middleware by arity alone, and a
 * three-argument function is silently treated as ordinary middleware that
 * never runs on the error path.
 */
function expressErrorHandler(client) {
    return function secployErrorHandler(error, req, _res, next) {
        try {
            client.captureException(error, {
                ...requestContext(req),
                mechanism: "express",
            });
        }
        catch {
            // Reporting must never replace the application's own error handling.
        }
        next(error);
    };
}
/**
 * Koa middleware.
 *
 * Wraps the downstream chain rather than listening on `app.on("error")`,
 * because an error the application handles itself never reaches that event -
 * and a handled 500 is still an issue worth seeing.
 */
function koaErrorHandler(client) {
    return async function secployErrorHandler(ctx, next) {
        try {
            await next();
        }
        catch (error) {
            try {
                client.captureException(error, {
                    ...requestContext(ctx.request ?? ctx),
                    mechanism: "koa",
                });
            }
            catch {
                // Fall through to the rethrow.
            }
            throw error;
        }
    };
}
/**
 * Fastify error hook, for `fastify.setErrorHandler` or `onError`.
 *
 * Returns a function matching the onError hook signature, which reports and
 * then calls done() so Fastify's own error handling proceeds untouched.
 */
function fastifyErrorHandler(client) {
    return function secployErrorHandler(request, _reply, error, done) {
        try {
            client.captureException(error, {
                ...requestContext(request),
                mechanism: "fastify",
            });
        }
        catch {
            // Reporting must never replace the application's own error handling.
        }
        if (typeof done === "function")
            done();
    };
}
