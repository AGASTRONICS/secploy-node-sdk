/**
 * Auth context normalization.
 *
 * The public TypeScript API is camelCase because that is what a Node developer
 * expects, while the API and the Python SDK speak snake_case. Both spellings are
 * accepted here and reduced to one canonical shape.
 *
 * This is not cosmetic. Control matching is keyed on these fields, so an
 * unrecognized spelling does not raise an error - it silently finds no controls
 * and lets the request through. A gate that quietly stops enforcing because a
 * caller wrote `identity_key` instead of `identityKey` is worse than one that
 * fails loudly, so both are understood.
 */
import { SecurityGateAuthContext } from "./types";
/** camelCase field -> the snake_case spelling also accepted for it. */
export declare const AUTH_FIELD_ALIASES: ReadonlyArray<[
    keyof SecurityGateAuthContext,
    string
]>;
/**
 * Accept either spelling for every field and return the canonical camelCase
 * form. camelCase wins when both are present.
 */
export declare function normalizeAuthContext(input?: SecurityGateAuthContext | Record<string, any> | null): SecurityGateAuthContext;
