/**
 * DataRoom.tsx
 * Route scaffolding — replaced in the next step by DataDashboard.
 *
 * This exists so `/data` resolves and the landing page can be tested end to
 * end. The real page is the existing console with the block removed: pool,
 * teams, results and SCOUT, read-only.
 */
import Placeholder from "../components/Placeholder";

export default function DataRoom() {
  return (
    <Placeholder
      title="Data Interface"
      step="Next: components/Console/DataDashboard.tsx"
      blurb="The read-only analytics dashboard — player pool, franchise records, results and the SCOUT retrieval engine, with the live block excluded."
    />
  );
}
