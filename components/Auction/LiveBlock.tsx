/**
 * LiveBlock.tsx
 * The war-room view, running on the real auction.
 *
 * Same presentation as the standalone demo — this only adapts the Phase 2
 * engine into the shape BlockView expects. Nothing about the auction moves
 * here: the engine remains the single source of truth for the block, the purse
 * and the ledger, and every bid goes back through `engine.bidFor`, so the
 * legality rules that govern the main console govern this view identically.
 *
 * There is one genuine modelling difference between the two views. The Phase 2
 * console is the auctioneer's: it bids on behalf of any of the ten franchises.
 * This is a *bidder's* station — it represents one franchise, which is what
 * makes "you are winning" and "your purse" meaningful. The franchise is chosen
 * by the host and passed in.
 */
import { useMemo } from "react";

import { countryLabel, headlineFor } from "../../console/format";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import BlockView from "./BlockView";
import type { Lot, TickerEntry } from "./blockTypes";

export interface LiveBlockProps {
  engine: AuctionEngine;
  /** Id of the franchise this station bids for. */
  teamId: number;
  onNotice: (message: string, kind?: "err") => void;
  corner?: React.ReactNode;
}

export default function LiveBlock({ engine, teamId, onNotice, corner }: LiveBlockProps) {
  const team = engine.teamById(teamId);
  const summary = engine.summaryFor(teamId);
  const player = engine.activePlayer;

  /** The engine's player, restated in the view's vocabulary. */
  const lot: Lot | null = useMemo(() => {
    if (!player) return null;
    return {
      id: player.id,
      name: player.name,
      role: player.role,
      country: countryLabel(player.country) ?? (player.overseas ? "Overseas" : null),
      base: player.base,
      rating: player.rating,
      headline: headlineFor(player),
    };
  }, [player]);

  /**
   * The engine's ledger, restated as ticker rows.
   *
   * The ledger is already newest-first and capped, so this is a projection
   * rather than a second copy of the history — there is no state here that
   * could fall out of step with the auction.
   */
  const ticker: TickerEntry[] = useMemo(() => {
    const code = team?.code ?? "";
    return engine.log.slice(0, 12).map((entry) => ({
      id: entry.seq,
      kind: entry.kind === "note" ? "note" : entry.kind,
      text: entry.what,
      amount: entry.amount,
      mine: code !== "" && entry.what.includes(code),
    }));
  }, [engine.log, team?.code]);

  /**
   * Why this franchise cannot bid, beyond simple affordability.
   *
   * `blockedReason` covers squad size and the overseas quota as well as money,
   * so the button can state the actual obstacle rather than defaulting to
   * "exceeds your purse" when the real problem is a full squad.
   */
  const blockedReason = useMemo(() => {
    if (!player) return null;
    const reason = engine.blockedReason(teamId, player, engine.nextAsk);
    if (!reason) return null;
    // Affordability is already expressed by the view's own arithmetic; only
    // the non-monetary obstacles need spelling out here.
    return reason.startsWith("over budget") ? null : reason;
  }, [engine, teamId, player]);

  const leadingTeam = engine.teamById(engine.block?.bidderId ?? null)?.code ?? "";

  return (
    <BlockView
      lot={lot}
      currentBid={engine.block?.bid ?? 0}
      leadingTeam={leadingTeam}
      myTeam={team?.code ?? "—"}
      purse={engine.rules.purse}
      purseLeft={summary?.left ?? 0}
      ticker={ticker}
      blockedReason={blockedReason}
      corner={corner}
      onBid={() => {
        // The engine decides the amount from its own ladder and rejects the bid
        // if it is illegal — the view's `nextBid` is a display of that same
        // calculation, never a second opinion the engine has to honour.
        const result = engine.bidFor(teamId);
        if (!result.ok && result.message) onNotice(result.message, "err");
      }}
    />
  );
}
