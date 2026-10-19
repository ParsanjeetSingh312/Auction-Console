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
import TierGate from "../components/Ecosystem/TierGate";
import { can, useAccount } from "../console/accountStore";

/**
 * The Data Interface is for Auctioneer and Free accounts, administrators and
 * signed-out visitors; Delegates scout through AUCTEAM and SCOUT instead
 * (console/accountStore.ts, ACCESS). For them, a gate in its place.
 */
export default function DataRoom() {
  const { status, account } = useAccount();
  if (status === "loading") return <div className="console-dark min-h-screen" />;
  if (!can(account, "data")) {
    return (
      <TierGate
        eyebrow="Data Interface"
        title="Your scouting lives in AUCTEAM"
        body="The Data Interface is for Auctioneer and Free accounts. As a Delegate you build and grade your playing XI in AUCTEAM, and SCOUT answers anything else, without limit."
        pass="D"
        actions={[
          { label: "Open AUCTEAM", to: "/aucteam", primary: true },
          { label: "Live Bidding", to: "/auction/live" },
        ]}
      />
    );
  }
  return (
    <div className="console-dark site-chrome">
      <StadiumBackdrop variant="console" />
      <AuctiqNav placement="static" />
      <DataDashboard />
    </div>
  );
}
