/**
 * MagneticButton.tsx
 * A call to action that leans a few pixels toward the cursor.
 *
 * The pull is six pixels. That number is the whole design: enough that the
 * button feels like it has weight and is aware of you, small enough that it
 * still sits under the cursor where you aimed. A strongly magnetic button is a
 * novelty that actively hurts — the target moves away from the click.
 *
 * It is a `Link`, always. A CTA that navigates must be an anchor: middle-click,
 * ⌘-click, "copy link address" and the status-bar preview all come free, and a
 * div with an onClick forfeits every one of them plus keyboard access.
 *
 * The magnetism is disabled under reduced motion and never runs on touch — a
 * pointer that only exists while it is pressing has nothing to lean toward, and
 * the listener would be pure cost.
 */
import { useRef } from "react";
import { Link } from "react-router-dom";
import { motion, useMotionValue, useReducedMotion, useSpring } from "framer-motion";

import { MAGNET_STRENGTH, POINTER_SPRING } from "../../utils/animations";

const TONES = {
  gold:
    "bg-auctiq-gold text-auctiq-void shadow-gold-glow hover:brightness-[1.06] font-semibold",
  ghost:
    "border border-white/15 text-auctiq-text hover:border-auctiq-gold/40 hover:text-auctiq-gold",
} as const;

export interface MagneticButtonProps {
  to: string;
  children: React.ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}

export default function MagneticButton({
  to,
  children,
  tone = "gold",
  className = "",
}: MagneticButtonProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLAnchorElement>(null);

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const x = useSpring(mx, POINTER_SPRING);
  const y = useSpring(my, POINTER_SPRING);

  const handleMove = (event: React.PointerEvent<HTMLAnchorElement>) => {
    // `pointerType` rather than a media query: this is per-event, so a hybrid
    // laptop gets magnetism from its trackpad and none from its touchscreen.
    if (reduced || event.pointerType === "touch") return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    mx.set(((event.clientX - rect.left) / rect.width - 0.5) * 2 * MAGNET_STRENGTH);
    my.set(((event.clientY - rect.top) / rect.height - 0.5) * 2 * MAGNET_STRENGTH);
  };

  const reset = () => {
    mx.set(0);
    my.set(0);
  };

  return (
    <MotionLink
      ref={ref}
      to={to}
      onPointerMove={handleMove}
      onPointerLeave={reset}
      style={reduced ? undefined : { x, y }}
      whileHover={reduced ? undefined : { scale: 1.03 }}
      whileTap={reduced ? undefined : { scale: 0.97 }}
      transition={POINTER_SPRING}
      // min-h-[44px] is the database's touch-target floor, and it applies to a
      // mouse too — a 32px button is fiddly with any pointer.
      className={`inline-flex min-h-[44px] items-center rounded-full px-7 font-tech text-[12px] uppercase tracking-[0.16em] transition-colors duration-200 ${TONES[tone]} ${className}`}
    >
      {children}
    </MotionLink>
  );
}

/**
 * `motion.create` rather than wrapping a Link in a motion.div.
 *
 * A wrapper would move the box while leaving the anchor's own hit area behind
 * it — so at the edge of the travel the cursor is over the visual button but
 * outside the thing that navigates. Animating the anchor itself keeps the
 * clickable region and the pixels in the same place.
 */
const MotionLink = motion.create(Link);
