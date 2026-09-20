/**
 * readOnlyEngine.ts
 * The auction engine with its write half sealed off.
 *
 * The Data Interface has to be *strictly* read-only, and there are two ways to
 * get there. One is to thread a `readOnly` flag through PoolTable, TeamsView,
 * ResultsView, ScoutView and PlayerCard, and branch inside each of them. The
 * other is to hand those components an engine that cannot mutate. This is the
 * second, and it is better for a reason worth stating: a flag is a promise that
 * every call site remembered to check, and there are eleven of them across five
 * files. Sealing the engine makes the guarantee structural — a view cannot put
 * a player on the block from this route even if someone later adds a button
 * that tries, because the method it would call does not do anything.
 *
 * It also keeps the Phase 2 components completely untouched, which matters:
 * they are shared with the console, and forking them into read-only twins would
 * mean every future fix had to be made twice.
 *
 * Everything on the read side passes through unchanged. The pool, the
 * summaries, the ledger, `blockedReason`, the counts — all still answer
 * truthfully, because analysis is the entire point of this route.
 */
import type { AuctionEngine, IntentResult } from "./useAuctionEngine";

/**
 * Why a write was refused.
 *
 * Phrased as a redirection rather than an error. Someone clicking "put up" in
 * the analytics view has not made a mistake; they are in the wrong room, and
 * the message should say which room they want.
 */
function refuse(action: string): IntentResult {
  return {
    ok: false,
    message: `${action} is disabled here — the Data Interface is read-only. Open the Live Bidding Interface to run the auction.`,
  };
}

export function readOnlyEngine(engine: AuctionEngine): AuctionEngine {
  return {
    ...engine,

    /* ---- the auction's write surface, sealed ---- */
    putOnBlock: () => refuse("Putting a player up"),
    bidFor: () => refuse("Bidding"),
    raiseAsk: () => refuse("Raising the ask"),
    sell: () => refuse("Selling"),
    pass: () => refuse("Passing"),
    returnToPool: () => refuse("Returning a player to the pool"),
    undo: () => refuse("Undo"),

    /*
      `canUndo` is reported false rather than passed through, so the undo
      control renders disabled instead of live-but-inert. A button that looks
      available and refuses when pressed is worse than one that is visibly off.
    */
    canUndo: false,

    /*
      Settings and reset are silent no-ops rather than refusals: nothing in this
      route surfaces them, so a message would only ever appear if something
      called them by accident, and a toast is not the right way to report a bug.
    */
    setRules: () => {},
    resetAuction: () => {},

    /*
      Deliberately NOT sealed: `reloadRoster`. Re-fetching the player pool is a
      read, and refreshing the data is exactly what someone analysing it will
      want to do.
    */
  };
}
