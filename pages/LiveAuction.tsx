/**
 * LiveAuction.tsx
 * Route scaffolding — replaced once the room exists.
 *
 * This exists so `/auction` resolves and the landing page can be tested end to
 * end. The real page is the role gate: auctioneer to the split-screen admin
 * panel, franchise to the waiting room and then the block.
 */
import Placeholder from "../components/Placeholder";

export default function LiveAuction() {
  return (
    <Placeholder
      title="Live Bidding Interface"
      step="Next: useAuctionSocket → AdminSplitScreen → LiveBlock → PostAuctionReport"
      blurb="The auction room: sign in as auctioneer or franchise, wait for the room to fill, then bid. Needs the FastAPI WebSocket room before it can do anything real."
    />
  );
}
