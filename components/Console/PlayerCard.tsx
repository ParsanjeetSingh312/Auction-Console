/**
 * PlayerCard.tsx
 * The full record for one player, and the auction-setup dialog.
 *
 * The player card is where the seventeen attributes are shown in full. The
 * prototype had a placeholder here reading "stats not loaded yet" — that is now
 * live data from GET /api/v1/players, and the empty state it replaces no longer
 * exists.
 *
 * Both dialogs close on Escape and on a click outside the panel, and neither
 * traps focus: they are short, self-contained, and dismissible, so a focus trap
 * would cost more in complexity than it returns.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import {
  cssVars,
  money,
  ratingLabel,
  setMeta,
  statLines,
} from "../../console/format";
import { drawerVariants, scrimVariants } from "../../console/motion";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer, Rules } from "../../console/types";

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

function Modal({
  children,
  onClose,
  labelledBy,
}: {
  children: React.ReactNode;
  onClose: () => void;
  labelledBy: string;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /*
    The scrim fades and the card rises. Two separate elements because they want
    different things: a dimmer that slides is distracting, and a card that only
    fades has no direction to have come from.

    The exit is shorter than the entrance — see `drawerVariants`. Dismissing has
    to feel immediate or the card reads as reluctant to close.
  */
  return (
    <motion.div
      className="scrim"
      variants={scrimVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        variants={drawerVariants}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ *
 * Player card
 * ------------------------------------------------------------------ */

export function PlayerCard({
  player,
  engine,
  onClose,
  onNotice,
  onAskScout,
}: {
  player: ConsolePlayer;
  engine: AuctionEngine;
  onClose: () => void;
  onNotice: (message: string, kind?: "err") => void;
  onAskScout: (question: string, player: ConsolePlayer) => void;
}) {
  const meta = setMeta(player.set);
  const record = engine.recordFor(player.id);
  const team = engine.teamById(record.teamId);

  return (
    <Modal onClose={onClose} labelledBy="player-card-title">
      <header style={cssVars({ "--band": meta.rail })}>
        <h2 id="player-card-title">
          {player.surname}
          {player.first && <span>{player.first}</span>}
        </h2>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="mbody">
        <div className="kv">
          <div>
            <div className="eyebrow">Band</div>
            <b>{player.set}</b>
            <div className="eyebrow">
              {meta.label}
              {player.setDerived && " · derived"}
            </div>
          </div>
          <div>
            <div className="eyebrow">Role</div>
            <b>{player.role}</b>
          </div>
          <div>
            <div className="eyebrow">Country</div>
            <b>
              {player.country ?? (player.overseas ? "Overseas" : "—")}
              {player.overseas && " ✈"}
            </b>
          </div>
          <div>
            <div className="eyebrow">Status</div>
            <b>{player.cap === "CAPPED" ? "Capped" : "Uncapped"}</b>
          </div>
          <div>
            <div className="eyebrow">Base price</div>
            <b>{money(player.base)}</b>
            {player.baseAssumed && <div className="eyebrow">assumed floor</div>}
          </div>
          <div>
            <div className="eyebrow">Rating</div>
            <b>{ratingLabel(player.rating)}</b>
          </div>
          <div>
            <div className="eyebrow">Pool no.</div>
            <b>{player.sno}</b>
          </div>
          <div>
            <div className="eyebrow">{record.status === "sold" ? "Sold for" : "Auction"}</div>
            <b>
              {record.status === "sold"
                ? money(record.price)
                : record.status === "unsold"
                  ? "Unsold"
                  : "In the pool"}
            </b>
            {team && <div className="eyebrow">{team.name}</div>}
          </div>
        </div>

        <div className="mt-3.5 border-t border-rule pt-3">
          <div className="eyebrow mb-2">
            Career record · {player.roleShort === "BOWL" ? "bowling" : "batting"}
          </div>
          <div className="kv">
            {statLines(player).map((line) => (
              <div key={line.label}>
                <div className="eyebrow">{line.label}</div>
                <b>{line.value}</b>
              </div>
            ))}
          </div>
          <p className="mt-2 text-mini text-muted">
            Served by the RAG backend from the same table the vector index was built on. A dash
            means the dataset holds no figure for that column — this dataset records batting stats
            only for batters, keepers and all-rounders, and bowling stats only for bowlers.
          </p>
        </div>
      </div>

      <footer>
        {record.status === "sold" && (
          <button
            type="button"
            className="pbtn danger"
            onClick={() => {
              const result = engine.returnToPool(player.id);
              if (result.message) onNotice(result.message);
              onClose();
            }}
          >
            Release to pool
          </button>
        )}
        <button
          type="button"
          className="pbtn"
          onClick={() => {
            onAskScout(`How does ${player.name} compare with similar players in the pool?`, player);
            onClose();
          }}
        >
          Ask Scout
        </button>
        <button type="button" className="pbtn" onClick={onClose}>
          Close
        </button>
        {record.status !== "sold" && (
          <button
            type="button"
            className="pbtn primary"
            onClick={() => {
              const result = engine.putOnBlock(player.id);
              if (result.message) onNotice(result.message, result.ok ? undefined : "err");
              onClose();
            }}
          >
            Put on the block
          </button>
        )}
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Auction setup
 * ------------------------------------------------------------------ */

/**
 * Purse and squad limits.
 *
 * These are the rules the whole legality check hangs off, so the form validates
 * before committing rather than letting a blank field write NaN into the engine
 * and silently disable every bid button on the page.
 */
export function SetupDialog({
  rules,
  onSave,
  onClose,
  onReset,
}: {
  rules: Rules;
  onSave: (next: Rules) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState({
    purse: String(rules.purse),
    maxSquad: String(rules.maxSquad),
    minSquad: String(rules.minSquad),
    maxOverseas: String(rules.maxOverseas),
  });
  const [error, setError] = useState<string | null>(null);

  function save() {
    const next: Rules = {
      purse: Number(draft.purse),
      maxSquad: Number(draft.maxSquad),
      minSquad: Number(draft.minSquad),
      maxOverseas: Number(draft.maxOverseas),
    };

    if (Object.values(next).some((value) => !Number.isFinite(value) || value <= 0)) {
      setError("Every field needs a positive number.");
      return;
    }
    if (next.minSquad > next.maxSquad) {
      setError("The minimum squad cannot exceed the maximum.");
      return;
    }
    if (next.maxOverseas > next.maxSquad) {
      setError("Overseas places cannot exceed the squad size.");
      return;
    }

    onSave(next);
    onClose();
  }

  const field = (key: keyof typeof draft, label: string, hint?: string) => (
    <div className="fieldrow">
      <label htmlFor={`setup-${key}`}>
        {label}
        {hint && <div className="eyebrow">{hint}</div>}
      </label>
      <input
        id={`setup-${key}`}
        type="number"
        min={1}
        value={draft[key]}
        onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
      />
    </div>
  );

  return (
    <Modal onClose={onClose} labelledBy="setup-title">
      <header>
        <h2 id="setup-title">
          Auction setup<span>Purse and squad limits</span>
        </h2>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="mbody">
        {field("purse", "Purse per team", "₹ lakh")}
        {field("maxSquad", "Maximum squad")}
        {field("minSquad", "Minimum squad", "reserved when computing max bid")}
        {field("maxOverseas", "Overseas places")}

        {error && <p className="mt-1 text-mini text-unsold">{error}</p>}

        <p className="mt-3 border-t border-rule pt-2.5 text-mini text-muted">
          These are auction-day settings, not player data — neither backend stores them, so they
          live in this browser alongside the auction itself.
        </p>
      </div>

      <footer>
        <button
          type="button"
          className="pbtn danger"
          onClick={() => {
            onReset();
            onClose();
          }}
        >
          Reset the auction
        </button>
        <button type="button" className="pbtn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="pbtn primary" onClick={save}>
          Save
        </button>
      </footer>
    </Modal>
  );
}
