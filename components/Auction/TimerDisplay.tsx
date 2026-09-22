/**
 * TimerDisplay.tsx
 * The countdown on the block: a depleting bar and the seconds beside it.
 *
 * Small component, one load-bearing idea. The room owns the clock — it decides
 * when a lot expires and what expiring means — so this never counts *toward*
 * anything. It is a readout. If it disagrees with the room, the room is right
 * and this is stale by one frame.
 *
 * **Why it ticks locally instead of re-rendering the station.**
 * The bar could be driven from the socket by re-broadcasting the remaining
 * seconds, but that would put a frame on the wire ten times a second for every
 * client, and re-render the whole bidding station each time — during the
 * tensest four seconds of a lot, on the screen where a dropped frame is most
 * expensive. Instead the room sends the deadline once, this anchors on it, and
 * the tick stays inside this component. Nothing above it re-renders.
 *
 * **Why `ends_in` and not `deadline`.**
 * Both arrive. The bar anchors on `ends_in` — the seconds left as the room
 * wrote the frame — because seven seconds is short enough for clock skew to
 * matter: a laptop whose clock runs two seconds fast, anchoring on the
 * absolute deadline, would show a lot expiring while the room still holds it
 * open, and would show its own bid window as a third shorter than it is. A
 * count measured from arrival on the browser's own monotonic clock has no skew
 * to accumulate.
 *
 * **Why it is keyed.**
 * `clock.key` changes on every re-arm. React remounts on a changed key, so a
 * bid visibly snaps the bar back to full instead of interpolating from
 * wherever the last buffer had got to — which is the whole feedback of "your
 * bid bought you seven more seconds".
 *
 * **Why two palettes.**
 * The same clock is read from two very different screens: the franchise's
 * war room, which is near-black, and the auctioneer's panel, which is the
 * console's light theme. One component with two tone maps keeps the behaviour
 * — the anchoring, the keying, the tick — in a single place; a second
 * component for the light screen would be the same bug fixed twice.
 *
 * Framer Motion drives the bar as one declarative tween, so the depletion is a
 * single compositor animation rather than sixty layout passes a second.
 */
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

import type { LotClock } from "../../hooks/useAuctionSocket";

interface Tone {
  label: string;
  bar: string;
  text: string;
  track: string;
}

/**
 * How the three buffers read, on each surface.
 *
 * Kept as one table so the two palettes stay visibly parallel: whatever
 * `closing` means on the dark screen, it means on the light one too.
 */
const TONES: Record<"war" | "panel", Record<LotClock["kind"], Tone>> = {
  // The franchise's war room: near-black, high contrast, read across a desk.
  war: {
    // Nobody has bid. Running out costs the room nothing but the player.
    opening: {
      label: "unsold in",
      bar: "bg-neutral-500",
      text: "text-neutral-400",
      track: "border-neutral-700 bg-neutral-900",
    },
    // A bid stands. Running out sells.
    closing: {
      label: "sold in",
      bar: "bg-amber-400",
      text: "text-amber-300",
      track: "border-amber-500/40 bg-neutral-900",
    },
    // A lifeline is burning. Distinct hue because the meaning is different:
    // the room is deliberately paused, not counting down to a decision nobody
    // made.
    timeout: {
      label: "timeout",
      bar: "bg-cyan-400",
      text: "text-cyan-300",
      track: "border-cyan-500/40 bg-neutral-900",
    },
  },
  // The auctioneer's panel: the console's light theme, read at arm's length
  // alongside the pool, the ledger and the Scout.
  panel: {
    opening: {
      label: "unsold in",
      bar: "bg-slate-faint",
      text: "text-slate-muted",
      track: "border-line bg-surface-sunken",
    },
    closing: {
      label: "sold in",
      bar: "bg-[#D9A21B]",
      text: "text-[#8A5A12]",
      track: "border-[#D9A21B]/40 bg-surface-sunken",
    },
    timeout: {
      label: "timeout",
      bar: "bg-[#1E86A8]",
      text: "text-[#1E86A8]",
      track: "border-[#1E86A8]/40 bg-surface-sunken",
    },
  },
};

/** The urgent treatment, once a closing buffer is nearly out. */
const URGENT: Record<"war" | "panel", { bar: string; text: string; track: string }> = {
  war: { bar: "bg-red-500", text: "text-red-400", track: "border-red-500/40 bg-neutral-900" },
  panel: { bar: "bg-unsold", text: "text-unsold", track: "border-unsold/40 bg-surface-sunken" },
};

/** Under this many seconds a closing buffer turns red. */
const URGENT_AT = 3;

export interface TimerDisplayProps {
  /** The running countdown, or null when nothing is armed. */
  clock: LotClock | null;
  /** Code of the franchise whose lifeline is burning, when one is. */
  timeoutBy?: string | null;
  /** Which surface this is being read from. */
  variant?: "war" | "panel";
  /** Denser treatment, for a control bar rather than the focus tunnel. */
  compact?: boolean;
  className?: string;
}

export default function TimerDisplay({
  clock,
  timeoutBy = null,
  variant = "war",
  compact = false,
  className = "",
}: TimerDisplayProps) {
  if (!clock) return null;
  // Keyed here rather than by the caller, so no call site can forget it and
  // quietly turn the reset into a slow interpolation.
  return (
    <Dial
      key={clock.key}
      clock={clock}
      timeoutBy={timeoutBy}
      variant={variant}
      compact={compact}
      className={className}
    />
  );
}

function Dial({
  clock,
  timeoutBy,
  variant,
  compact,
  className,
}: {
  clock: LotClock;
  timeoutBy: string | null;
  variant: "war" | "panel";
  compact: boolean;
  className: string;
}) {
  const reduced = useReducedMotion();
  const [left, setLeft] = useState(clock.endsIn);
  const startedAt = useRef(0);

  useEffect(() => {
    startedAt.current = performance.now();
    setLeft(clock.endsIn);

    // 100ms rather than every frame: the readout shows one decimal, so ten
    // updates a second is already finer than anything it can display, and the
    // bar's smoothness is Framer's problem rather than this interval's.
    const id = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt.current) / 1000;
      setLeft(Math.max(0, clock.endsIn - elapsed));
    }, 100);

    return () => window.clearInterval(id);
  }, [clock.endsIn]);

  const base = TONES[variant][clock.kind];
  const urgent = clock.kind === "closing" && left <= URGENT_AT;
  const tone = urgent ? { ...base, ...URGENT[variant] } : base;
  const fraction = clock.total > 0 ? Math.min(1, clock.endsIn / clock.total) : 1;

  const label =
    clock.kind === "timeout" && timeoutBy ? `timeout · ${timeoutBy}` : base.label;

  return (
    <div
      className={`w-full ${className}`}
      role="timer"
      // The seconds are announced, the bar is decoration. A screen reader
      // getting ten updates a second would be unusable, so only the integer
      // second is exposed and the bar is hidden outright.
      aria-label={`${label} ${Math.ceil(left)} seconds`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`font-mono uppercase tracking-[0.3em] ${
            compact ? "text-[9px]" : "text-[10px]"
          } ${tone.text}`}
        >
          {label}
        </span>
        <span
          className={`font-display font-bold tabular-nums leading-none ${
            compact ? "text-base" : "text-2xl"
          } ${tone.text}`}
        >
          {left.toFixed(1)}
          <span className={compact ? "ml-0.5 text-[9px]" : "ml-1 text-[11px]"}>s</span>
        </span>
      </div>

      <div
        aria-hidden
        className={`mt-1.5 w-full overflow-hidden rounded-full border ${
          compact ? "h-1" : "h-1.5"
        } ${tone.track}`}
      >
        <motion.div
          className={`h-full origin-left rounded-full ${tone.bar}`}
          // Starts wherever this buffer actually is, not always at full: a
          // client that joins or reconnects mid-lot should see the true
          // remainder rather than a dial that pretends the clock just started.
          initial={{ scaleX: fraction }}
          animate={{ scaleX: 0 }}
          transition={
            reduced
              ? { duration: 0 }
              : { duration: Math.max(0, clock.endsIn), ease: "linear" }
          }
        />
      </div>
    </div>
  );
}
