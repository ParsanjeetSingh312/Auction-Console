/**
 * scheduleApi.ts
 * The auctioneer's schedule, its Google Calendar link, and the auctioneer's
 * own pass figures (api/routes_schedule.py), typed.
 *
 * Times cross the wire as epoch seconds; the panel turns them into the
 * viewer's local time for display and back when a form is saved.
 */
import { apiUrl } from "./apiBase";
import { api } from "./ecosystemStore";
import type { Balances, PassKind } from "./ecosystemStore";
import type { GiftFlow, PerKind } from "./adminApi";

export type RoomType = "auctioneer" | "delegate";

export interface ScheduleEntry {
  id: number;
  title: string;
  room_type: RoomType;
  /** Epoch seconds. */
  starts_at: number;
  duration_min: number;
  notes: string;
  google_event_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface GoogleStatus {
  /** The server has a Google OAuth client set up. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  linked_at: number | null;
}

export interface SyncResult {
  state: "synced" | "off" | "error";
  error?: string;
}

export interface EntryInput {
  title: string;
  starts_at: number;
  duration_min: number;
  notes: string;
  room_type: RoomType;
}

export function fetchSchedule(): Promise<{ entries: ScheduleEntry[]; google: GoogleStatus }> {
  return api("/schedule");
}

export function createEntry(input: EntryInput): Promise<{ entry: ScheduleEntry; sync: SyncResult }> {
  return api("/schedule", { method: "POST", body: JSON.stringify(input) });
}

export function updateEntry(
  id: number,
  input: Partial<EntryInput>,
): Promise<{ entry: ScheduleEntry; sync: SyncResult }> {
  return api(`/schedule/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteEntry(id: number): Promise<{ ok: true; sync: SyncResult }> {
  return api(`/schedule/${id}`, { method: "DELETE" });
}

export function syncGoogle(): Promise<{ synced: number; errors: string[] }> {
  return api("/schedule/google/sync", { method: "POST" });
}

export function disconnectGoogle(): Promise<GoogleStatus> {
  return api("/schedule/google/disconnect", { method: "POST" });
}

/**
 * Where "Connect Google Calendar" sends the browser. A full navigation, not a
 * fetch: Google's consent screen has to load as a page.
 */
export function googleConnectUrl(): string {
  return apiUrl("/api/v1/schedule/google/connect");
}

export interface Recipient {
  id: number;
  name: string;
  email: string;
  role: string;
  kind: PassKind;
  sent: number;
  claimed: number;
  pending: number;
  last_sent: number;
}

export interface AuctioneerOverview {
  days: number;
  since: number;
  balances: Balances;
  generate_cap: number | null;
  generated_today: number;
  generated: { window: PerKind; all_time: PerKind };
  given: { window: GiftFlow; all_time: GiftFlow };
  recipients: Recipient[];
  auctions: {
    window: { opened: number; started: number; finished: number };
    all_time: { opened: number; started: number; finished: number };
  };
}

export function fetchAuctioneerOverview(days = 30): Promise<AuctioneerOverview> {
  return api(`/auctioneer/overview?days=${days}`);
}

/* ------------------------------------------------------- add to calendar -- */

export interface SharedAuction {
  title: string;
  room_type: RoomType;
  starts_at: number;
  duration_min: number;
  notes: string;
  host: string;
  token: string;
}

/** The auction's public share link token, made on first request. */
export function fetchShareToken(id: number): Promise<{ token: string; path: string }> {
  return api(`/schedule/${id}/share`);
}

/** Send the auction to connections' bells. */
export function shareEntry(id: number, recipientIds: number[]): Promise<{ token: string; shared: number }> {
  return api(`/schedule/${id}/share`, { method: "POST", body: JSON.stringify({ recipient_ids: recipientIds }) });
}

/** A shared auction, for the public page. No login needed. */
export function fetchSharedAuction(token: string): Promise<SharedAuction> {
  return api(`/calendar/${encodeURIComponent(token)}`);
}
