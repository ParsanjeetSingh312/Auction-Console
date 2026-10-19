/**
 * scoutQuota.ts
 * SCOUT's allowance for this visitor (api/scout_quota.py): unlimited for
 * Auctioneer, Delegate and admin accounts; SCOUT_FREE_LIMIT requests in a
 * rolling window (10 in 2 hours) for Free accounts and signed-out visitors.
 *
 * Read when SCOUT opens and again after every question, so the meter in the
 * drawer counts down as it is used. The server is the one counting.
 */
import { useEffect, useSyncExternalStore } from "react";

import { apiUrl } from "./apiBase";
import { useAccount } from "./accountStore";

export interface ScoutQuota {
  limited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  resets_at: number | null;
  window_seconds: number;
}

let quota: ScoutQuota | null = null;
const listeners = new Set<() => void>();

export async function refreshScoutQuota(): Promise<void> {
  try {
    const response = await fetch(apiUrl("/api/v1/scout/quota"), { credentials: "include" });
    if (!response.ok) return;
    quota = (await response.json()) as ScoutQuota;
    for (const listener of listeners) listener();
  } catch {
    // Offline: keep the last reading.
  }
}

/** The allowance, refreshed when the account changes. */
export function useScoutQuota(): ScoutQuota | null {
  const { status, account } = useAccount();
  const id = account?.id ?? null;
  useEffect(() => {
    if (status === "ready") void refreshScoutQuota();
  }, [status, id]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => quota,
    () => quota,
  );
}

/** "1h 12m", "42m", "under a minute". */
export function untilReset(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const s = Math.max(0, resetsAt - Date.now() / 1000);
  if (s < 60) return "under a minute";
  const minutes = Math.ceil(s / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
