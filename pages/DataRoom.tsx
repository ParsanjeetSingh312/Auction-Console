/**
 * DataRoom.tsx
 * The `/data` route.
 *
 * A thin page wrapper, matching how Home wraps WelcomeHero. The dashboard owns
 * its own engine and Scout because it is a standalone route — nothing above it
 * in the tree has an auction to share.
 */
import DataDashboard from "../components/Console/DataDashboard";

export default function DataRoom() {
  return <DataDashboard />;
}
