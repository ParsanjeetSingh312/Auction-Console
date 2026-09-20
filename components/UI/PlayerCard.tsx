/**
 * PlayerCard.tsx
 * A player, as a card that leans toward the cursor.
 *
 * The tilt is the point, and it is worth being precise about why it works. The
 * card rotates a few degrees around X and Y based on where the pointer sits
 * within it, with `perspective` on the parent — so the far edge foreshortens
 * and the near edge grows. Without perspective the same rotation is a flat
 * skew, which reads as a glitch rather than as depth.
 *
 * Ten degrees is the ceiling. Beyond roughly twelve the foreshortening starts
 * to make the text genuinely harder to read, and a card that fights legibility
 * to show off is a bad trade on a page whose job is to introduce players.
 *
 * The rotation runs through springs rather than straight from the pointer.
 * Raw values track exactly and feel brittle — the card snaps to attention and
 * stops dead on exit. A spring gives it mass, and mass is the whole illusion.
 *
 * On the portrait. These are real people and their photographs are not ours to
 * ship, so with no `image` the card renders a generated portrait instead:
 * shirt number at size, in the franchise colour, with the role glyph. That is a
 * legitimate design for a sports card rather than an apology for a missing
 * asset — it is what the back of a shirt looks like. Supply `image` and it is
 * used instead, with no other change.
 */
import { useRef } from "react";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";

import { POINTER_SPRING } from "../../utils/animations";
import { ROLE_TINT, type ShowcasePlayer } from "../../utils/players";

/** Maximum tilt, in degrees. See the note above before raising it. */
const MAX_TILT = 10;

export interface PlayerCardProps {
  player: ShowcasePlayer;
  className?: string;
}

export default function PlayerCard({ player, className = "" }: PlayerCardProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  // -0.5 … 0.5, the pointer's position within the card.
  const px = useMotionValue(0);
  const py = useMotionValue(0);

  const sx = useSpring(px, POINTER_SPRING);
  const sy = useSpring(py, POINTER_SPRING);

  // Y follows the pointer's X, X is inverted — push the top away, pull the
  // bottom forward. Inverting one axis is what makes it feel like tilting a
  // physical object rather than steering one.
  const rotateY = useTransform(sx, [-0.5, 0.5], [-MAX_TILT, MAX_TILT]);
  const rotateX = useTransform(sy, [-0.5, 0.5], [MAX_TILT, -MAX_TILT]);

  // A sheen that travels with the pointer. This, more than the rotation, is
  // what sells the surface as something with a finish.
  const sheenX = useTransform(sx, [-0.5, 0.5], ["0%", "100%"]);
  const sheenY = useTransform(sy, [-0.5, 0.5], ["0%", "100%"]);
  const sheen = useMotionTemplate`radial-gradient(circle at ${sheenX} ${sheenY}, rgba(255,255,255,0.14), transparent 60%)`;

  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    px.set((event.clientX - rect.left) / rect.width - 0.5);
    py.set((event.clientY - rect.top) / rect.height - 0.5);
  };

  const reset = () => {
    px.set(0);
    py.set(0);
  };

  return (
    // Perspective lives on the wrapper, not the card: applied to the rotating
    // element itself it has no effect, which is the usual reason a CSS tilt
    // comes out looking like a skew.
    <div className={`[perspective:1100px] ${className}`}>
      <motion.div
        ref={ref}
        onPointerMove={handleMove}
        onPointerLeave={reset}
        style={reduced ? undefined : { rotateX, rotateY, transformStyle: "preserve-3d" }}
        whileHover={reduced ? undefined : { scale: 1.02 }}
        transition={POINTER_SPRING}
        className="group relative h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-auctiq-card shadow-glass"
      >
        {/* Franchise colour, as a wash rather than a fill — enough to identify
            the team, not enough to fight the type. */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.22]"
          style={{
            background: `radial-gradient(120% 90% at 50% 0%, ${player.accent}, transparent 70%)`,
          }}
        />

        {/* The portrait. */}
        <div className="relative flex h-full w-full flex-col">
          <div className="relative flex flex-1 items-center justify-center overflow-hidden">
            {player.image ? (
              <img
                src={player.image}
                alt={`${player.name} ${player.surname}`}
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
            ) : (
              <GeneratedPortrait player={player} />
            )}
          </div>

          {/* The plate. Solid rather than glass: small type over a translucent
              ground on a busy card is exactly where readability goes. */}
          <div className="relative z-10 border-t border-white/10 bg-auctiq-void/80 px-3.5 py-3 backdrop-blur-md">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-tech text-[10px] uppercase tracking-[0.16em] text-auctiq-dim">
                {player.name}
              </span>
              <span
                className="shrink-0 rounded px-1.5 py-[1px] font-tech text-[8.5px] font-semibold uppercase tracking-[0.1em]"
                style={{ color: ROLE_TINT[player.role], backgroundColor: `${ROLE_TINT[player.role]}1F` }}
              >
                {player.role}
              </span>
            </div>
            <div className="mt-0.5 truncate font-auctiq text-[17px] leading-none tracking-[0.04em] text-auctiq-text">
              {player.surname.toUpperCase()}
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="font-num text-[15px] font-bold leading-none tabular-nums text-auctiq-gold">
                {player.stat}
              </span>
              <span className="font-tech text-[9px] uppercase tracking-[0.12em] text-auctiq-dim">
                {player.statLabel}
              </span>
            </div>
          </div>
        </div>

        {/* Sheen, above everything, ignoring the pointer. */}
        {!reduced && (
          <motion.div
            aria-hidden
            style={{ background: sheen }}
            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          />
        )}
      </motion.div>
    </div>
  );
}

/**
 * The shirt-back portrait, used when no licensed photograph is supplied.
 *
 * The number is set enormous and clipped by the frame on purpose — a number
 * that fits neatly reads as a label, where one that overflows reads as a
 * graphic, which is what the back of a shirt actually looks like.
 */
function GeneratedPortrait({ player }: { player: ShowcasePlayer }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden">
      <span
        aria-hidden
        className="select-none font-auctiq leading-none tracking-tighter"
        style={{
          fontSize: "clamp(5rem, 13vw, 9rem)",
          color: player.accent,
          opacity: 0.5,
          textShadow: `0 0 40px ${player.accent}55`,
        }}
      >
        {player.number}
      </span>
      {/* A faint jersey-collar arc, so the number is not floating in a void. */}
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-1/3 w-full"
      >
        <path
          d="M0 100 V60 Q50 88 100 60 V100 Z"
          fill={player.accent}
          fillOpacity="0.14"
        />
      </svg>
    </div>
  );
}
