/**
 * trendingApi.ts
 * The landing's Trending Players, from the backend instead of a fixed list.
 *
 * `GET /api/v1/trending` returns players in the news first (Hardik Pandya,
 * Arshdeep Singh, whoever data/trending_players.json names), then a fresh mix
 * from the pool that changes with every ingestion (ingestion/trending.py).
 *
 * This file turns that list into the two shapes PlayerSelect already takes:
 * `ShowcasePlayer[]` for the cards and a `PlayerStatSheet` per card for the
 * six career figures. If the backend cannot be reached, the hook keeps the
 * original six showcase players, so the landing never shows an empty deal.
 */
import { useEffect, useState } from "react";

import { apiUrl } from "./apiBase";
import { franchiseOf } from "./franchises";
import { ROLE_TINT, SHOWCASE_PLAYERS, type ShowcasePlayer, type ShowcaseRole } from "../utils/players";
import { PLAYER_STATS, type PlayerStatSheet, type SelectStat } from "../utils/playerStats";

/** One player as the backend sends them. */
interface ApiTrendingPlayer {
  name: string;
  first_name: string;
  surname: string;
  jersey: number;
  role: ShowcaseRole;
  role_label: string;
  country: string;
  /** "Trade news" and the like for players in the news; null for the fresh mix. */
  tag: string | null;
  stat: string;
  stat_label: string;
  sheet: { left: SelectStat[]; right: SelectStat[] };
}

interface ApiTrending {
  built_at: string;
  players: ApiTrendingPlayer[];
}

export interface TrendingDeal {
  players: ShowcasePlayer[];
  stats: Record<number, PlayerStatSheet>;
  /** Each card's news tag, by ShowcasePlayer id. */
  tags: Record<number, string>;
  /** When the backend built this list; null for the built-in fallback. */
  builtAt: string | null;
}

const FALLBACK: TrendingDeal = { players: SHOWCASE_PLAYERS, stats: PLAYER_STATS, tags: {}, builtAt: null };

/** Too dark to read on the night ground (e.g. a navy kit)? */
function isDark(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length !== 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.28;
}

/** The card's accent: the franchise colour if it reads on dark, else the role's. */
function accentFor(player: ApiTrendingPlayer): string {
  const team = franchiseOf(player.name);
  for (const colour of [team?.primary, team?.accent]) {
    if (colour && !isDark(colour)) return colour;
  }
  return ROLE_TINT[player.role] ?? "#22D3EE";
}

function toDeal(data: ApiTrending): TrendingDeal {
  const players: ShowcasePlayer[] = [];
  const stats: Record<number, PlayerStatSheet> = {};
  const tags: Record<number, string> = {};
  data.players.forEach((p, i) => {
    const id = i + 1;
    players.push({
      id,
      name: p.first_name,
      surname: p.surname,
      number: p.jersey,
      role: p.role,
      roleLabel: p.role_label,
      country: p.country,
      accent: accentFor(p),
      stat: p.stat,
      statLabel: p.stat_label,
      image: null,
    });
    stats[id] = p.sheet;
    if (p.tag) tags[id] = p.tag;
  });
  return { players, stats, tags, builtAt: data.built_at };
}

/** One fetch per page load, shared by every caller. */
let cached: Promise<TrendingDeal> | null = null;

function loadTrending(): Promise<TrendingDeal> {
  cached ??= fetch(apiUrl("/api/v1/trending"))
    .then((response) => (response.ok ? (response.json() as Promise<ApiTrending>) : Promise.reject(response.status)))
    .then((data) => (data.players?.length ? toDeal(data) : FALLBACK))
    .catch(() => FALLBACK);
  return cached;
}

/** Trending Players for the landing: the backend's list, or the built-in six. */
export function useTrending(): TrendingDeal {
  const [deal, setDeal] = useState<TrendingDeal>(FALLBACK);
  useEffect(() => {
    let live = true;
    void loadTrending().then((next) => live && setDeal(next));
    return () => {
      live = false;
    };
  }, []);
  return deal;
}
