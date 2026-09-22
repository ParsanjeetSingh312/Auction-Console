/**
 * blockTypes.ts
 * The vocabulary the war-room view speaks, shared by both of its drivers.
 *
 * Kept separate from the view so that the mock feed and the live engine can
 * import the shapes without pulling in React or GSAP — and so the two drivers
 * are provably speaking about the same thing.
 *
 * Money is held in ₹ lakh throughout and rendered in crore, matching the rest
 * of the console. Lakh keeps the increment ladder on integers; stepping a
 * crore-denominated float by 0.2 accumulates visible drift over a long lot.
 */

export interface Lot {
  id: number;
  name: string;
  role: string;
  country: string | null;
  /** Reserve price, ₹ lakh. */
  base: number;
  rating: number | null;
  /** A headline career figure, already formatted. Empty when unknown. */
  headline: string;
}

export interface TickerEntry {
  id: number;
  kind: "bid" | "sold" | "unsold" | "lot" | "note" | "timeout" | "withdraw";
  text: string;
  /** ₹ lakh, or null for entries that carry no figure. */
  amount: number | null;
  /** True when this station was the actor — drives the cyan highlight. */
  mine: boolean;
}

/** The ladder: the step grows with the price, as it does in the room. */
export function incrementFor(bid: number): number {
  if (bid < 100) return 5;
  if (bid < 200) return 10;
  if (bid < 500) return 20;
  if (bid < 1000) return 25;
  return 50;
}

/** ₹ lakh in, broadcast caption out. */
export function crore(lakh: number): string {
  if (!Number.isFinite(lakh)) return "—";
  return lakh >= 100 ? `₹${(lakh / 100).toFixed(2)} CR` : `₹${Math.round(lakh)} L`;
}

/**
 * Every frame shadow in one place, so the states stay visibly comparable.
 *
 * Written as full box-shadow strings because GSAP interpolates them layer by
 * layer, which needs both ends to have the same shape — a two-layer shadow
 * cannot tween into a one-layer shadow.
 */
export const GLOW = {
  counterLow: "0 0 0 1px rgba(250,204,21,.35), 0 0 30px -6px rgba(250,204,21,.25)",
  counterHigh: "0 0 0 2px rgba(250,204,21,.95), 0 0 70px -4px rgba(250,204,21,.55)",
  winning: "0 0 0 2px rgba(16,185,129,.90), 0 0 60px -8px rgba(16,185,129,.45)",
  blocked: "0 0 0 2px rgba(239,68,68,.75), 0 0 40px -10px rgba(239,68,68,.30)",
  reject: "0 0 0 3px rgba(239,68,68,1.0), 0 0 80px -4px rgba(239,68,68,.70)",
} as const;
