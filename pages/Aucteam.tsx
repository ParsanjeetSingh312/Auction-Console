/**
 * Aucteam.tsx
 * The `/aucteam` route: build a playing XI, then read SCOUT's report on it.
 *
 * Dark, like the landing and About, because AUCTEAM is a front-of-house page
 * rather than an operator's console: it sits in the main navigation next to
 * Live Bidding and is reached by the same audience.
 *
 * Clash Display is loaded here and nowhere else. It is the AUCTEAM display
 * face -- jersey numbers, the wordmark, the grade -- and every other surface
 * already has its own type, so a global import would cost every page a font
 * request for one page's benefit. Injected as a <link> rather than a CSS
 * @import, because an @import that is not the first rule in a stylesheet is
 * silently dropped, and Vite gives no guarantee about where this route's CSS
 * lands in the bundle. Outfit stands in until it arrives (`font-display:
 * swap`), and stays if the font host is unreachable.
 *
 * `overflow-x-clip` on the root, not `overflow-x-hidden`, for the reason
 * Auctiq.tsx gives: the backdrop photograph is scaled past the viewport, and
 * `hidden` would make this a scroll container and break the sticky board.
 */
import { useEffect } from "react";

import AuctiqNav from "../components/Global/AuctiqNav";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";
import PoolGrid from "../components/Aucteam/PoolGrid";
import RosterBoard from "../components/Aucteam/RosterBoard";
import TeamReport from "../components/Aucteam/TeamReport";
import TierLabel from "../components/Aucteam/TierLabel";
import { loadPool, retryPool, useAucteam } from "../console/aucteamStore";

import "../components/Aucteam/aucteam.css";

const CLASH_DISPLAY = "https://api.fontshare.com/v2/css?f[]=clash-display@500,600,700&display=swap";

function useClashDisplay(): void {
  useEffect(() => {
    if (document.querySelector(`link[href="${CLASH_DISPLAY}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CLASH_DISPLAY;
    document.head.appendChild(link);
  }, []);
}

export default function Aucteam() {
  useClashDisplay();
  const status = useAucteam((s) => s.poolStatus);
  const error = useAucteam((s) => s.poolError);
  const size = useAucteam((s) => s.roster.length);
  const squad = useAucteam((s) => s.rules?.squad_size ?? 11);

  useEffect(() => {
    document.title = "AUCTONIQ · AUCTEAM";
    void loadPool();
  }, []);

  return (
    <div className="auctiq relative min-h-screen overflow-x-clip">
      <StadiumBackdrop variant="console" />
      <div className="auctiq-stadium" aria-hidden />
      <div className="aq-scrim" aria-hidden />
      <div className="aq-navband" aria-hidden />
      <AuctiqNav />

      <main className="aucteam">
        <header className="aq-masthead">
          <div>
            <h1 className="aq-title">AUCTEAM</h1>
            <p className="aq-lede">
              Build a playing XI from the auction pool. Drag eleven players onto the team sheet, with at
              least one wicketkeeper and no more than four from overseas, and SCOUT will grade the side.
            </p>
          </div>
          <div className="aq-tier-key" aria-label="Player tiers">
            <span><TierLabel tier="MQ" /> Veterans</span>
            <span><TierLabel tier="PR" /> In their best years</span>
            <span><TierLabel tier="EM" /> Young prospects</span>
          </div>
        </header>

        {status === "error" ? (
          <div className="aq-empty" role="alert">
            <p style={{ margin: 0 }}>{error ?? "The player pool did not load."}</p>
            <button type="button" className="aq-btn" style={{ marginTop: 14 }} onClick={retryPool}>
              Load the pool again
            </button>
          </div>
        ) : status !== "ready" ? (
          <div className="aq-empty" aria-busy>
            Loading the player pool…
            <br />
            <small style={{ color: "var(--aq-faint)" }}>
              The first load after the server starts can take up to half a minute.
            </small>
          </div>
        ) : (
          <>
            <div className="aq-layout">
              <PoolGrid />
              <RosterBoard />
            </div>
            <TeamReport />
          </>
        )}
      </main>

      {status === "ready" && (
        <div className="aq-mobile-bar aucteam" style={{ padding: "0 8px 0 16px", margin: 0, maxWidth: "none" }}>
          <span>
            Your XI {size}/{squad}
          </span>
          <button
            type="button"
            className="aq-btn"
            style={{ height: 34 }}
            onClick={() => document.getElementById("aq-board")?.scrollIntoView({ behavior: "smooth" })}
          >
            View team
          </button>
        </div>
      )}
    </div>
  );
}
