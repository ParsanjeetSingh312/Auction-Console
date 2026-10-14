/**
 * MarqueeLab.tsx
 * /lab/marquee: the marquee reveal on its own, for review before it is wired
 * into the live room. Nothing links here.
 *
 * The bidding panel below is a stand-in, not the room's block: it exists so
 * the reveal has a bidding screen to hand back to. Wiring the reveal into the
 * real block (and holding the lot clock while it plays) is the next step,
 * after approval.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import MarqueeReveal from "../components/Marquee/MarqueeReveal";
import { MARQUEE_PLAYERS, type MarqueePlayer } from "../components/Marquee/marqueePlayers";

export default function MarqueeLab() {
  const [playing, setPlaying] = useState<MarqueePlayer | null>(null);
  const [onBlock, setOnBlock] = useState<MarqueePlayer | null>(null);
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    document.title = "Marquee reveal · AUCTONIQ lab";
  }, []);

  const putUp = (player: MarqueePlayer) => {
    setOnBlock(null);
    setRunKey((k) => k + 1);
    setPlaying(player);
  };

  return (
    <div className="auctiq min-h-screen px-5 py-8 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-auctiq text-3xl text-auctiq-text sm:text-4xl">Marquee reveal</h1>
            <p className="mt-2 max-w-xl font-tech text-base text-slate-300">
              Put a trending player on the block to play their reveal. The panel below stands in
              for the live room's bidding screen.
            </p>
          </div>
          <Link to="/" className="font-tech text-sm text-slate-300 underline-offset-4 hover:underline">
            Back to AUCTONIQ
          </Link>
        </header>

        <section className="mt-8">
          <h2 className="font-tech text-lg font-semibold text-white">Trending players</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MARQUEE_PLAYERS.map((player) => (
              <button
                key={player.poolName}
                type="button"
                onClick={() => putUp(player)}
                className="group flex items-center justify-between rounded-xl bg-white/[0.05] px-4 py-3 text-left transition-colors hover:bg-white/[0.1]"
              >
                <span>
                  <span className="block font-tech text-base font-semibold text-white">{player.poolName}</span>
                  <span className="block font-tech text-sm text-slate-400">
                    #{player.jersey} · {player.team.city}
                  </span>
                </span>
                <span
                  className="rounded-full px-3 py-1 font-tech text-sm font-semibold text-black transition-transform group-hover:scale-105"
                  style={{ background: player.team.primary }}
                >
                  Put up
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-10 rounded-2xl bg-white/[0.04] p-6" aria-live="polite">
          <h2 className="font-tech text-lg font-semibold text-white">On the block</h2>
          {onBlock ? (
            <div className="mq-block-in mt-4 flex flex-wrap items-center justify-between gap-6">
              <div>
                <p className="font-tech text-sm" style={{ color: onBlock.team.primary }}>
                  {onBlock.tagline}
                </p>
                <p className="font-auctiq text-4xl text-white">{onBlock.poolName}</p>
                <p className="mt-1 font-tech text-base text-slate-300">
                  {onBlock.role} · base ₹2.00 Cr
                </p>
              </div>
              <div className="text-right">
                <p className="font-tech text-sm text-slate-400">Bidding open</p>
                <p className="font-stadium text-5xl font-extrabold italic text-white">₹2.00 Cr</p>
              </div>
            </div>
          ) : (
            <p className="mt-3 font-tech text-base text-slate-400">Nobody yet. Put a player up.</p>
          )}
        </section>
      </div>

      <MarqueeReveal
        player={playing}
        runKey={runKey}
        onDone={() => {
          setOnBlock(playing);
          setPlaying(null);
        }}
      />
    </div>
  );
}
