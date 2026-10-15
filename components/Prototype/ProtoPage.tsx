/**
 * ProtoPage.tsx
 * /lab/prototype: the landing as `/` shows it, the delivery opening first,
 * with the detailing reworked. Same scene, same beats, same sections; what
 * changes is the finish:
 *
 * - the film runs on `./intro`, copies of the Intro modules refined in place
 *   (crowd, turf, pitch, boards, sightscreen, floodlights, ball trail,
 *   caption, depth of field and a film grade), so `/` is untouched;
 * - the landing's own sections are the live components, wrapped in `.proto`
 *   so `protoLanding.css` can refine their look without reaching any other
 *   page.
 *
 * Plays on every visit and never marks the opening seen. Nothing links here.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";

import CricketCursor from "../UI/CricketCursor";
import AuctiqFooter from "../Global/AuctiqFooter";
import AuctiqNav from "../Global/AuctiqNav";
import BroadcastHero from "../Sections/BroadcastHero";
import StadiumBackdrop from "../Sections/StadiumBackdrop";
import PlayerSelect from "../UI/PlayerSelect";
import { SHOWCASE_PLAYERS } from "../../utils/players";
import { PLAYER_STATS } from "../../utils/playerStats";
import StadiumIntro from "./intro/StadiumIntro";
import "./protoLanding.css";

const LandingSections = memo(function LandingSections() {
  return (
    <>
      <AuctiqNav />
      <BroadcastHero />
      <PlayerSelect players={SHOWCASE_PLAYERS} stats={PLAYER_STATS} />
      <AuctiqFooter />
    </>
  );
});

export default function ProtoPage() {
  const [landed, setLanded] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    if (landed) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [landed]);
  const handOff = useCallback(() => setLanded(true), []);

  useEffect(() => {
    document.title = "AUCTONIQ · Prototype";
  }, []);

  return (
    <div className="auctiq proto relative min-h-screen overflow-x-clip">
      <StadiumBackdrop />
      <StadiumIntro
        instant={false}
        backdrop={landed}
        mark={false}
        opening="delivery"
        onComplete={handOff}
        className={landed ? "!fixed inset-0 z-0 pointer-events-none" : "!fixed inset-0 z-[200]"}
      />
      <div className="auctiq-stadium" aria-hidden />
      <div className="auctiq-grid" aria-hidden />
      {/* Film grain over the whole page, so the landing is shot on the same
          stock as the film it comes out of. */}
      <div className="proto-grain" aria-hidden />

      <div
        ref={content}
        aria-hidden={!landed || undefined}
        style={{
          opacity: landed ? 1 : 0.001,
          willChange: "opacity",
          transition: "opacity 1.1s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {landed && <CricketCursor />}
        <LandingSections />
      </div>
    </div>
  );
}
