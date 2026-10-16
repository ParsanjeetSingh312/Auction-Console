/**
 * AucteamCard.tsx
 * One player, broadcast-style: the tier tag over a big jersey number, three
 * figures either side, the name underneath.
 *
 * MOTION, AND WHO OWNS WHAT
 * =========================
 *
 *   Framer Motion   the drag (with a spring back to origin), the hover lift,
 *                   the pointer-following tilt, the refusal shake
 *   GSAP            the figures counting up (StatCounter)
 *
 * The shake lives on a wrapper rather than the card, because the card's `x`
 * belongs to the drag while one is in flight -- animating the same motion
 * value from two owners is how a card ends up stranded mid-screen.
 *
 * Nothing starts invisible. Entrance is the counters, not a fade: a grid that
 * waited on requestAnimationFrame to appear would be a blank grid in every
 * context where it is not ticking.
 *
 * INPUT
 * =====
 *
 * Drag onto the board, or press the + button, or focus the card and press
 * Enter. On a touch screen dragging is off: a grid of draggable cards cannot
 * be scrolled with a finger, and scrolling the pool matters more.
 */
import { memo, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { motion, useAnimationControls, useMotionValue, useReducedMotion, useSpring } from "framer-motion";

import type { AucteamPlayer } from "../../console/aucteamApi";
import {
  addPlayer,
  dismissRefusal,
  setDrag,
  setDragOverBoard,
  togglePlayer,
  useAucteam,
} from "../../console/aucteamStore";
import { overBoard, pointOf } from "./dropZone";
import StatCounter from "./StatCounter";
import TierLabel from "./TierLabel";

const coarsePointer =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

const TILT = 9;

interface AucteamCardProps {
  player: AucteamPlayer;
  picked: boolean;
  /** Position in the grid, for a slight stagger in the counters. */
  index?: number;
}

function AucteamCard({ player, picked, index = 0 }: AucteamCardProps) {
  const reduced = useReducedMotion();
  const refusal = useAucteam((s) => (s.refusal?.playerId === player.id ? s.refusal : null));
  const [dragging, setDragging] = useState(false);

  // Pointer-following tilt, sprung so it settles rather than snaps.
  const tiltX = useMotionValue(0);
  const tiltY = useMotionValue(0);
  const rotateX = useSpring(tiltX, { stiffness: 220, damping: 18 });
  const rotateY = useSpring(tiltY, { stiffness: 220, damping: 18 });

  const shake = useAnimationControls();
  useEffect(() => {
    if (!refusal) return;
    if (!reduced) void shake.start({ x: [0, -10, 10, -7, 7, -3, 0], transition: { duration: 0.42 } });
    const timer = window.setTimeout(dismissRefusal, 2600);
    return () => window.clearTimeout(timer);
  }, [refusal, reduced, shake]);

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (reduced || dragging || coarsePointer) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    tiltY.set(px * TILT * 2);
    tiltX.set(-py * TILT * 2);
  };
  const resetTilt = () => {
    tiltX.set(0);
    tiltY.set(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePlayer(player.id);
    }
  };

  const [left, right] = useMemo(() => [player.stats.slice(0, 3), player.stats.slice(3, 6)], [player.stats]);
  const draggable = !picked && !coarsePointer;

  return (
    <motion.div className="aq-card-wrap" data-card-id={player.id} data-dragging={dragging} animate={shake}>
      <motion.article
        className="aq-card"
        data-tier={player.tier}
        data-picked={picked}
        tabIndex={0}
        role="button"
        aria-pressed={picked}
        aria-label={`${player.name}, ${player.role_label}, ${player.tier_reason}. ${picked ? "In your XI. Press Enter to remove." : "Press Enter to add to your XI."}`}
        style={{ rotateX, rotateY, touchAction: draggable ? "none" : "auto" }}
        whileHover={reduced || dragging ? undefined : { y: -6 }}
        drag={draggable}
        dragSnapToOrigin
        dragElastic={0.6}
        dragTransition={{ bounceStiffness: 520, bounceDamping: 30 }}
        whileDrag={{
          scale: 1.07,
          rotate: -2.5,
          zIndex: 60,
          boxShadow: "0 30px 70px rgba(0,0,0,0.6), 0 0 0 1px var(--tier)",
          cursor: "grabbing",
        }}
        onDragStart={() => {
          setDragging(true);
          resetTilt();
          setDrag(player.id);
        }}
        onDrag={(event) => {
          const point = pointOf(event as PointerEvent);
          if (point) setDragOverBoard(overBoard(point.x, point.y));
        }}
        onDragEnd={(event) => {
          setDragging(false);
          const point = pointOf(event as PointerEvent);
          setDrag(null);
          if (point && overBoard(point.x, point.y)) addPlayer(player.id);
        }}
        onPointerMove={onPointerMove}
        onPointerLeave={resetTilt}
        onKeyDown={onKeyDown}
      >
        <span className="aq-card__sheen" aria-hidden />
        <span className="aq-card__pick" aria-hidden>In your XI</span>

        <div className="aq-card__top">
          <span className="aq-card__flag">
            {player.country}
            {player.overseas && <span className="aq-card__os" title="Overseas player">OS</span>}
          </span>
          <span>{player.capped ? "Capped" : "Uncapped"}</span>
        </div>

        <div className="aq-card__core">
          <dl className="aq-card__stats">
            {left.map((stat, i) => (
              <div key={stat.key}>
                <dt>{stat.label}</dt>
                <StatCounter value={stat.value} format={stat.format} delay={(index % 8) * 0.04 + i * 0.06} />
              </div>
            ))}
          </dl>

          <div className="aq-card__center">
            <TierLabel tier={player.tier} reason={player.tier_reason} />
            {player.jersey_number !== null ? (
              <div className="aq-jersey" aria-label={`Shirt number ${player.jersey_number}`}>
                {player.jersey_number}
              </div>
            ) : (
              <div className="aq-jersey aq-jersey--role" title="Shirt number not verified" aria-label={player.role_label}>
                {player.role}
              </div>
            )}
          </div>

          <dl className="aq-card__stats aq-card__stats--right">
            {right.map((stat, i) => (
              <div key={stat.key}>
                <dt>{stat.label}</dt>
                <StatCounter value={stat.value} format={stat.format} delay={(index % 8) * 0.04 + 0.18 + i * 0.06} />
              </div>
            ))}
          </dl>
        </div>

        <h3 className="aq-card__name" title={player.name}>{player.name}</h3>
        <div className="aq-card__meta">
          <span>{player.role_label}</span>
          <span title={player.tier_source === "curated" ? player.tier_reason : `Tier from ${player.tier_reason}`}>
            {player.matches ? `${player.matches} IPL` : "IPL debut"}
          </span>
        </div>

        <button
          type="button"
          className="aq-card__add"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            togglePlayer(player.id);
          }}
          aria-label={picked ? `Remove ${player.name} from your XI` : `Add ${player.name} to your XI`}
          tabIndex={-1}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            {picked ? (
              <path d="M3 7h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            ) : (
              <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            )}
          </svg>
        </button>

        {refusal && (
          <motion.div
            className="aq-card__toast"
            role="alert"
            initial={{ y: 6 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.18 }}
          >
            {refusal.message}
          </motion.div>
        )}
      </motion.article>
    </motion.div>
  );
}

export default memo(AucteamCard);
