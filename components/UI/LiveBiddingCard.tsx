/**
 * LiveBiddingCard.tsx
 * The cyan panel: what is on the block, and what it has been bid to.
 *
 * Laid out from the reference: a portrait chip beside the standing bid, a rule,
 * the last four bids newest-first, then the two controls.
 *
 * **On the numbers.** They are static. The brief scopes this phase to
 * presentation with no logic changes, so nothing here reads the socket — but
 * the shape is the shape the live feed already produces, so wiring it later is
 * a matter of replacing this constant with the room state rather than
 * rebuilding the component.
 *
 * **On the names.** The reference fills its rows with "Recent username" and a
 * player called "THE BLASTER", which are artefacts of a generated mockup rather
 * than content. The bidders here are franchises, because a franchise is who
 * actually bids in this product, and the subject is a real player out of
 * `SHOWCASE_PLAYERS` — the same six the showcase below uses, so the page does
 * not introduce a second, parallel cast.
 *
 * **On the portrait.** `PlayerCard` already solves this: photographs and
 * likenesses are not ours to ship, so the chip is a jersey number on the
 * player's franchise colour. That is a legitimate design — it is what the back
 * of a shirt looks like — and it means this ships complete rather than with a
 * grey box waiting on an asset drop.
 */
import GlowingButton from "./GlowingButton";
import { SHOWCASE_PLAYERS } from "../../utils/players";

/** Whoever is on the block. First of the showcase six. */
const SUBJECT = SHOWCASE_PLAYERS[0];

const CURRENT_BID = "20.0";

/** Newest first, which is the order the eye wants when a figure is climbing. */
const RECENT_BIDS = [
  { team: "MUM", amount: "20.0", tint: "#4D8DF6" },
  { team: "CHE", amount: "18.0", tint: "#F6C45A" },
  { team: "RCB", amount: "10.0", tint: "#F87171" },
  { team: "KKR", amount: "5.0", tint: "#C4A6F5" },
];

export default function LiveBiddingCard() {
  return (
    <article className="neon-card flex flex-col p-4">
      <h2 className="font-stadium text-[17px] font-semibold uppercase tracking-[0.04em] text-auctiq-text">
        Live Bidding Tracker
      </h2>
      <div className="neon-rule mt-2" />

      <div className="mt-3.5 flex items-center gap-3">
        <JerseyChip />
        <div className="min-w-0">
          <p className="font-tech text-[9.5px] uppercase tracking-[0.2em] text-auctiq-dim">
            Current bid
          </p>
          {/*
            `tabular-nums` so the figure does not jitter sideways when a digit
            changes — which it will, constantly, once this is live.
          */}
          <p className="font-num text-[26px] font-bold leading-[1.05] tabular-nums text-neon-cyan">
            {CURRENT_BID}
            <span className="ml-1 text-[15px] font-semibold uppercase tracking-[0.04em]">
              Crore
            </span>
          </p>
          <p className="truncate font-tech text-[12px] font-semibold uppercase tracking-[0.06em] text-auctiq-text">
            {SUBJECT.name} {SUBJECT.surname}
          </p>
        </div>
      </div>

      <div className="mt-3 h-px bg-white/10" />

      <ul className="mt-2.5 space-y-[7px]">
        {RECENT_BIDS.map((bid, i) => (
          <li key={bid.team} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: bid.tint }}
            />
            <span className="font-tech text-[11.5px] text-auctiq-dim">
              {/* The newest row says what it is; the rest are just bidders. */}
              {i === 0 ? "Leading bid" : bid.team}
            </span>
            <span className="ml-auto font-num text-[12px] font-bold tabular-nums text-neon-cyan">
              {bid.amount} Cr
            </span>
          </li>
        ))}
      </ul>

      {/* `mt-auto` pins the controls to the foot, so the three panels' buttons
          line up with each other even when their bodies differ in height. */}
      <div className="mt-auto flex gap-2 pt-4">
        <GlowingButton tone="solid">Place Bid</GlowingButton>
        <GlowingButton tone="outline">Auto-Bid</GlowingButton>
      </div>
    </article>
  );
}

/**
 * The subject's shirt, at chip size.
 *
 * A squared tile rather than a circle: a circle reads as an avatar and invites
 * the question of whose face is missing, where a tile reads as a number plate.
 */
function JerseyChip() {
  return (
    <div
      className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[6px] border border-white/10"
      style={{
        background: `linear-gradient(160deg, ${SUBJECT.accent}38, ${SUBJECT.accent}12)`,
      }}
      aria-hidden
    >
      <span
        className="font-num text-[24px] font-bold leading-none tabular-nums"
        style={{ color: SUBJECT.accent }}
      >
        {SUBJECT.number}
      </span>
    </div>
  );
}
