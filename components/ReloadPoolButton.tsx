/**
 * ReloadPoolButton.tsx
 * Re-fetch the player pool from the RAG backend.
 *
 * There is one of these on every screen that reads the roster, and it exists
 * because the pool is the one piece of state the console does not own: it
 * comes from `GET /api/v1/players`, and it changes underneath a running
 * browser whenever someone re-runs ingestion or edits the workbook. Without
 * this the only remedy is a full page reload, which on the auctioneer's screen
 * also costs them their split layout and whatever they had open — mid-lot.
 *
 * The loading state is not decoration. A pool fetch against a cold backend can
 * take a few seconds, and a button that looks identical before and during the
 * request invites a second click, which is how you end up with two in-flight
 * fetches racing to set the same state.
 *
 * Styling is left to the caller because the three call sites live in different
 * visual systems — the console's `.util` chrome, the split screen's Tailwind
 * control bar, and the seat picker's cards. What is shared is the behaviour and
 * the wording, which is the part that should not drift.
 */
import { motion, useReducedMotion } from "framer-motion";

import { pressable } from "../console/motion";

export interface ReloadPoolButtonProps {
  loading: boolean;
  onReload: () => void;
  /** Defaults to the split screen's chrome; pass `.util` for the console. */
  className?: string;
  /** Pass through when the parent already resolved it, to avoid a second hook call. */
  reduced?: boolean;
  /** Hidden on narrow control bars where the icon carries the meaning. */
  showLabel?: boolean;
}

const DEFAULT_CLASS =
  "flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-ui text-[10px] " +
  "font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors " +
  "hover:border-slate-faint/60 hover:text-slate-ink disabled:cursor-not-allowed disabled:opacity-60";

export default function ReloadPoolButton({
  loading,
  onReload,
  className = DEFAULT_CLASS,
  reduced,
  showLabel = true,
}: ReloadPoolButtonProps) {
  const detected = useReducedMotion();
  const still = reduced ?? !!detected;

  return (
    <motion.button
      {...(still || loading ? {} : pressable)}
      type="button"
      onClick={onReload}
      disabled={loading}
      className={className}
      title={
        loading
          ? "Fetching the player pool…"
          : "Re-fetch the player pool from the RAG backend"
      }
      aria-busy={loading}
    >
      <RefreshIcon spinning={loading && !still} />
      {showLabel && <span>{loading ? "Loading…" : "Reload pool"}</span>}
    </motion.button>
  );
}

/**
 * The circular arrow, rotating while a fetch is open.
 *
 * Driven by Framer rather than a CSS keyframe so it obeys the same reduced
 * motion decision as everything else on the page — a spinner is exactly the
 * kind of endless movement that setting exists to stop.
 */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      className="h-[13px] w-[13px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      animate={spinning ? { rotate: 360 } : { rotate: 0 }}
      transition={
        spinning
          ? { duration: 0.9, repeat: Infinity, ease: "linear" }
          : { duration: 0.2 }
      }
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </motion.svg>
  );
}
