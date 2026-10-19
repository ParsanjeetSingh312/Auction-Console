/**
 * connectionsApi.ts
 * Friend requests and the friends list (api/routes_ecosystem.py), with a
 * small shared cache so the Connections page and the Send passes dialog see
 * the same list without each fetching it.
 */
import { useEffect, useSyncExternalStore } from "react";

import type { Role } from "./accountStore";
import { useAccount } from "./accountStore";
import { api } from "./ecosystemStore";

export interface Person {
  id: number;
  name: string;
  role: Role;
  admin: boolean;
}

export interface Connection extends Person {
  connection_id: number;
  since: number;
}

export interface SearchHit extends Person {
  link: "none" | "friends" | "incoming" | "outgoing";
}

export interface Connections {
  friends: Connection[];
  incoming: Connection[];
  outgoing: Connection[];
}

interface State {
  ready: boolean;
  data: Connections;
}

let state: State = { ready: false, data: { friends: [], incoming: [], outgoing: [] } };
let loadedFor: number | null = null;
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

export async function reloadConnections(): Promise<void> {
  try {
    set({ ready: true, data: await api<Connections>("/connections") });
  } catch {
    set({ ...state, ready: true });
  }
}

export function useConnections(): State {
  const { account } = useAccount();
  const id = account?.id ?? null;
  useEffect(() => {
    if (id !== null && loadedFor !== id) {
      loadedFor = id;
      void reloadConnections();
    }
  }, [id]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export async function searchPeople(q: string): Promise<SearchHit[]> {
  return (await api<{ results: SearchHit[] }>(`/connections/search?q=${encodeURIComponent(q)}`)).results;
}

export async function requestConnection(accountId: number): Promise<"pending" | "accepted"> {
  const { status } = await api<{ status: "pending" | "accepted" }>("/connections/request", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId }),
  });
  await reloadConnections();
  return status;
}

export async function respondConnection(connectionId: number, accept: boolean): Promise<void> {
  await api(`/connections/${connectionId}/respond`, { method: "POST", body: JSON.stringify({ accept }) });
  await reloadConnections();
}

export async function removeConnection(accountId: number): Promise<void> {
  await api(`/connections/${accountId}`, { method: "DELETE" });
  await reloadConnections();
}

/** The colour an account's role wears across the ecosystem. */
export function toneOf(person: Pick<Person, "role" | "admin">): string {
  if (person.admin) return "#E8C547";
  if (person.role === "auctioneer") return "#FB923C";
  if (person.role === "delegate") return "#22D3EE";
  return "#94A3B8";
}

export function tierLabel(person: Pick<Person, "role" | "admin">): string {
  if (person.admin) return "Admin";
  return person.role === "member" ? "Free" : person.role === "auctioneer" ? "Auctioneer" : "Delegate";
}
