/**
 * A browser session that survives page loads within one tab.
 *
 * A multi-page application reloads the SDK on every navigation. With a fresh
 * session per page, one user's journey through a checkout would arrive as five
 * unrelated sessions, and the replay for an error on page five would carry no
 * hint that pages one to four happened.
 *
 * `sessionStorage`, not `localStorage`: it is scoped to the tab and dies with
 * it, which is what a session is. Two tabs are two sessions - and must be,
 * because they would otherwise race on the sequence number below and overwrite
 * each other's segments.
 */
import { SequenceStore } from "../replay/sequence";
export interface BrowserSession {
    id: string;
    sequence: SequenceStore;
}
/**
 * Load this tab's session, or start one.
 *
 * `explicit` lets an application name the session itself - a login session id
 * the API also sees - so browser and server events join. It is hashed exactly
 * as the Node SDK hashes it.
 */
export declare function loadBrowserSession(explicit?: string): BrowserSession;
