/**
 * WarRoomTrigger.tsx
 * The card that opens the war room.
 *
 * **It supersedes `LiveBiddingCard` rather than replacing it.** Same slot in
 * `BroadcastHero`, same `neon-card` shell, same footer-pinned controls, so the
 * hero's three panels still line up. The old file stays on disk and unmounted;
 * putting it back is one import line.
 *
 * **The figures it shows are a still of the demo, not live data.** The card it
 * replaces showed a hardcoded lot too, and that was honest there because it was
 * decoration. Here it is a promise about what the button opens, so the copy
 * says "demo" on the control and the numbers are captioned as a simulation. A
 * card that looks like a live auction and opens a simulation is the kind of
 * small lie that makes the rest of the product harder to trust.
 *
 * The real bid control is `BlockView`'s, inside the overlay. Nothing here
 * places a bid, which matters: `BlockView.tsx`'s own `placeBid` is wired to a
 * live room, and the landing has no business reaching it.
 */


import { Suspense, lazy, useState } from "react";

import GlowingButton from "../UI/GlowingButton";

// The overlay pulls in the whole block view and its animations. Nobody who
// never opens the demo should download it.
const WarRoomOverlay = lazy(() => import("./WarRoomOverlay"));

/** A still from the simulation, captioned as one. */
const SAMPLE = {
  jersey: "18",
  name: "Virat Kohli",
  bid: "20.0",
  rivals: [
    { team: "Leading bid", amount: "20.0", tint: "#37d0ff" },
    { team: "CHE", amount: "18.0", tint: "#f5c451" },
    { team: "RCB", amount: "10.0", tint: "#ef4444" },
    { team: "KKR", amount: "5.0", tint: "#a78bfa" },
  ],
};

export default function WarRoomTrigger() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <article className="neon-card flex flex-col p-4">
        <h2 className="font-stadium text-[17px] font-semibold uppercase tracking-[0.04em] text-auctiq-text">
          War Room Demo
        </h2>
        <div className="neon-rule mt-2" />

        <div className="mt-3.5 flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-lg border border-red-500/40 bg-red-950/40 font-num text-[22px] font-bold tabular-nums text-red-300"
          >
            {SAMPLE.jersey}
          </span>
          <div className="min-w-0">
            <p className="font-tech text-[9.5px] uppercase tracking-[0.2em] text-auctiq-dim">
              Simulated bid
            </p>
            {/* `tabular-nums` so the figure cannot jitter sideways. */}
            <p className="font-num text-[26px] font-bold leading-[1.05] tabular-nums text-neon-cyan">
              {SAMPLE.bid}
              <span className="ml-1 text-[15px] font-semibold uppercase tracking-[0.04em]">
                Crore
              </span>
            </p>
            <p className="truncate font-tech text-[12px] font-semibold uppercase tracking-[0.06em] text-auctiq-text">
              {SAMPLE.name}
            </p>
          </div>
        </div>

        <div className="mt-3 h-px bg-white/10" />

        <ul className="mt-2.5 space-y-[7px]">
          {SAMPLE.rivals.map((row) => (
            <li key={row.team} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: row.tint }}
              />
              <span className="font-tech text-[11.5px] text-auctiq-dim">{row.team}</span>
              <span className="ml-auto font-num text-[12px] font-bold tabular-nums text-neon-cyan">
                {row.amount} Cr
              </span>
            </li>
          ))}
        </ul>

        {/* `mt-auto` pins the controls to the foot, so the hero's three panels
            keep their buttons aligned even when their bodies differ. */}
        <div className="mt-auto flex gap-2 pt-4">
          <GlowingButton tone="solid" onClick={() => setOpen(true)}>
            Enter War Room
          </GlowingButton>
          <GlowingButton tone="outline" onClick={() => setOpen(true)}>
            Watch
          </GlowingButton>
        </div>
      </article>

      {open && (
        <Suspense fallback={null}>
          <WarRoomOverlay open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
