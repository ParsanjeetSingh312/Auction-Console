/**
 * DataRoom.tsx
 * The `/data` route.
 *
 * A thin page wrapper, matching how Home wraps WelcomeHero. The dashboard owns
 * its own engine and Scout because it is a standalone route — nothing above it
 * in the tree has an auction to share.
 *
 * The two elements around it are presentation only. `.console-dark` redefines
 * console.css's palette tokens for this subtree and nothing else — /console
 * keeps the white enterprise theme — and `StadiumBackdrop` is the same fixed
 * photograph the landing uses, so the two surfaces read as one product rather
 * than as a dark front door onto a white application.
 *
 * `DataDashboard` itself is untouched: no props changed, no logic changed, no
 * markup changed. Everything here is a class on a wrapper and a layer behind it.
 */
import DataDashboard from "../components/Console/DataDashboard";
import StadiumBackdrop from "../components/Sections/StadiumBackdrop";

export default function DataRoom() {
  return (
    <div className="console-dark">
      <StadiumBackdrop variant="console" />
      <DataDashboard />
    </div>
  );
}
