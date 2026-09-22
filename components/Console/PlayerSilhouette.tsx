/**
 * PlayerSilhouette.tsx
 * A cricketer, as one path.
 *
 * Ported from the prototype, whose reasoning holds here unchanged: the backend
 * supplies no player photography, and shipping real player images would be a
 * licensing problem. So the card leans on the jersey number and uses a figure
 * rather than a face.
 *
 * **Four poses, not one.** A three-hundred-card grid drawn from a single
 * silhouette reads as one stamp repeated, which is worse than no figure at all.
 * Role-specific poses give the grid texture for four paths' worth of work.
 *
 * Each is a single path inheriting `currentColor`, so the parent owns tint and
 * any hover lift — and the shape stays legible at card size, where a detailed
 * figure turns to mud.
 */
import type { RoleShort } from "../../console/types";

const PATHS: Record<string, string> = {
  // Front-foot drive.
  BAT: "M52 6a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-3 17h8l6 15 13 9-3 6-15-9-2 12 9 24-6 3-11-24-11 22-6-3 10-26-3-20-9 11-5-4 12-16 3-2Z",
  // Delivery stride.
  BOWL: "M55 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-4 17h8l5 12 12-16 5 4-13 20 3 18 12 21-6 4-13-22-13 21-6-4 12-21-4-20-9 9-5-4 12-14 3-8Z",
  // All-rounder, upright with the bat at rest.
  AR: "M52 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-4 17h8l5 14 14 4-2 6-14-4-1 14 8 28-6 2-9-26-9 26-6-2 8-28-2-19-8 9-5-4 11-14 8-6Z",
  // Keeper's crouch.
  WK: "M52 8a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-5 18h10l7 11 12 6-3 6-13-6-2 9 7 12-1 14h-7l1-13-6-9-7 10 1 12h-7l-1-15 8-13-3-13-10 8-4-5 13-11 5-3Z",
};

export default function PlayerSilhouette({ role }: { role: RoleShort | string }) {
  // An unmapped role draws the all-rounder rather than nothing: a missing
  // figure leaves a hole in the card where a generic one leaves a card.
  const path = PATHS[role] ?? PATHS.AR;

  return (
    <svg
      viewBox="0 0 104 104"
      width="100%"
      height="100%"
      role="presentation"
      focusable="false"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
