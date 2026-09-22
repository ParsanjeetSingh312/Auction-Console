/**
 * useBlockFx.ts
 * Turning room state into one-shot triggers.
 *
 * The block's effects answer *events* — a lot was sold, a bid landed, the clock
 * is nearly out — but what the view actually receives is *state*: a ticker
 * array and a clock object, both of which arrive again on every render. Firing
 * an animation off state means firing it repeatedly, so these hooks do the
 * translation once and hand each effect a trigger it can trust.
 *
 * The rule throughout: identify an event by its **id**, never by its contents.
 * Two bids of the same amount by the same team are two events; a re-render
 * carrying the same entry is not. `TickerEntry.id` is the only thing that
 * distinguishes them.
 */
import { useEffect, useRef, useState } from "react";

import type { LotClock } from "../../../hooks/useAuctionSocket";
import type { TickerEntry } from "../blockTypes";

/**
 * The newest ticker entry of a given kind, but only when it is genuinely new.
 *
 * Returns null on every render where nothing has arrived, so a component can
 * key an animation off the identity of the returned object.
 *
 * Deliberately does **not** fire for entries that were already present when the
 * hook mounted. Joining a room mid-auction should not replay the last sale as
 * though it just happened.
 */
export function useNewEntry(
  ticker: TickerEntry[],
  kind: TickerEntry["kind"],
): TickerEntry | null {
  const [entry, setEntry] = useState<TickerEntry | null>(null);
  const seen = useRef<number | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    const latest = ticker.find((item) => item.kind === kind) ?? null;

    if (!mounted.current) {
      // Whatever is already on the board is history, not news.
      mounted.current = true;
      seen.current = latest?.id ?? null;
      return;
    }

    if (latest && latest.id !== seen.current) {
      seen.current = latest.id;
      setEntry(latest);
    }
  }, [ticker, kind]);

  return entry;
}

/**
 * Seconds remaining on the clock, ticking locally between server frames.
 *
 * `LotClock.endsIn` is a snapshot from the frame it arrived in, so a component
 * that reads it directly shows a number that only moves when the server speaks.
 * This counts down from that snapshot against `performance.now()`.
 *
 * Ten updates a second, matching `TimerDisplay` — which runs its own copy of
 * this rather than sharing one. Both derive from the same `endsIn` and the same
 * clock, so they agree; extracting a single hook would mean editing a component
 * that is working, for no behavioural gain.
 */
export function useSecondsLeft(clock: LotClock | null | undefined): number {
  const [left, setLeft] = useState(clock?.endsIn ?? 0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!clock) {
      setLeft(0);
      return;
    }
    startedAt.current = performance.now();
    setLeft(clock.endsIn);

    const id = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt.current) / 1000;
      setLeft(Math.max(0, clock.endsIn - elapsed));
    }, 100);

    return () => window.clearInterval(id);
  }, [clock?.endsIn, clock?.key]);

  return left;
}

/**
 * How many increments this bid jumped.
 *
 * 1 for a standard raise, more for a jumpbid. The room already treats these as
 * different things — `useAuctionSocket`'s bid call notes that an omitted amount
 * takes the standard increment while a supplied one "is a jumpbid" — so this
 * reads the size back out of the numbers rather than inventing a signal.
 *
 * Returns 0 when there is no previous figure to compare against, which is the
 * opening bid: it jumped nothing, it started.
 */
export function jumpSize(
  amount: number | null,
  previous: number | null,
  incrementFor: (bid: number) => number,
): number {
  if (amount === null || previous === null || amount <= previous) return 0;
  const step = incrementFor(previous);
  if (step <= 0) return 0;
  return Math.max(1, Math.round((amount - previous) / step));
}
