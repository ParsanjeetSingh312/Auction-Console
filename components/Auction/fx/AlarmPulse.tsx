/**
 * AlarmPulse.tsx
 * Five seconds left, and you are not the one holding the bid.
 *
 * **Both halves of that sentence are the condition.** A pulsing alarm shown to
 * the franchise already leading is telling them to panic about winning, and a
 * spectator cannot act on it at all. So it fires only when this station holds a
 * seat, the lot is closing, and someone else is in front.
 *
 * **It does not reuse the timer's threshold.** `TimerDisplay` turns red at
 * `URGENT_AT = 3`; the brief asks for an alarm at 5. Those are two thresholds
 * for two jobs — one is a colour change on a readout you are already watching,
 * the other interrupts you because you may not be. Lowering the timer's
 * threshold to match would change established behaviour for everyone to serve a
 * different feature, so this owns its own number.
 *
 * **It never blocks the bid button.** `pointer-events: none` throughout, and it
 * sits clear of the controls: an alarm that tells you to act and then covers
 * the control you would act with is worse than no alarm. The whole point is the
 * seven seconds you have left.
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

/** The alarm's own threshold. See the note above on why it is not the timer's. */
export const ALARM_AT = 5;

export interface AlarmPulseProps {
  /** Seconds remaining, ticking locally. */
  secondsLeft: number;
  /** The phase of the buffer. Only a closing buffer is worth alarming about. */
  clockKind?: "opening" | "closing" | "timeout" | null;
  /** This station's franchise, or "" for a spectator. */
  myTeam: string;
  /** Who currently holds the bid. */
  leadingTeam: string;
}

export default function AlarmPulse({
  secondsLeft,
  clockKind,
  myTeam,
  leadingTeam,
}: AlarmPulseProps) {
  const reduced = useReducedMotion() ?? false;

  const seated = myTeam.length > 0;
  const behind = leadingTeam !== myTeam;
  const closing = clockKind === "closing";
  const live = seated && behind && closing && secondsLeft > 0 && secondsLeft <= ALARM_AT;

  return (
    <AnimatePresence>
      {live && (
        <motion.div
          key="alarm"
          aria-hidden
          initial={{ opacity: 0, y: -8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2"
        >
          <motion.div
            /*
              The pulse itself. Tied to the second count rather than to a fixed
              loop, so it quickens as the time runs out — an alarm that beats at
              the same rate at five seconds and at one is a light, not a warning.
            */
            animate={
              reduced
                ? { opacity: 1 }
                : { scale: [1, 1.06, 1], opacity: [0.92, 1, 0.92] }
            }
            transition={
              reduced
                ? { duration: 0 }
                : {
                    duration: Math.max(0.34, secondsLeft * 0.13),
                    repeat: Infinity,
                    ease: "easeInOut",
                  }
            }
            className="flex items-center gap-2.5 rounded-full border border-red-500/50 bg-red-950/80 px-4 py-2 shadow-[0_0_28px_-6px_rgba(239,68,68,0.9)] backdrop-blur"
          >
            <span className="relative flex h-2 w-2">
              {!reduced && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              )}
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>

            <span className="font-stadium text-[12px] font-semibold uppercase tracking-[0.18em] text-red-200">
              {Math.ceil(secondsLeft)}s — {leadingTeam || "another team"} leads
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
