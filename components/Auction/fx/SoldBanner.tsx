/**
 * SoldBanner.tsx
 * An offline sale, announced: the hammer drops and the screen reads
 * "{PLAYER} SOLD TO {FRANCHISE} FOR {AMOUNT}" -- on the auctioneer's panel,
 * every delegate's screen and any spectator, at once.
 *
 * Keyed to the room's `last_sale.seq` (auction/room.py), so it plays once per
 * sale on every client: the sequence seen when this mounts is the baseline,
 * so joining or reloading mid-auction never replays an old sale, and an undo
 * (which clears `last_sale`) announces nothing.
 *
 * Offline only. Online, the bidder's block already plays HammerDrop on the
 * clock's sale, and two cinematics for one hammer would trip over each other.
 */
import { useEffect, useRef, useState } from "react";

import type { AuctionSocket, LastSale } from "../../../hooks/useAuctionSocket";
import { crore } from "../blockTypes";
import HammerDrop from "./HammerDrop";

export function saleHeadline(sale: Pick<LastSale, "player" | "team" | "price">): string {
  return `${sale.player} sold to ${sale.team} for ${crore(sale.price)}`.toUpperCase();
}

export default function SoldBanner({ socket }: { socket: AuctionSocket }) {
  const sale = socket.state?.last_sale ?? null;
  const offline = socket.offline;
  const seen = useRef<number | null | undefined>(undefined);
  const [showing, setShowing] = useState<LastSale | null>(null);

  useEffect(() => {
    if (!socket.state) return;
    const seq = sale?.seq ?? null;
    if (seen.current === undefined) {
      seen.current = seq; // the baseline: nothing replays on load
      return;
    }
    if (seq !== null && seq !== seen.current && offline && sale) setShowing(sale);
    seen.current = seq;
  }, [socket.state, sale, offline]);

  if (!showing) return null;
  return (
    <HammerDrop
      key={showing.seq}
      playerName={showing.player}
      teamCode={showing.team_code}
      amount={showing.price}
      basePrice={showing.base ?? null}
      headline={saleHeadline(showing)}
      onDone={() => setShowing(null)}
    />
  );
}
