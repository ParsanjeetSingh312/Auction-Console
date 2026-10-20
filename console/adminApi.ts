/**
 * adminApi.ts
 * The administrator's overview (GET /api/v1/admin/overview), typed.
 *
 * Every figure is computed on the server from the pass ledger, the gifts and
 * the auction log (accounts/admin_stats.py), so this file only describes the
 * shape and fetches it.
 */
import { api } from "./ecosystemStore";
import type { PassKind } from "./ecosystemStore";

export type PerKind = Record<PassKind, number>;

export interface PassFlow {
  generated: PerKind;
  sent: PerKind;
  claimed: PerKind;
  pending: PerKind;
  returned: PerKind;
  spent: PerKind;
}

export interface GiftFlow {
  sent: PerKind;
  claimed: PerKind;
  pending: PerKind;
  returned: PerKind;
}

export interface AuctionCounts {
  opened: number;
  started: number;
  finished: number;
}

export interface AuctionDay extends AuctionCounts {
  /** Start of the UTC day, epoch seconds. */
  day: number;
}

export interface LiveRoom {
  code: string;
  phase: "lobby" | "waiting" | "live" | "finished";
  room_type: "auctioneer" | "delegate";
  teams: number;
  seated: number;
  connections: number;
  owner: string | null;
}

export interface AdminOverview {
  days: number;
  since: number;
  generated_at: number;
  accounts: {
    total: number;
    joined: number;
    admin: number;
    auctioneer: number;
    delegate: number;
    member: number;
  };
  passes: { window: PassFlow; all_time: PassFlow };
  given_by_me: { window: GiftFlow; all_time: GiftFlow };
  auctions: {
    window: AuctionCounts;
    all_time: AuctionCounts;
    per_day: AuctionDay[];
    live: LiveRoom[];
  };
  top_auctioneers: { id: number; name: string; email: string; started: number }[];
  recent_rooms: {
    room_code: string;
    room_type: string;
    event: "opened" | "started" | "finished";
    teams: number | null;
    at: number;
    owner: string | null;
  }[];
  recent_gifts: {
    kind: PassKind;
    quantity: number;
    status: "pending" | "claimed" | "returned" | "expired";
    created_at: number;
    sender: string;
    recipient: string;
  }[];
}

export function fetchAdminOverview(days: number): Promise<AdminOverview> {
  return api<AdminOverview>(`/admin/overview?days=${days}`);
}
