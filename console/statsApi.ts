/**
 * statsApi.ts
 * How fresh the player statistics are, and the live figures themselves.
 *
 * The backend recomputes every pool player's IPL career from ball-by-ball
 * data once a quarter (scout/stats_refresh.py). Two things on the client
 * depend on that:
 *
 *   1. Every surface that shows a figure says how current it is -- "IPL
 *      career stats through 2026 · refreshed 23 Oct" -- so a number on screen
 *      always carries its age. `useStatsStatus` is that reading.
 *   2. The few components that used to carry figures typed in by hand (the
 *      marquee reveal, the hero cards) read the live pool instead, so a
 *      refresh reaches them too. `useLivePlayer` is that lookup.
 *
 * Both are module-cached: one request per page load however many components
 * ask, and every subscriber re-renders when an admin refresh lands.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { api } from "./ecosystemStore";
import { fetchPlayers } from "./ragClient";
import type { ApiPlayer } from "./types";

export interface StatsStatus {
  state?: "ok" | "failed" | "deferred" | "running";
  refreshed_at?: string;
  next_due?: string;
  season_through?: number;
  last_match_date?: string;
  players_updated?: number;
  players_in_pool?: number;
  split_coverage?: number | null;
  styles_pending?: number;
  running?: boolean;
  refresh_days?: number;
  note?: string;
  accepted?: boolean;
}

/* ------------------------------------------------------------------ */
/* Freshness                                                           */
/* ------------------------------------------------------------------ */

let status: StatsStatus | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function loadStatsStatus(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  inflight = api<StatsStatus>("/stats/status")
    .then((next) => {
      status = next;
      emit();
    })
    .catch(() => {
      // Freshness is a label, not a feature: a backend without the endpoint
      // simply shows no badge.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The last refresh's outcome, or null until it has loaded. */
export function useStatsStatus(): StatsStatus | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
  useEffect(() => {
    if (!status) void loadStatsStatus();
  }, []);
  return value;
}

/** "through IPL 2026 · refreshed 23 Oct" -- or null when nothing has run yet. */
export function describeFreshness(s: StatsStatus | null): string | null {
  if (!s?.season_through) return null;
  const when = s.refreshed_at
    ? new Date(s.refreshed_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null;
  return `IPL career stats through ${s.season_through}${when ? ` · refreshed ${when}` : ""}`;
}

/** Admin: run the quarterly refresh now. Returns at once; poll the status. */
export async function refreshStatsNow(): Promise<StatsStatus> {
  const result = await api<StatsStatus>("/stats/refresh", { method: "POST" });
  status = { ...(status ?? {}), ...result };
  emit();
  return result;
}

/* ------------------------------------------------------------------ */
/* Live figures by name                                                */
/* ------------------------------------------------------------------ */

let pool: Map<string, ApiPlayer> | null = null;
let poolInflight: Promise<void> | null = null;
const poolListeners = new Set<() => void>();

function loadPool(): Promise<void> {
  if (poolInflight) return poolInflight;
  poolInflight = fetchPlayers()
    .then((response) => {
      pool = new Map(response.players.map((p) => [p.player_name.toLowerCase(), p]));
      for (const listener of poolListeners) listener();
    })
    .catch(() => {
      // Offline or no backend: callers keep the figures they were built with.
    })
    .finally(() => {
      poolInflight = null;
    });
  return poolInflight;
}

/**
 * The pool's current row for a player, by the name the pool spells.
 * Null until loaded (or when the backend is unreachable), so a caller renders
 * its built-in figure first and swaps to the live one when it arrives.
 */
export function useLivePlayer(name: string | null | undefined): ApiPlayer | null {
  const map = useSyncExternalStore(
    (listener) => {
      poolListeners.add(listener);
      return () => poolListeners.delete(listener);
    },
    () => pool,
  );
  useEffect(() => {
    if (!pool) void loadPool();
  }, []);
  return name && map ? (map.get(name.toLowerCase()) ?? null) : null;
}

/** Same lookup outside React, for helpers that build figures from a row. */
export function livePlayerNow(name: string): ApiPlayer | null {
  return pool?.get(name.toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------ */
/* Overlaying hand-typed figures with live ones                        */
/* ------------------------------------------------------------------ */

/**
 * Which pool column a figure's label means. The marquee reveal and the hero
 * cards were written with spreadsheet figures typed in by hand; each label
 * names its column here so the live value can replace it.
 */
const LABEL_COLUMN: Record<string, keyof ApiPlayer> = {
  "matches": "matches",
  "ipl matches": "matches",
  "ipl runs": "total_runs",
  "runs": "total_runs",
  "average": "bat_avg",
  "batting average": "bat_avg",
  "strike rate": "bat_sr",
  "strike rate vs pace": "sr_vs_fast",
  "sr vs pace": "sr_vs_fast",
  "sr vs spin": "sr_vs_spin",
  "boundary % vs pace": "boundary_pct_fast",
  "boundary % vs spin": "boundary_pct_spin",
  "ipl wickets": "wickets",
  "wickets": "wickets",
  "economy": "economy",
  "bowl average": "bowl_avg",
  "balls per wicket": "bowl_sr",
  "econ vs lhb": "econ_vs_lhb",
  "econ vs rhb": "econ_vs_rhb",
};

/** The live value for a labelled figure, or null when there is none. */
export function liveValue(label: string, row: ApiPlayer | null): number | null {
  if (!row) return null;
  const column = LABEL_COLUMN[label.trim().toLowerCase()];
  const value = column ? row[column] : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A list of {label, value} figures with each value replaced by the live one where known. */
export function overlayStats<T extends { label: string; value: number }>(
  stats: T[],
  row: ApiPlayer | null,
): T[] {
  if (!row) return stats;
  return stats.map((stat) => {
    const live = liveValue(stat.label, row);
    return live == null ? stat : { ...stat, value: live };
  });
}

/** Start loading the live pool without subscribing to it. */
export function prefetchLivePool(): void {
  if (!pool) void loadPool();
}

/**
 * Re-render when the live pool arrives, for components that overlay several
 * players' figures at once. Returns a lookup by pool name.
 */
export function useLivePool(): (name: string) => ApiPlayer | null {
  const map = useSyncExternalStore(
    (listener) => {
      poolListeners.add(listener);
      return () => poolListeners.delete(listener);
    },
    () => pool,
  );
  useEffect(() => {
    if (!pool) void loadPool();
  }, []);
  return useCallback(
    (name: string) => (map ? (map.get(name.toLowerCase()) ?? null) : null),
    [map],
  );
}

/** A showcase card's single figure ("8,004 IPL runs"), with the live value. */
export function liveShowcase<T extends { name: string; surname: string; stat: string; statLabel: string }>(
  player: T,
  lookup: (name: string) => ApiPlayer | null,
): T {
  const live = liveValue(player.statLabel, lookup(`${player.name} ${player.surname}`));
  if (live == null) return player;
  const decimals = Number.isInteger(live) ? 0 : 2;
  return { ...player, stat: live.toLocaleString("en-IN", { maximumFractionDigits: decimals }) };
}
