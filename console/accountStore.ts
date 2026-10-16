/**
 * accountStore.ts
 * The signed-in account, for the whole site.
 *
 * The session is an httpOnly cookie the server sets (api/routes_accounts.py):
 * this page can neither read nor forge it, and it rides along on every request
 * and on the auction WebSocket's handshake. What this module holds is only the
 * server's answer to "who am I", fetched once and refreshed on log in and out,
 * so the nav, the account page and Live Bidding all agree without each asking.
 *
 * The role decides what Live Bidding offers, but the server decides what is
 * allowed: hiding a button here is a courtesy, not the lock.
 */
import { useSyncExternalStore } from "react";

import { apiUrl } from "./apiBase";

export type Role = "auctioneer" | "delegate" | "member";

export interface Account {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** An administrator (granted on the server by email): full access. */
  admin?: boolean;
  created_at: number;
}

/** The tag an account wears. */
export const ROLE_TAG: Record<Role, string> = {
  auctioneer: "AUCTIONEER",
  delegate: "DELEGATE",
  member: "MEMBER",
};

/** The tag an account wears in the header and on its page. */
export function tagFor(account: Account): string {
  return account.admin ? "ADMIN" : ROLE_TAG[account.role];
}

export const ADMIN_BLURB =
  "Administrator: full access. Create and run any auction room, join any room, and use the admin tools.";

/** May this account create auction rooms? (The server decides; this mirrors it.) */
export function canCreateRooms(account: Account | null): boolean {
  return !!account && (account.role === "auctioneer" || !!account.admin);
}

/** May this account join a room by code? Delegates to bid, auctioneers to rejoin their own. */
export function canJoinRooms(account: Account | null): boolean {
  return !!account && (account.role !== "member" || !!account.admin);
}

/** What each role is for, in a line. */
export const ROLE_BLURB: Record<Role, string> = {
  auctioneer: "Create auction rooms and run them from the control panel.",
  delegate: "Join a room with its code, take a franchise seat and bid.",
  member: "The free tier: the data room, SCOUT and AUCTEAM. No seat in a live room.",
};

interface State {
  status: "loading" | "ready";
  account: Account | null;
}

let state: State = { status: "loading", account: null };
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The server's reason for refusing, as one sentence. */
async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail) && body.detail.length) {
      const first = body.detail[0] as { msg?: string; loc?: unknown[] };
      const field = Array.isArray(first.loc) ? String(first.loc[first.loc.length - 1]) : "";
      const msg = String(first.msg ?? "").replace(/^Value error, /, "");
      if (field === "password" && /at least/.test(msg)) return "Use a password of at least 8 characters.";
      if (field === "name") return msg.startsWith("String should") ? "Enter your name." : msg;
      return msg || "Check the details and try again.";
    }
  } catch {
    // Not JSON; fall through.
  }
  return response.status >= 500 ? "The server could not do that. Try again." : "That did not work. Try again.";
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(`/api/v1/accounts${path}`), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

let loading: Promise<void> | null = null;

/** Ask the server who is signed in. Once per page load unless forced. */
export function loadAccount(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await call("/me");
      set({ status: "ready", account: response.ok ? ((await response.json()).account as Account) : null });
    } catch {
      set({ status: "ready", account: null });
    }
  })();
  return loading;
}

export async function register(details: {
  name: string;
  email: string;
  password: string;
  role: Role;
}): Promise<Account> {
  const response = await call("/register", { method: "POST", body: JSON.stringify(details) });
  if (!response.ok) throw new Error(await reason(response));
  const account = (await response.json()).account as Account;
  set({ status: "ready", account });
  return account;
}

export async function logIn(email: string, password: string): Promise<Account> {
  const response = await call("/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!response.ok) throw new Error(await reason(response));
  const account = (await response.json()).account as Account;
  set({ status: "ready", account });
  return account;
}

export async function logOut(): Promise<void> {
  try {
    await call("/logout", { method: "POST" });
  } finally {
    set({ status: "ready", account: null });
  }
}

/** The signed-in account, re-rendering when it changes. Starts the first load. */
export function useAccount(): State {
  if (state.status === "loading" && !loading) void loadAccount();
  return useSyncExternalStore(subscribe, () => state, () => state);
}
