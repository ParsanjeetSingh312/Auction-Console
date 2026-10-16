/**
 * RosterBoard.tsx
 * The drop target: the XI as a team sheet, eleven slots in batting order.
 *
 * WHY BATTING ORDER
 * =================
 *
 * The slots are numbered, and numbering is only honest when the content is a
 * sequence. A team sheet is one: batters, then the keeper, then the
 * all-rounders, then the bowlers, which is how a scorecard reads. So the
 * groups follow ROLE_ORDER and the numbers run 1 to 11 straight down.
 *
 * THE OPEN SLOTS
 * ==============
 *
 * Eleven rows are always shown, so the board's shape never jumps. Empty rows
 * are allotted first to roles still short of their band ("Add a batter"),
 * then to "Any role" at the foot. The board therefore tells the user what the
 * side still needs without a separate checklist.
 *
 * DRAGGING OUT
 * ============
 *
 * A picked player can be dragged back off the board to remove them -- the
 * inverse of the gesture that put them there. Dropped anywhere outside the
 * board, they are removed; dropped on it, they spring back to their slot.
 */
import { useCallback, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { RotateCcw } from "lucide-react";

import {
  ROLE_NAMES,
  ROLE_ORDER,
  TIER_NAMES,
  type AucteamPlayer,
  type RoleCode,
  type TierCode,
} from "../../console/aucteamApi";
import {
  generateReport,
  removePlayer,
  setTeamName,
  useAucteam,
  useRosterPlayers,
} from "../../console/aucteamStore";
import { overBoard, pointOf, registerBoard } from "./dropZone";
import { resetWithFlight } from "./resetFlight";
import ScoutDock from "./ScoutDock";
import TierLabel from "./TierLabel";

const coarsePointer =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

const SINGULAR: Record<RoleCode, string> = {
  BAT: "batter",
  WK: "wicketkeeper",
  AR: "all-rounder",
  BWL: "bowler",
};

const TIERS: TierCode[] = ["MQ", "PR", "EM"];

function keyStat(player: AucteamPlayer): string {
  const find = (key: string) => player.stats.find((s) => s.key === key)?.value ?? null;
  if (player.role === "BWL") {
    const econ = find("economy");
    return econ === null ? `${player.matches ?? 0} m` : `Econ ${econ.toFixed(2)}`;
  }
  const sr = find("bat_sr");
  return sr === null ? `${player.matches ?? 0} m` : `SR ${sr.toFixed(1)}`;
}

function Slot({ player, number }: { player: AucteamPlayer; number: number }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      layout={!reduced}
      className="aq-slot"
      data-tier={player.tier}
      data-player-id={player.id}
      initial={reduced ? false : { scale: 0.86, x: -14 }}
      animate={{ scale: 1, x: 0 }}
      exit={reduced ? undefined : { x: 48, opacity: 0, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      drag={!coarsePointer}
      dragSnapToOrigin
      dragElastic={0.5}
      whileDrag={{ scale: 1.04, zIndex: 20, cursor: "grabbing" }}
      style={{ touchAction: coarsePointer ? "auto" : "none" }}
      onDragEnd={(event) => {
        const point = pointOf(event as PointerEvent);
        if (point && !overBoard(point.x, point.y)) removePlayer(player.id);
      }}
      title="Drag off the board to remove"
    >
      <span className="aq-slot__no">{number}</span>
      <TierLabel tier={player.tier} small />
      {player.jersey_number !== null ? (
        <span className="aq-slot__jersey">{player.jersey_number}</span>
      ) : (
        <span className="aq-slot__jersey aq-slot__jersey--role">{player.role}</span>
      )}
      <span className="aq-slot__name">
        {player.name}
        {player.overseas && <span className="aq-card__os" style={{ marginLeft: 6 }}>OS</span>}
      </span>
      <span className="aq-slot__stat">{keyStat(player)}</span>
      <button
        type="button"
        className="aq-slot__x"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => removePlayer(player.id)}
        aria-label={`Remove ${player.name}`}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </motion.div>
  );
}

function OpenSlot({ number, label }: { number: number; label: string }) {
  return (
    <div className="aq-slot aq-slot--open">
      <span className="aq-slot__no">{number}</span>
      <span>{label}</span>
    </div>
  );
}

export default function RosterBoard() {
  const players = useRosterPlayers();
  const rules = useAucteam((s) => s.rules);
  const teamName = useAucteam((s) => s.teamName);
  const check = useAucteam((s) => s.check);
  const dragId = useAucteam((s) => s.dragId);
  const over = useAucteam((s) => s.dragOverBoard);
  const reportStatus = useAucteam((s) => s.reportStatus);

  const size = rules?.squad_size ?? 11;
  const bands = rules?.role_bands;
  const complete = players.length === size;

  const boardRef = useCallback((el: HTMLElement | null) => registerBoard(el), []);

  // Allot open rows: first to roles below their band, then "any role".
  const layout = useMemo(() => {
    let remaining = size - players.length;
    const groups = ROLE_ORDER.map((role) => {
      const picked = players.filter((p) => p.role === role);
      const [low, high] = bands?.[role] ?? [0, size];
      const needed = Math.max(0, Math.min(low - picked.length, remaining));
      remaining -= needed;
      const state = picked.length > high ? "over" : picked.length < low ? "short" : "ok";
      return { role, picked, needed, low, high, state };
    });
    return { groups, anyRole: remaining };
  }, [players, bands, size]);

  const tiers = useMemo(() => {
    const counts: Record<TierCode, number> = { MQ: 0, PR: 0, EM: 0 };
    for (const p of players) counts[p.tier] += 1;
    return counts;
  }, [players]);

  let number = 0;

  return (
    <aside
      ref={boardRef}
      id="aq-board"
      className="aq-board"
      data-over={over}
      data-dragging={dragId !== null}
      aria-label="Your playing XI"
    >
      <div className="aq-board__head">
        <div className="aq-board__row">
          <input
            className="aq-team-name"
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            placeholder="Name your XI"
            aria-label="Team name"
            maxLength={40}
          />
          <div className="aq-tally" data-complete={complete} aria-live="polite">
            {players.length}
            <small>/{size}</small>
          </div>
        </div>

        <div className="aq-mix" aria-label="Experience against youth">
          <div className="aq-mix__bar">
            {TIERS.map((tier) => (
              <motion.span
                key={tier}
                data-tier={tier}
                animate={{ width: `${(tiers[tier] / size) * 100}%` }}
                transition={{ type: "spring", stiffness: 200, damping: 26 }}
                style={{ width: `${(tiers[tier] / size) * 100}%` }}
              />
            ))}
          </div>
          <div className="aq-mix__legend">
            {TIERS.map((tier) => (
              <span key={tier}>
                {TIER_NAMES[tier]} {tiers[tier]}
              </span>
            ))}
            <span>{check ? `${check.metrics.overseas}/${rules?.max_overseas ?? 4} overseas` : ""}</span>
          </div>
        </div>
      </div>

      <div className="aq-board__body">
        {dragId !== null && players.length < size && (
          <p className="aq-role__head" style={{ color: over ? "var(--aq-turf)" : "var(--aq-dim)", fontWeight: 500 }}>
            {over ? "Release to add" : "Drop the card here"}
          </p>
        )}
        {layout.groups.map(({ role, picked, needed, low, high, state }) => (
          <section className="aq-role" key={role} aria-label={ROLE_NAMES[role]}>
            <div className="aq-role__head">
              <span>{ROLE_NAMES[role]}</span>
              <span className="aq-role__band" data-state={state}>
                {picked.length} of {low === high ? low : `${low}–${high}`}
              </span>
            </div>
            <div className="aq-slots">
              <AnimatePresence initial={false}>
                {picked.map((player) => (
                  <Slot key={player.id} player={player} number={++number} />
                ))}
              </AnimatePresence>
              {Array.from({ length: needed }, (_, i) => (
                <OpenSlot key={`need-${i}`} number={++number} label={`Add a ${SINGULAR[role]}`} />
              ))}
            </div>
          </section>
        ))}
        {layout.anyRole > 0 && (
          <section className="aq-role" aria-label="Open slots">
            <div className="aq-role__head">
              <span>Open</span>
              <span className="aq-role__band">{layout.anyRole} left</span>
            </div>
            <div className="aq-slots">
              {Array.from({ length: layout.anyRole }, (_, i) => (
                <OpenSlot key={`any-${i}`} number={++number} label="Any role" />
              ))}
            </div>
          </section>
        )}

        {check && check.issues.length > 0 && (
          <ul className="aq-issues" aria-live="polite">
            {check.issues.map((issue) => (
              <li key={issue.code} data-severity={issue.severity}>{issue.message}</li>
            ))}
          </ul>
        )}
      </div>

      <ScoutDock />

      <div className="aq-board__foot">
        <button
          type="button"
          className="aq-btn"
          onClick={() => void resetWithFlight()}
          disabled={players.length === 0}
          title="Send every pick back to the pool"
        >
          <RotateCcw aria-hidden className="h-4 w-4" />
          Reset
        </button>
        <button
          type="button"
          className="aq-btn aq-btn--go"
          disabled={!complete || (check !== null && !check.legal) || reportStatus === "loading"}
          onClick={() => {
            if (reportStatus === "ready") {
              document.getElementById("aq-report")?.scrollIntoView({ behavior: "smooth", block: "start" });
            } else {
              void generateReport(reportStatus === "error");
            }
          }}
        >
          {!complete
            ? `Pick ${size - players.length} more`
            : reportStatus === "loading"
              ? "SCOUT is writing…"
              : reportStatus === "ready"
                ? "Read the report"
                : reportStatus === "error"
                  ? "Try the report again"
                  : "Get the SCOUT report"}
        </button>
      </div>
    </aside>
  );
}
