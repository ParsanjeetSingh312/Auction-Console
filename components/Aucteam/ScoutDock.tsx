/**
 * ScoutDock.tsx
 * SCOUT's logo on the board, in view for the whole of the build.
 *
 * Pressing it opens the global SCOUT drawer with a question already written:
 * the current roster, its tier mix and overseas count, and the ask -- how to
 * balance experience against youth, and what to fill next. The question is a
 * *draft*, not a sent message, so the user can sharpen it before it goes.
 *
 * The draft comes from the server's /validate (`scout_prompt`), which already
 * fits it under the drawer's 500-character limit. Before the first check has
 * come back there is a plain fallback question.
 */
import { openScout, setScoutDraft } from "../../console/scoutStore";
import { useAucteam } from "../../console/aucteamStore";
import ScoutEmblem from "../Scout/ScoutEmblem";

const OPENING_QUESTION =
  "I'm building an AUCTEAM playing XI from Marquee, Prime and Emerging players. " +
  "How should I balance experience and youth?";

export default function ScoutDock() {
  const prompt = useAucteam((s) => (s.roster.length ? s.check?.scout_prompt : null));
  const size = useAucteam((s) => s.roster.length);

  const ask = () => {
    setScoutDraft(prompt ?? OPENING_QUESTION);
    openScout("aucteam");
  };

  return (
    <button type="button" className="aq-scout" onClick={ask} aria-label="Ask SCOUT about this XI">
      <span className="aq-scout__emblem" aria-hidden>
        <ScoutEmblem variant="mark" cycle={4.6} />
      </span>
      <span>
        <span className="aq-scout__title">Ask SCOUT</span>
        <span className="aq-scout__hint" style={{ display: "block" }}>
          {size === 0
            ? "Not sure where to start? Ask how to balance veterans and prospects."
            : "Your XI so far goes with the question. Edit it before you send."}
        </span>
      </span>
    </button>
  );
}
