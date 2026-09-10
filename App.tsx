/**
 * App.tsx
 * Mount point.
 *
 * Two views, selected by query string so neither can break the other while
 * Phase 3 is in progress:
 *
 *   /                       the Phase 2 console — roster, bidding, teams,
 *                           results, Scout
 *   /?view=block            the Phase 3 war-room lot view, on its mock feed
 *   /?view=block&purse=250  the same, with a purse too small to counter —
 *                           the quickest way to reach the blocked state and
 *                           see the refusal shake
 *   /?view=block&team=CHE   bid as a different franchise
 *
 * A query string rather than a router: there is one decision to make, and
 * adding react-router to express it would be more machinery than the choice
 * deserves.
 */
import AuctionConsole from "./components/Console/AuctionConsole";
import AuctionBlock from "./components/Auction/AuctionBlock";

export default function App() {
  const params = new URLSearchParams(window.location.search);

  if (params.get("view") === "block") {
    // Parsed defensively: a junk value should open the demo at its defaults
    // rather than render a component full of NaN.
    const purse = Number(params.get("purse"));
    const team = params.get("team")?.toUpperCase();

    return (
      <AuctionBlock
        purse={Number.isFinite(purse) && purse > 0 ? purse : undefined}
        myTeam={team && /^[A-Z]{3}$/.test(team) ? team : undefined}
      />
    );
  }

  return <AuctionConsole />;
}
