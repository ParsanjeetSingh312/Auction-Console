/**
 * ecosystemStore.ts
 * The signed-in account's passes and notifications, for the whole site.
 *
 * One poller, shared by the bell in the header and the popups that slide in
 * when something new arrives, so they never disagree about what is unread.
 * It asks the server (api/routes_ecosystem.py) every POLL_MS while the tab is
 * visible, and at once when the tab comes back into view. A notification id
 * the store has not seen before, arriving after the first load, is "fresh"
 * and becomes a popup; the first load itself never pops, so a page refresh
 * does not replay the inbox.
 *
 * The server decides everything -- who may claim, send, or spend. This module
 * only mirrors its answers.
 */
import { useEffect, useSyncExternalStore } from "react";

import { apiUrl } from "./apiBase";
import { useAccount } from "./accountStore";

export type PassKind = "A" | "D";

export interface Gift {
  id: number;
  kind: PassKind;
  quantity: number;
  status: "pending" | "claimed" | "returned" | "expired";
  note: string | null;
  expires_at: number;
  sender: string;
}

export type NotificationKind =
  | "welcome"
  | "gift"
  | "gift_returned"
  /** A scheduled auction shared by an auctioneer (accounts/calendar_share.py). */
  | "schedule"
  | "connection"
  | "reminder"
  | "announcement";

export interface Notice {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  created_at: number;
  read: boolean;
  gift: Gift | null;
}

export interface Capabilities {
  tier: "admin" | "auctioneer" | "delegate" | "member";
  generate: PassKind[];
  send: PassKind[];
  send_to_roles: string[];
  unlimited: boolean;
  generate_cap: number | null;
}

export type Balances = Record<PassKind, number>;

interface State {
  ready: boolean;
  items: Notice[];
  unread: number;
  balances: Balances;
  capabilities: Capabilities | null;
  /** New since the last look, newest first: the popups' queue. */
  fresh: Notice[];
}

const POLL_MS = 20_000;
const EMPTY: State = { ready: false, items: [], unread: 0, balances: { A: 0, D: 0 }, capabilities: null, fresh: [] };

let state: State = EMPTY;
let seen = new Set<number>();
let owner: number | null = null;
let timer: number | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // Not JSON.
  }
  return "That did not work. Try again.";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(`/api/v1${path}`), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) throw new Error(await reason(response));
  return (await response.json()) as T;
}

/** Fetch the bell. New ids after the first load join the popup queue. */
export async function refresh(): Promise<void> {
  try {
    const bell = await api<{ items: Notice[]; unread: number; balances: Balances }>("/notifications");
    const first = !state.ready;
    const arrived = bell.items.filter((n) => !seen.has(n.id) && !n.read);
    for (const n of bell.items) seen.add(n.id);
    set({
      ready: true,
      items: bell.items,
      unread: bell.unread,
      balances: bell.balances,
      fresh: first ? state.fresh : [...arrived, ...state.fresh].slice(0, 6),
    });
    if (!state.capabilities) {
      const wallet = await api<{ capabilities: Capabilities }>("/passes");
      set({ capabilities: wallet.capabilities });
    }
  } catch {
    // Offline or logged out: keep what is shown; the next poll tries again.
  }
}

function start(accountId: number) {
  if (owner === accountId) return;
  stop();
  owner = accountId;
  seen = new Set();
  state = EMPTY;
  void refresh();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
}

function stop() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  owner = null;
  document.removeEventListener("visibilitychange", onVisible);
  set({ ...EMPTY });
}

function onVisible() {
  if (document.visibilityState === "visible") void refresh();
}

/** Remove a notice from the popup queue (it stays in the bell). */
export function dismissFresh(id: number) {
  set({ fresh: state.fresh.filter((n) => n.id !== id) });
}

/**
 * Show a notice as a popup without the server: for the design bench, and for
 * moments the client itself knows about (a send that just went out).
 */
export function pushLocal(notice: Notice) {
  seen.add(notice.id);
  set({ fresh: [notice, ...state.fresh].slice(0, 6) });
}

export async function claim(giftId: number): Promise<Balances> {
  const { balances } = await api<{ balances: Balances }>("/passes/claim", {
    method: "POST",
    body: JSON.stringify({ gift_id: giftId }),
  });
  set({
    balances,
    items: state.items.map((n) =>
      n.gift?.id === giftId ? { ...n, read: true, gift: { ...n.gift, status: "claimed" } } : n,
    ),
    unread: Math.max(0, state.unread - (state.items.some((n) => n.gift?.id === giftId && !n.read) ? 1 : 0)),
  });
  return balances;
}

export async function markAllRead(): Promise<void> {
  if (state.unread === 0) return;
  set({ unread: 0, items: state.items.map((n) => ({ ...n, read: true })) });
  try {
    await api("/notifications/read", { method: "POST", body: JSON.stringify({}) });
  } catch {
    void refresh();
  }
}

export async function markRead(id: number): Promise<void> {
  const target = state.items.find((n) => n.id === id);
  if (!target || target.read) return;
  set({ unread: Math.max(0, state.unread - 1), items: state.items.map((n) => (n.id === id ? { ...n, read: true } : n)) });
  try {
    await api("/notifications/read", { method: "POST", body: JSON.stringify({ ids: [id] }) });
  } catch {
    void refresh();
  }
}

export async function generate(kind: PassKind, quantity: number): Promise<Balances> {
  const { balances } = await api<{ balances: Balances }>("/passes/generate", {
    method: "POST",
    body: JSON.stringify({ kind, quantity }),
  });
  set({ balances });
  return balances;
}

/**
 * The account's passes and bell, re-rendering when they change. Starts the
 * poller for whoever is signed in and stops it on log out.
 */
export function useEcosystem(): State {
  const { status, account } = useAccount();
  const id = account?.id ?? null;
  useEffect(() => {
    if (status !== "ready") return;
    if (id !== null) start(id);
    else if (owner !== null) stop();
  }, [status, id]);
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/* ------------------------------------------------------------- sending -- */

export interface SendResult {
  gifts: number[];
  balances: Balances;
}

/** Send passes as gifts to claim. The server checks every rule. */
export async function sendPasses(details: {
  recipient_ids: number[];
  kind: PassKind;
  quantity: number;
  note?: string;
  generate_missing?: boolean;
  /** Sent from a room's waiting room: the recipients become its invitees. */
  room_code?: string;
}): Promise<SendResult> {
  const result = await api<SendResult>("/passes/send", { method: "POST", body: JSON.stringify(details) });
  set({ balances: result.balances });
  return result;
}

export interface LedgerEntry {
  id: number;
  kind: PassKind;
  delta: number;
  reason: string;
  ref: string | null;
  counterpart: string | null;
  created_at: number;
}

export async function ledger(limit = 30): Promise<LedgerEntry[]> {
  return (await api<{ entries: LedgerEntry[] }>(`/passes/ledger?limit=${limit}`)).entries;
}

/** Administrators: an announcement to every bell, or to some roles'. */
export async function broadcast(details: { title: string; body?: string; link?: string; roles?: string[] }): Promise<number> {
  return (await api<{ sent: number }>("/notifications/broadcast", { method: "POST", body: JSON.stringify(details) })).sent;
}

/* ------------------------------------------------- the Send passes dialog -- */

export interface SendIntent {
  /** People to start with ticked. */
  recipientIds?: number[];
  /** A note to start with, such as the room code. */
  note?: string;
  /**
   * Opened from a room's control bar: the dialog shows that room's waiting
   * room, and passes sent are invites to it (the start waits for them).
   */
  roomCode?: string;
}

let intent: SendIntent | null = null;
const intentListeners = new Set<() => void>();

/** Open the Send passes dialog (mounted once, in App) from anywhere. */
export function openSendPasses(next: SendIntent = {}) {
  intent = next;
  for (const listener of intentListeners) listener();
}

export function closeSendPasses() {
  intent = null;
  for (const listener of intentListeners) listener();
}

export function useSendIntent(): SendIntent | null {
  return useSyncExternalStore(
    (listener) => {
      intentListeners.add(listener);
      return () => intentListeners.delete(listener);
    },
    () => intent,
    () => intent,
  );
}

/* ------------------------------------------------------- the waiting room -- */

export type InviteState = "sent" | "claimed" | "seated" | "acknowledged" | "returned";

export interface Invitee {
  account_id: number;
  name: string;
  email: string;
  state: InviteState;
  team_code: string | null;
  invited_at: number;
}

export interface WaitingRoomStatus {
  code: string;
  phase: "lobby" | "waiting" | "live" | "finished";
  invitees: Invitee[];
  /** One sentence per invitee still holding up the start. */
  blockers: string[];
  ready: boolean;
}

export function fetchWaitingRoom(code: string): Promise<WaitingRoomStatus> {
  return api<WaitingRoomStatus>(`/rooms/${encodeURIComponent(code)}/waiting`);
}

export function removeInvitee(code: string, accountId: number): Promise<{ removed: boolean }> {
  return api(`/rooms/${encodeURIComponent(code)}/invites/${accountId}`, { method: "DELETE" });
}
