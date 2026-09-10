/**
 * BlockPanel.tsx
 * The player currently up for bidding: who they are, the standing ask, the
 * increment ladder, one button per team, and the gavel.
 *
 * Legality is decided by the engine, not here. Each team button asks
 * `blockedReason` what would stop that team going to the next ask and, if
 * something would, disables itself and puts the reason in its tooltip — so the
 * room can see *why* a team is out before anyone calls a bid that has to be
 * walked back.
 */
import { useState } from "react";

import {
  cssVars,
  incrementFor,
  money,
  moneyTight,
  ratingLabel,
  setMeta,
} from "../../console/format";
import type { AuctionEngine } from "../../console/useAuctionEngine";
import type { ConsolePlayer } from "../../console/types";

/** The auctioneer's quick raises, in ₹ lakh. */
const LADDER = [5, 10, 25, 50, 100];

export default function BlockPanel({
  engine,
  onNotice,
  onAskScout,
}: {
  engine: AuctionEngine;
  onNotice: (message: string, kind?: "err") => void;
  /** Hand the on-block player to the Scout tab with a starter question. */
  onAskScout: (question: string) => void;
}) {
  const { block, activePlayer } = engine;

  if (!block || !activePlayer) {
    return (
      <div className="block">
        <div className="bhead">
          <span className="eyebrow">On the block</span>
        </div>
        <div className="blockempty">
          <b>No one up</b>
          {engine.counts.available > 0
            ? "Search a player and press Enter, or hit Put up in the pool."
            : "Every player has been through the auction."}
        </div>
      </div>
    );
  }

  return (
    <div className="block">
      <div className="bhead">
        <span className="eyebrow">On the block</span>
        <span className="eyebrow">next bid {money(engine.nextAsk)}</span>
      </div>
      <BlockCard
        engine={engine}
        player={activePlayer}
        onNotice={onNotice}
        onAskScout={onAskScout}
      />
    </div>
  );
}

function BlockCard({
  engine,
  player,
  onNotice,
  onAskScout,
}: {
  engine: AuctionEngine;
  player: ConsolePlayer;
  onNotice: (message: string, kind?: "err") => void;
  onAskScout: (question: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const block = engine.block!;
  const meta = setMeta(player.set);
  const bidder = engine.teamById(block.bidderId);

  /** Run an intent and surface its refusal, if any. */
  function attempt(run: () => { ok: boolean; message?: string }) {
    const result = run();
    if (result.message) onNotice(result.message, result.ok ? undefined : "err");
  }

  function applyCustomRaise() {
    const delta = Number(custom);
    if (!Number.isFinite(delta) || delta <= 0) {
      onNotice("Enter a raise in ₹ lakh.", "err");
      return;
    }
    attempt(() => engine.raiseAsk(delta));
    setCustom("");
  }

  return (
    <div className="blockcard" style={cssVars({ "--band": meta.rail })}>
      <div className="pname">
        {player.surname}
        {player.first && <span>{player.first}</span>}
      </div>

      <div className="pmeta">
        <span className="setpill" style={cssVars({ "--band": meta.band })}>
          {player.set} · {meta.label}
        </span>
        <span className="tag tag-neutral">{player.role}</span>
        <span className="tag tag-neutral">
          {player.country ?? (player.overseas ? "Overseas" : "—")}
          {player.overseas && " ✈"}
        </span>
        <span className="tag tag-neutral">
          {player.cap === "CAPPED" ? "Capped" : "Uncapped"}
        </span>
        {player.rating != null && (
          <span className="tag tag-neutral">Rating {ratingLabel(player.rating)}</span>
        )}
      </div>

      <div className="bidbox">
        <div>
          <div className="eyebrow">{bidder ? "Current bid" : "Opening ask"}</div>
          <div className="amt num">{money(block.bid).replace("₹", "")}</div>
        </div>
        <div className="who">
          {bidder ? (
            <>
              <div className="eyebrow">With</div>
              <b style={{ color: bidder.color }}>{bidder.name}</b>
            </>
          ) : (
            <>
              <div className="eyebrow">Base price</div>
              <b>{money(player.base)}</b>
            </>
          )}
        </div>
      </div>

      <div className="ladder">
        <span className="eyebrow">Raise</span>
        {LADDER.map((delta) => (
          <button key={delta} type="button" onClick={() => attempt(() => engine.raiseAsk(delta))}>
            +{delta}
          </button>
        ))}
        <input
          type="number"
          min={1}
          step={5}
          value={custom}
          placeholder="₹L"
          aria-label="Custom raise in lakh"
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyCustomRaise();
            }
          }}
        />
        <button type="button" onClick={applyCustomRaise}>
          Add
        </button>
      </div>

      <div className="teamgrid">
        {engine.teams.map((team) => {
          const summary = engine.summaryFor(team.id);
          const blocked = engine.blockedReason(team.id, player, engine.nextAsk);
          const holding = block.bidderId === team.id;

          return (
            <button
              key={team.id}
              type="button"
              className="bidbtn"
              style={cssVars({ "--tc": team.color })}
              disabled={blocked !== null}
              aria-pressed={holding}
              title={blocked ?? `Bid ${money(engine.nextAsk)}`}
              onClick={() => attempt(() => engine.bidFor(team.id))}
            >
              <span className="tdot" />
              <span className="tn">{team.name}</span>
              <span className="tp">{summary ? moneyTight(summary.left) : "—"}</span>
            </button>
          );
        })}
      </div>

      <div className="acts">
        <button
          type="button"
          className="big sell"
          disabled={!bidder}
          onClick={() => attempt(() => engine.sell())}
        >
          Sold
        </button>
        <button type="button" className="big pass" onClick={() => attempt(() => engine.pass())}>
          Unsold
        </button>
      </div>

      {!bidder && (
        <div className="warnline">
          Pick a team to take the bid before you can mark this sold.
        </div>
      )}

      {/*
        The bridge to the RAG side. The Scout tab already knows which player is
        on the block; these are just the two questions worth asking about a
        player mid-lot, pre-written so the auctioneer does not have to type.
      */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-dashed border-rule pt-2.5">
        <span className="eyebrow">Ask Scout</span>
        <button
          type="button"
          className="mini"
          onClick={() =>
            onAskScout(`Is this player worth more than a base price of ${money(player.base)}?`)
          }
        >
          Worth the base?
        </button>
        <button
          type="button"
          className="mini"
          onClick={() =>
            onAskScout(
              `Which other ${player.role.toLowerCase()}s in the pool are comparable, and cheaper?`,
            )
          }
        >
          Comparable, cheaper
        </button>
      </div>

      {incrementFor(block.bid) > 0 && (
        <div className="mt-1.5 text-right">
          <span className="eyebrow">ladder step {money(incrementFor(block.bid))}</span>
        </div>
      )}
    </div>
  );
}
