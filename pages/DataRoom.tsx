/**
 * DataRoom.tsx
 * The `/data` route.
 *
 * A thin page wrapper, matching how Home wraps WelcomeHero. The dashboard owns
 * its own engine and Scout because it is a standalone route — nothing above it
 * in the tree has an auction to share.
 *
 * The elements around it are presentation only. `.console-dark` redefines
 * console.css's palette tokens for this subtree and nothing else — /console
 * keeps the white enterprise theme — and `StadiumBackdrop` is the same fixed
 * photograph the landing uses, so the two surfaces read as one product rather
 * than as a dark front door onto a white application.
 *
 * The site menu sits above the dashboard as a static bar. `.site-chrome` makes
 * the page a column the height of the viewport, so the dashboard's own shell
 * takes what the bar leaves rather than its usual 100vh — otherwise the pool
 * would scroll inside a box taller than the screen.
 */
import AuctiqNav from "../components/Global/AuctiqNav";
import DataDashboard from "../components/Console/DataDashboard";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";

export default function DataRoom() {
  return (
    <div className="console-dark site-chrome">
      <StadiumBackdrop variant="console" />
      <AuctiqNav placement="static" />
      <DataDashboard />
    </div>
  );
}
