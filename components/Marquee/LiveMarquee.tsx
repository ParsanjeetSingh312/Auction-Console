/**
 * LiveMarquee.tsx
 * The marquee reveal, driven by the live room.
 *
 * Mounted once on the live bidding page, for every seat -- franchises and the
 * auctioneer alike -- so the whole room sees a marquee player arrive together.
 *
 * The room decides, not this component. When a marquee player is put up the
 * room arms a "presenting" clock instead of the opening one, and refuses bids
 * until it lapses. This component plays the reveal whenever the lot on the
 * block is presenting and the player has a marquee entry, starting at the
 * point the room's clock says the reveal has reached. So a franchise whose
 * frame arrived late, or who joined mid-reveal, sees the same moment as
 * everyone else, and every reveal ends before the bidding clock starts.
 *
 * If the lot leaves the block early (the auctioneer marks it unsold, or
 * undoes it), the reveal is cut and the screen returns to the block.
 *
 * The stage is built when this mounts, not when the player goes up, so the
 * first frame of the strike never waits on a stadium being built.
 */
import { useEffect, useMemo, useState } from "react";

import type { AuctionSocket } from "../../hooks/useAuctionSocket";
import MarqueeReveal, { MARQUEE_REVEAL_SECONDS } from "./MarqueeReveal";
import { marqueeFor, type MarqueePlayer } from "./marqueePlayers";

interface Run {
  key: string;
  player: MarqueePlayer;
  startAt: number;
}

export default function LiveMarquee({ socket }: { socket: AuctionSocket }) {
  const lot = socket.state?.lot ?? null;
  const presenting = lot && lot.clock === "presenting" ? lot : null;
  const entry = presenting ? marqueeFor(presenting.player_name) : null;
  // One reveal per presenting lot: the deadline is in the key, so the same
  // player put up again later reveals again.
  const key = presenting ? `${presenting.player_id}:${presenting.deadline}` : null;

  const [run, setRun] = useState<Run | null>(null);
  const [finished, setFinished] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !entry || !presenting || key === finished || run?.key === key) return;
    const hold = presenting.reveal_seconds ?? MARQUEE_REVEAL_SECONDS;
    const elapsed = Math.max(0, hold - (presenting.ends_in ?? hold));
    // Already over on this client's clock: nothing to show.
    if (elapsed >= MARQUEE_REVEAL_SECONDS) return;
    setRun({ key, player: entry, startAt: elapsed });
  }, [key, entry, presenting, finished, run]);

  // The lot left the block, or stopped presenting, before the reveal finished.
  useEffect(() => {
    if (run && !presenting && !lot) setRun(null);
  }, [run, presenting, lot]);

  const player = useMemo(() => run?.player ?? null, [run]);

  return (
    <MarqueeReveal
      player={player}
      runKey={run ? Number(run.key.split(":")[1] ?? 0) : 0}
      startAt={run?.startAt ?? 0}
      skippable={false}
      onDone={() => {
        if (run) setFinished(run.key);
        setRun(null);
      }}
    />
  );
}
