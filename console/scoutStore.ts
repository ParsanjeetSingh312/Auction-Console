/**
 * scoutStore.ts
 * Whether SCOUT is open, and what has been typed into it — for the whole app.
 *
 * SCOUT used to be a tab inside the Data Interface, so its open/closed state
 * was `DataDashboard`'s `view === "scout"` and nothing outside that component
 * needed to know about it. It is now a drawer reachable from every route,
 * which means the state has to outlive any one page: pressing Cmd+K on the
 * landing, on `/auction` and on `/console` must all reach the same panel, and
 * a route change must not throw away a half-typed question.
 *
 * **Why a module store rather than context.** The keyboard shortcut is bound
 * to `window`, not to a component, and it has to work before the user has
 * interacted with anything. A context provider would mean the handler could
 * only live inside the tree and would re-register on every render of whatever
 * owned it. A plain module that React subscribes to has no such coupling: the
 * listener is installed once, and `App` does not have to wrap anything.
 *
 * **Why `useSyncExternalStore` rather than a state library.** It is React 18's
 * own primitive for exactly this shape — an external mutable source that
 * components read — and it adds nothing to the bundle. The prototype reaches
 * for Zustand here; that would be a new dependency to do what forty lines of
 * built-in API already does, and this store has three fields.
 *
 * **The selector hooks are not an optimisation detail, they are the point.**
 * `useScoutDraft` changes on every keystroke. If the launcher subscribed to the
 * whole snapshot it would re-render — and re-run its GSAP idle timeline —
 * sixty times while someone types a question. Each hook below returns a
 * primitive, so a component only wakes for the field it actually reads.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

/** Where the drawer was opened from, kept for the transcript's own record. */
export type ScoutOrigin =
  | "launcher"
  | "hotkey"
  | "nav"
  | "block"
  | "pool"
  /** The AUCTEAM builder's SCOUT dock, with the roster as a draft. */
  | "aucteam"
  | null;

export interface ScoutUiState {
  open: boolean;
  origin: ScoutOrigin;
  /**
   * The composer's text, held here rather than in the input.
   *
   * It lives in the store so that closing the drawer mid-sentence and
   * reopening it later returns the sentence. An uncontrolled input inside a
   * panel that gets `inert` and hidden would lose it on the first route
   * change.
   */
  draft: string;
  /**
   * A question to send as soon as the drawer can, set by `askScout`. The
   * nonce makes asking the same question twice a second request rather than
   * a no-op; the drawer remembers the last nonce it sent.
   */
  ask: { text: string; nonce: number } | null;
}

const INITIAL: ScoutUiState = { open: false, origin: null, draft: "", ask: null };

let state: ScoutUiState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Merge a change in, and notify only if something actually moved.
 *
 * The equality check is what keeps `getSnapshot` honest: `useSyncExternalStore`
 * compares snapshots by identity, so returning a fresh object for a no-op set
 * would re-render every subscriber. Setting the draft to the value it already
 * holds — which `onChange` does on every arrow key — must be free.
 */
function set(patch: Partial<ScoutUiState>): void {
  const next = { ...state, ...patch };
  if (
    next.open === state.open &&
    next.origin === state.origin &&
    next.draft === state.draft &&
    next.ask === state.ask
  ) {
    return;
  }
  state = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Actions. Plain functions — callable from an event handler, a GSAP callback,
// or the keyboard listener below, none of which are inside React.
// ---------------------------------------------------------------------------

export function openScout(origin: ScoutOrigin = "launcher"): void {
  set({ open: true, origin });
}

let askNonce = 0;

/**
 * Open the drawer and send `question` straight away, as though it had been
 * typed and submitted. Used by surfaces that know exactly what to ask -- a
 * player card's "Ask Scout" -- so the user lands on an answer being worked
 * out rather than on an empty composer.
 */
export function askScout(question: string, origin: ScoutOrigin = "pool"): void {
  askNonce += 1;
  set({ open: true, origin, draft: question, ask: { text: question, nonce: askNonce } });
}

export function closeScout(): void {
  // The draft deliberately survives a close. See ScoutUiState.draft.
  set({ open: false });
}

export function toggleScout(origin: ScoutOrigin = "launcher"): void {
  if (state.open) closeScout();
  else openScout(origin);
}

export function setScoutDraft(draft: string): void {
  set({ draft });
}

/** Called once the composer has actually sent, so the box empties. */
export function clearScoutDraft(): void {
  set({ draft: "" });
}

/** The current state, for non-React callers. Never mutate the result. */
export function getScoutState(): ScoutUiState {
  return state;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** The whole snapshot. Prefer one of the narrow hooks below. */
export function useScoutUi(): ScoutUiState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function useScoutOpen(): boolean {
  return useSyncExternalStore(subscribe, () => state.open, () => state.open);
}

/** The queued question from `askScout`, or null. */
export function useScoutAsk(): ScoutUiState["ask"] {
  return useSyncExternalStore(subscribe, () => state.ask, () => state.ask);
}

export function useScoutDraft(): string {
  return useSyncExternalStore(subscribe, () => state.draft, () => state.draft);
}

export function useScoutOrigin(): ScoutOrigin {
  return useSyncExternalStore(subscribe, () => state.origin, () => state.origin);
}

/**
 * Bind Cmd+K / Ctrl+K globally, and Escape while open. Mount exactly once.
 *
 * **`preventDefault` is not optional.** Ctrl+K focuses the address bar in
 * Chrome and opens the search bar in Firefox, so without it the shortcut both
 * opens SCOUT and yanks focus out of the browser window it just opened in.
 *
 * The handler runs on `keydown` at the document level and deliberately does
 * *not* skip when the target is an input. A command shortcut that stops working
 * once the user is typing is the one moment they are most likely to want it —
 * including inside SCOUT's own composer, where Cmd+K closes the panel again.
 */
export function useScoutHotkey(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = event.metaKey || event.ctrlKey;

      if (combo && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleScout("hotkey");
        return;
      }

      // Only swallow Escape when there is something to close, so it stays
      // available to any other overlay on the page.
      if (event.key === "Escape" && state.open) {
        event.preventDefault();
        closeScout();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * The platform's modifier, for rendering the hint on the launcher.
 *
 * Read from the user agent rather than guessed, and computed once per call
 * rather than per render. `navigator.platform` is deprecated but is still the
 * only thing every browser agrees on here; the optional chaining means a
 * non-browser environment gets the Windows label rather than a crash.
 */
export function useHotkeyLabel(): string {
  return useCallback(() => {
    const platform =
      typeof navigator === "undefined"
        ? ""
        : navigator.platform || navigator.userAgent || "";
    return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
  }, [])();
}
