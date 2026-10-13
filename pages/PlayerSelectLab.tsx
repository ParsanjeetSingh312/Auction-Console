/**
 * PlayerSelectLab.tsx
 * /lab/players: the player-select prototype, on the landing's own ground.
 *
 * Nothing links here. It exists so the new showcase can be scrolled and judged
 * in the real shell (nav, backdrop, fonts) before it replaces `PlayerShowcase`
 * on the landing. The copy above and below is only there to give the section
 * something to scroll in from and out to.
 */
import { useEffect } from "react";

import AuctiqNav from "../components/Global/AuctiqNav";
import PlayerSelect from "../components/UI/PlayerSelect";
import { SHOWCASE_PLAYERS } from "../utils/players";
import { PLAYER_STATS } from "../utils/playerStats";

export default function PlayerSelectLab() {
  useEffect(() => {
    document.title = "Player select · AUCTONIQ lab";
  }, []);

  return (
    <div className="auctiq relative min-h-screen overflow-x-clip">
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />
      <AuctiqNav />

      <header className="relative z-10 flex min-h-[80svh] flex-col items-center justify-center px-6 text-center">
        <span className="font-tech text-[11px] uppercase tracking-[0.32em] text-neon-cyan">Prototype</span>
        <h1 className="mt-4 font-auctiq text-[clamp(2rem,6vw,4.5rem)] leading-[0.95] text-auctiq-text">
          PLAYER SELECT
        </h1>
        <p className="mt-4 max-w-md font-tech text-sm leading-relaxed text-auctiq-dim">
          Scroll down to deal the deck. Choose a player by clicking a card or with the arrows, then click
          the focused card, or press Enter, to open their stats.
        </p>
      </header>

      <PlayerSelect players={SHOWCASE_PLAYERS} stats={PLAYER_STATS} />

      <footer className="relative z-10 flex min-h-[60svh] items-center justify-center px-6 text-center font-tech text-sm text-auctiq-dim">
        End of prototype. The section above would replace the scattered card deck on the landing.
      </footer>
    </div>
  );
}
