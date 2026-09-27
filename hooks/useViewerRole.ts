/**
 * useViewerRole.ts
 * Who is looking at the screen, and what that entitles them to see.
 *
 * The auction already has a role, and it is the trustworthy one: `Seat.role`
 * comes from the server, assigned by `auction/room.py` on the socket you are
 * actually connected on. `auction/schemas.py` makes the point that "a client
 * cannot claim to be someone else because there is no field in which to make
 * the claim", and nothing here weakens that — this module reads the seat, it
 * never invents one.
 *
 * What it adds is a *viewing* vocabulary, which is not quite the same thing.
 * The room knows two roles, `auctioneer` and `franchise`, because those are the
 * two things you can do to an auction. The interface has three audiences,
 * because a page can also be open in front of someone holding no seat at all —
 * the read-only Data Interface, a screen at the back of the room, a link
 * someone was sent. That third case has no name in the room's vocabulary and
 * needs one here.
 *
 * ---------------------------------------------------------------------------
 * This is presentation, not security
 *
 * `readOnlyEngine.ts` argues — correctly — that a flag threaded through five
 * components is "a promise that every call site remembered to check", and seals
 * the engine instead so a write is structurally impossible. That reasoning is
 * about *writes*, and it still stands: the masking here does not replace it,
 * and `/data` remains read-only because its engine cannot mutate, not because
 * of anything in this file.
 *
 * Hiding a column is a different problem. There is no method to seal — the data
 * is already in the client, fetched by `GET /api/v1/players`, which is how the
 * roster gets there at all. So this decides what is *rendered*, and it should
 * be read as exactly that: a participant is not shown the auctioneer's columns,
 * not prevented from obtaining them. Making that guarantee real would mean the
 * server returning fewer fields per role, which is a backend change and a
 * different phase.
 * ---------------------------------------------------------------------------
 */
import { useMemo } from "react";

import type { Seat } from "./useAuctionSocket";

/**
 * The three audiences an AUCTIQ screen can have.
 *
 * `participant` rather than `franchise` deliberately: the room's `franchise`
 * means "holds a team and may bid", while this means "is watching without
 * running it". They coincide today and would not if a co-auctioneer or an
 * observer seat were ever added.
 */
export type ViewerRole = "auctioneer" | "participant" | "spectator";

/** Every role, for tests and for rendering a role switcher. */
export const VIEWER_ROLES: readonly ViewerRole[] = [
  "auctioneer",
  "participant",
  "spectator",
] as const;

/**
 * Map a server-assigned seat onto a viewing role.
 *
 * Pure, and exported separately from the hook so it can be unit-tested and
 * called from non-component code without pulling in React's rules of hooks.
 *
 * A null seat is a spectator rather than a participant. That is the safe
 * direction: spectators see the least, so an unrecognised or absent seat
 * reveals nothing rather than defaulting to a privileged view.
 */
export function viewerRoleFor(seat: Seat | null | undefined): ViewerRole {
  if (seat?.role === "auctioneer") return "auctioneer";
  if (seat?.role === "franchise") return "participant";
  return "spectator";
}

/**
 * Whether this viewer may see the auction's market data.
 *
 * Specifically: the `STATUS` and `PRICE` columns, and the controls that change
 * them (`Put up`, `On block`, `Release`). The two travel together on purpose —
 * a button that acts on a column you cannot see is a worse interface than
 * neither.
 *
 * Only the auctioneer qualifies. A participant bidding against nine others
 * should not be reading every rival's hammer price off a table while the lot is
 * live; that is the whole reason this phase exists.
 */
export function canSeeMarketData(role: ViewerRole): boolean {
  return role === "auctioneer";
}

/**
 * Whether this viewer may act on the pool at all.
 *
 * Separate from `canSeeMarketData` even though they currently agree, because
 * they answer different questions and will diverge the moment a read-only
 * auctioneer view exists (an assistant watching the operator's screen, say).
 * Callers should ask the question they actually mean.
 */
export function canControlPool(role: ViewerRole): boolean {
  return role === "auctioneer";
}

/**
 * The viewing role for a screen driven by a live socket.
 *
 * Memoised on the seat's role alone rather than on the seat object: the socket
 * replaces `seat` on every reconnect and re-claim, and a new object identity
 * with an identical role should not re-render a 400-row table.
 */
export function useViewerRole(seat: Seat | null | undefined): ViewerRole {
  const role = seat?.role ?? null;
  return useMemo(() => viewerRoleFor(role ? ({ role } as Seat) : null), [role]);
}
