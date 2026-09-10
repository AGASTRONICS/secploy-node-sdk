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

import { HASHED_SESSION } from "../portable/scrub";
import { hashSessionId, newSessionId } from "../portable/ids";
import { SequenceStore } from "../replay/sequence";

const STORAGE_KEY = "secploy:session";

export interface BrowserSession {
  id: string;
  sequence: SequenceStore;
}

function storage(): Storage | null {
  try {
    // Reading the property itself throws in some sandboxed iframes and with
    // storage disabled, so the access is inside the try.
    return (globalThis as any).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Load this tab's session, or start one.
 *
 * `explicit` lets an application name the session itself - a login session id
 * the API also sees - so browser and server events join. It is hashed exactly
 * as the Node SDK hashes it.
 */
export function loadBrowserSession(explicit?: string): BrowserSession {
  const store = storage();
  let id = explicit ? hashSessionId(explicit) : "";
  let next = 0;

  if (store) {
    try {
      const saved = JSON.parse(store.getItem(STORAGE_KEY) || "null");
      if (
        saved &&
        typeof saved.id === "string" &&
        HASHED_SESSION.test(saved.id) &&
        (!id || saved.id === id)
      ) {
        id = saved.id;
        next = Number.isInteger(saved.seq) && saved.seq >= 0 ? saved.seq : 0;
      }
    } catch {
      // Unreadable or tampered with. Start again rather than trust it.
    }
  }

  if (!id) id = newSessionId();

  const persist = () => {
    try {
      store?.setItem(STORAGE_KEY, JSON.stringify({ id, seq: next }));
    } catch {
      // Quota or privacy mode. The session still works for this page.
    }
  };
  persist();

  return {
    id,
    sequence: {
      peek: () => next,
      commit: () => {
        next++;
        persist();
      },
    },
  };
}
