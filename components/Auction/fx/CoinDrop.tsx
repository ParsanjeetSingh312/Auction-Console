/**
 * CoinDrop.tsx
 * Coins for a bid — more of them when the bid jumped.
 *
 * **The cascade is not decoration, it is the reading.** A jumpbid and a
 * standard raise are different moves: one accepts the ladder, the other tries
 * to end the contest. The room already treats them as different — the socket's
 * bid call notes that an omitted amount takes the standard increment while a
 * supplied one "is a jumpbid" — so the count here is derived from the numbers
 * rather than from a flag someone has to remember to set. One coin per
 * increment crossed, so the size of the move is legible without reading it.
 *
 * Capped at eight. A twenty-increment jump is a real thing and eighty coins is
 * a screensaver; past about eight the count stops being countable anyway and
 * the only thing that grows is the frame time.
 *
 * framer-motion rather than GSAP, and that is the rule rather than an
 * exception: this is independent per-element motion with no shared timeline to
 * key off. `HammerDrop` needs a label because four things happen on one frame.
 * Coins just fall.
 */
import { useEffect, useState } from "react";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

const MAX_COINS = 8;
/** Long enough to read as a fall, short enough to finish before the next bid. */
const FALL_SECONDS = 0.9;

export interface CoinDropProps {
  /**
   * Identity of the bid that triggered this. A new value fires a new cascade;
   * the same value re-rendering does not.
   */
  eventId: number | null;
  /** Increments crossed. 1 is a standard raise; more is a jump. */
  increments: number;
  /** True when this station placed the bid — its own raise reads warmer. */
  mine?: boolean;
}

export default function CoinDrop({ eventId, increments, mine = false }: CoinDropProps) {
  const reduced = useReducedMotion() ?? false;
  const [burst, setBurst] = useState<{ id: number; count: number } | null>(null);

  useEffect(() => {
    if (eventId === null || reduced) return;
    const count = Math.max(1, Math.min(MAX_COINS, increments || 1));
    setBurst({ id: eventId, count });

    // Cleared on a timer rather than on animation end: with several coins the
    // last one to finish is not deterministic, and one stuck coin would sit on
    // screen until the next bid.
    const id = window.setTimeout(
      () => setBurst(null),
      (FALL_SECONDS + 0.35) * 1000,
    );
    return () => window.clearTimeout(id);
  }, [eventId, increments, reduced]);

  if (reduced) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <AnimatePresence>
        {burst &&
          Array.from({ length: burst.count }, (_, i) => {
            // Spread across the middle of the frame, deterministic per index so
            // the same jump looks the same twice.
            const left = 50 + (i - (burst.count - 1) / 2) * 7;
            const delay = i * 0.055;
            const spin = i % 2 === 0 ? 220 : -260;

            return (
              <motion.span
                key={`${burst.id}:${i}`}
                initial={{ top: "18%", opacity: 0, rotate: 0, scale: 0.7 }}
                animate={{ top: "72%", opacity: [0, 1, 1, 0], rotate: spin, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: FALL_SECONDS,
                  delay,
                  // Gravity: slow off the top, quick at the bottom.
                  ease: [0.42, 0, 0.9, 1],
                  opacity: { duration: FALL_SECONDS, delay, times: [0, 0.15, 0.7, 1] },
                }}
                className="absolute h-[18px] w-[18px] rounded-full"
                style={{
                  left: `${left}%`,
                  background: mine
                    ? "radial-gradient(circle at 34% 30%, #7fe6ff, #23a9d6 62%, #0b5d78)"
                    : "radial-gradient(circle at 34% 30%, #f7e2ae, #d8b271 62%, #8d6a35)",
                  boxShadow: mine
                    ? "0 0 12px -2px rgba(55,208,255,0.8)"
                    : "0 0 12px -2px rgba(216,178,113,0.8)",
                }}
              />
            );
          })}
      </AnimatePresence>
    </div>
  );
}
