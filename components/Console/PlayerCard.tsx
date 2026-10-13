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
} from "../../console/format";
import { drawerVariants, scrimVariants } from "../../console/motion";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer, Rules } from "../../console/types";
import PlayerHero from "./PlayerHero";

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
        {/*
          The presentation, above the record.

          The `kv` grid below is the operator's reference — seventeen attributes
          in a fixed order, made for scanning. This is the same player as the
          room sees them: number, name, price, form. Both belong here, in that
          order, because the question "who is this" precedes "what are his
          numbers against spin".
        */}
        <div className="mb-4 rounded-xl bg-[#050a14] p-4">
          <PlayerHero
            player={player}
            soldTo={team}
            soldFor={record.price}
          />
        </div>

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

        {/*
          The second career-record block used to sit here.

          It restated, in a smaller type style, figures the hero panel at
          the top of this card already shows - the same card saying the
          same thing twice, a scroll apart. The two it carried that the
          hero did not (the spin/pace boundary split for a batter, the
          left/right-hander economy split for a bowler) were folded into
          `PlayerHero.statsFor` before this was removed, so no figure was
          lost with it.

          `statLines` in console/format.ts is deliberately left in place:
          ScoutView still renders it for a retrieved player, where a
          compact list is the right shape and there is no hero panel
          above it.
        */}

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
  warning,
}: {
  rules: Rules;
  onSave: (next: Rules) => void;
  onClose: () => void;
  onReset: () => void;
  /**
   * Shown above the buttons when saving here cannot work.
   *
   * At present that means one thing: the room is served by a backend build
   * that predates the `set_rules` message, so the figures below would be sent
   * and refused. Saying so in the dialog is the whole point — the failure is
   * otherwise indistinguishable from the panel simply not doing anything.
   */
  warning?: string | null;
}) {
  // The live room carries two more setup fields than the offline console.
  // Their presence on `rules` is what makes them appear here.
  const live = rules.maxPlayers !== undefined || rules.minOverseas !== undefined;
  const [draft, setDraft] = useState({
    // Entered in crore, the unit the auction is spoken in; sent as lakh.
    purse: String(rules.purse / 100),
    maxSquad: String(rules.maxSquad),
    minSquad: String(rules.minSquad),
    maxOverseas: String(rules.maxOverseas),
    maxPlayers: String(rules.maxPlayers ?? ""),
    minOverseas: String(rules.minOverseas ?? ""),
  });
  const [error, setError] = useState<string | null>(null);

  function save() {
    const next: Rules = {
      purse: Math.round(Number(draft.purse) * 100),
      maxSquad: Number(draft.maxSquad),
      minSquad: Number(draft.minSquad),
      maxOverseas: Number(draft.maxOverseas),
      ...(live
        ? { maxPlayers: Number(draft.maxPlayers), minOverseas: Number(draft.minOverseas) }
        : {}),
    };

    // The same checks the room runs, in the same order, so the host hears the
    // first broken rule here instead of after a round trip. The room
    // re-checks regardless, including against squads that already exist.
    const counts = [next.maxSquad, next.minSquad, next.maxOverseas];
    if (!Number.isFinite(next.purse) || next.purse <= 0) {
      setError("Total Budget needs a positive number of crore.");
      return;
    }
    if (counts.some((value) => !Number.isInteger(value) || value < 0) || next.maxSquad < 1) {
      setError("Squad fields need whole numbers.");
      return;
    }
    if (next.minSquad > next.maxSquad) {
      setError("Minimum Players cannot exceed the Total Squad.");
      return;
    }
    if (next.maxOverseas > next.maxSquad) {
      setError("Maximum overseas cannot exceed the Total Squad.");
      return;
    }
    if (live) {
      const { maxPlayers = 0, minOverseas = 0 } = next;
      if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
        setError("Maximum Players needs a whole number of at least 1.");
        return;
      }
      if (!Number.isInteger(minOverseas) || minOverseas < 0) {
        setError("Minimum overseas needs a whole number.");
        return;
      }
      if (minOverseas > next.maxOverseas) {
        setError("Minimum overseas cannot exceed the maximum.");
        return;
      }
      if (minOverseas + 1 > next.maxSquad) {
        setError("The squad must have room for the overseas minimum and one uncapped player.");
        return;
      }
    }

    onSave(next);
    onClose();
  }

  const field = (key: keyof typeof draft, label: string, hint?: string, step = "1") => (
    <div className="fieldrow">
      <label htmlFor={`setup-${key}`}>
        {label}
        {hint && <div className="eyebrow">{hint}</div>}
      </label>
      <input
        id={`setup-${key}`}
        type="number"
        min={0}
        step={step}
        value={draft[key]}
        onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
      />
    </div>
  );

  return (
    <Modal onClose={onClose} labelledBy="setup-title">
      <header>
        <h2 id="setup-title">
          Auction setup<span>Applies to every franchise in the room</span>
        </h2>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="mbody">
        {field("purse", "Total Budget", "₹ crore per franchise", "0.25")}
        {field("maxSquad", "Total Squad", "most players a team can have")}
        {field("minSquad", "Minimum Players", "reserved when computing max bid")}
        {live && field("maxPlayers", "Maximum Players", "players to go under the hammer")}
        {field("maxOverseas", "Maximum overseas")}
        {live && field("minOverseas", "Minimum overseas", "highlighted in the briefing")}

        {live && (
          <p className="mt-2 rounded-md border border-rule px-2.5 py-2 text-mini leading-relaxed text-muted">
            Fixed for every room: 10 franchises · 7-second bid timer · ₹0.25 Cr increments ·
            jump bids of +5 / +10 / +15 Cr or more · 30-second decision buffer, 3 per
            franchise · at least 1 uncapped player. Saving sends every franchise back to the
            briefing to acknowledge the new rules.
          </p>
        )}

        {error && <p className="mt-1 text-mini text-unsold">{error}</p>}

        {warning && (
          <p
            role="alert"
            className="mt-2 rounded-md border border-unsold/50 bg-unsold/10 px-2.5 py-2 text-mini leading-relaxed text-unsold"
          >
            {warning}
          </p>
        )}

        <p className="mt-3 border-t border-rule pt-2.5 text-mini text-muted">
          These are auction-day settings, not player data. In a live room they go to
          the room itself, so every franchise sees the same limits at once — and the
          room refuses a change that would make a squad it already holds illegal.
          On the offline console they live in this browser.
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
