/**
 * SocketBlock.tsx
 * The franchise's bidding station, on the live room.
 *
 * Third driver for `BlockView`, after the Phase 3 mock feed and the Phase 2
 * engine. It adapts the room's broadcast into the view's vocabulary and sends
 * intents back down the socket; it decides nothing. The next ask, whether this
 * franchise can afford it, and whether a bid was accepted are all the server's
 * answers — this file only asks the questions.
 *
 * **Team isolation.** This is the requirement that shapes the screen, and it is
 * mostly satisfied by the view already: `BlockView` shows your franchise and
 * the one currently holding the bid, and nothing else. There is no ten-team
 * button strip here as there is on the auctioneer's panel, because a bidder
 * does not act on behalf of anyone but themselves, and nine other franchises'
 * purses on screen are nine things to read past to find your own. The ticker is
 * filtered the same way: your own actions are marked `mine` and highlighted,
 * everyone else's are context.
 *
 * **Jumpbid.** Passed down as `onJumpBid`, which is what makes the control
 * appear. The figure is sent as typed and the room validates it against the
 * standing ask and this franchise's purse — a jumpbid is a request like any
 * other bid, not an instruction.
 */
import { useMemo } from "react";

import { countryLabel, headlineFor } from "../../console/format";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { AuctionSocket } from "../../hooks/useAuctionSocket";
import BlockView from "./BlockView";
import type { Lot, TickerEntry } from "./blockTypes";

export interface SocketBlockProps {
  socket: AuctionSocket;
  /** The socket-backed engine, for the player pool behind the lot. */
  engine: AuctionEngine;
  onLeave: () => void;
}

export default function SocketBlock({ socket, engine, onLeave }: SocketBlockProps) {
  const room = socket.state;
  const seat = socket.seat;
  const myTeam = socket.myTeam;

  /**
   * The room's lot, restated for the view.
   *
   * The room sends the player's name, role and rating with the lot, so this
   * renders even before the 284-player pool has finished hydrating. When the
   * pool *is* in, the local row is preferred because it carries the formatted
   * career headline the room has no reason to compute.
   */
  const lot: Lot | null = useMemo(() => {
    if (!room?.lot) return null;
    const local = engine.playerById(room.lot.player_id);

    return {
      id: room.lot.player_id,
      name: local?.name ?? room.lot.player_name,
      role: local?.role ?? room.lot.role,
      country:
        countryLabel(local?.country ?? room.lot.country) ??
        (room.lot.overseas ? "Overseas" : null),
      base: room.lot.base,
      rating: room.lot.rating,
      headline: local ? headlineFor(local) : "",
    };
  }, [room?.lot, engine]);

  /**
   * The ledger as ticker rows.
   *
   * `mine` is decided by the team code appearing in the room's own line, which
   * is how the Phase 2 driver does it too. It drives the highlight that lets a
   * bidder find their own last action in a fast-moving list.
   */
  const ticker: TickerEntry[] = useMemo(() => {
    const code = seat?.team_code ?? "";
    return (room?.log ?? []).slice(0, 12).map((entry) => ({
      id: entry.seq,
      kind: entry.kind === "note" ? "note" : entry.kind,
      text: entry.what,
      amount: entry.amount,
      mine: code !== "" && entry.what.includes(code),
    }));
  }, [room?.log, seat?.team_code]);

  /**
   * Why this franchise cannot bid, beyond simple affordability.
   *
   * Affordability is already expressed by the view's own arithmetic against
   * `purseLeft`, so only the non-monetary obstacles are spelled out — otherwise
   * a full squad would be reported as "exceeds your purse", which sends someone
   * looking for money they do not need.
   */
  const blockedReason = useMemo(() => {
    if (!room?.lot || !myTeam) return null;
    const player = engine.playerById(room.lot.player_id);
    if (!player) return null;
    const reason = engine.blockedReason(myTeam.id, player, room.lot.next_ask);
    if (!reason) return null;
    return reason.startsWith("over budget") ? null : reason;
  }, [room?.lot, myTeam, engine]);

  return (
    <BlockView
      lot={lot}
      currentBid={room?.lot?.bid ?? 0}
      leadingTeam={room?.lot?.bidder_code ?? ""}
      myTeam={seat?.team_code ?? "—"}
      purse={engine.rules.purse}
      purseLeft={myTeam?.left ?? 0}
      ticker={ticker}
      blockedReason={blockedReason}
      // The amount is ignored: the room derives the standard next ask from its
      // own ladder, and letting the client name it would make the price a
      // matter of opinion.
      onBid={() => socket.bid()}
      onJumpBid={(amount) => socket.bid(amount)}
      corner={
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onLeave}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          >
            ← leave seat
          </button>

          {/*
            Connection state, because on a bidder's station it is load-bearing:
            a frozen screen and a quiet lot look identical, and one of them
            means you are about to lose a player you think you are winning.
          */}
          <span className="flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1.5">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${
                socket.status === "open" ? "bg-emerald-500" : "animate-pulse bg-amber-500"
              }`}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-500">
              {socket.status === "open" ? seat?.team_code : socket.status}
            </span>
          </span>
        </div>
      }
    />
  );
}
