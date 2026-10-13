/**
 * playerStats.ts
 * Career figures for the player-select screen, three per side.
 *
 * Taken from the project's own `IPL AUCTION DATA.xlsx`, the same sheet the pool
 * and SCOUT read, so a number on this screen never disagrees with one in the
 * data room. Keyed by `ShowcasePlayer.id`.
 *
 * Which six depends on the role: batters lead with volume and average on the
 * left and scoring rate on the right; the bowler swaps in wickets and economy;
 * the all-rounder carries his batting on the left and his bowling on the right.
 */

export interface SelectStat {
  label: string;
  value: number;
  /** Decimal places to show, so a count-up lands on the sheet's own precision. */
  decimals?: number;
}

export interface PlayerStatSheet {
  left: SelectStat[];
  right: SelectStat[];
}

export const PLAYER_STATS: Record<number, PlayerStatSheet> = {
  // Virat Kohli
  1: {
    left: [
      { label: "Matches", value: 206 },
      { label: "IPL runs", value: 7697 },
      { label: "Average", value: 44.49, decimals: 2 },
    ],
    right: [
      { label: "Strike rate", value: 138.6, decimals: 1 },
      { label: "SR vs pace", value: 150.75, decimals: 2 },
      { label: "SR vs spin", value: 129.62, decimals: 2 },
    ],
  },
  // Rohit Sharma
  2: {
    left: [
      { label: "Matches", value: 257 },
      { label: "IPL runs", value: 6628 },
      { label: "Average", value: 29.72, decimals: 2 },
    ],
    right: [
      { label: "Strike rate", value: 131.14, decimals: 2 },
      { label: "SR vs pace", value: 138.4, decimals: 1 },
      { label: "SR vs spin", value: 122.5, decimals: 1 },
    ],
  },
  // MS Dhoni
  3: {
    left: [
      { label: "Matches", value: 264 },
      { label: "IPL runs", value: 5243 },
      { label: "Average", value: 39.13, decimals: 2 },
    ],
    right: [
      { label: "Strike rate", value: 137.54, decimals: 2 },
      { label: "SR vs pace", value: 152.6, decimals: 1 },
      { label: "SR vs spin", value: 115.4, decimals: 1 },
    ],
  },
  // Jasprit Bumrah
  4: {
    left: [
      { label: "Matches", value: 158 },
      { label: "Wickets", value: 184 },
      { label: "Economy", value: 7.3, decimals: 2 },
    ],
    right: [
      { label: "Bowl average", value: 23.8, decimals: 1 },
      { label: "Econ vs LHB", value: 7.15, decimals: 2 },
      { label: "Econ vs RHB", value: 7.35, decimals: 2 },
    ],
  },
  // Ravindra Jadeja
  5: {
    left: [
      { label: "Matches", value: 240 },
      { label: "IPL runs", value: 2959 },
      { label: "Strike rate", value: 129.5, decimals: 1 },
    ],
    right: [
      { label: "Wickets", value: 160 },
      { label: "Economy", value: 7.65, decimals: 2 },
      { label: "Bowl average", value: 36.25, decimals: 2 },
    ],
  },
  // KL Rahul
  6: {
    left: [
      { label: "Matches", value: 132 },
      { label: "IPL runs", value: 4683 },
      { label: "Average", value: 45.47, decimals: 2 },
    ],
    right: [
      { label: "Strike rate", value: 134.42, decimals: 2 },
      { label: "SR vs pace", value: 139.2, decimals: 1 },
      { label: "SR vs spin", value: 128.5, decimals: 1 },
    ],
  },
};

export function formatStat(value: number, decimals = 0): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
