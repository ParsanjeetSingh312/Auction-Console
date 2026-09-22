/**
 * WaitingRoom.tsx
 * The ten minutes before the hammer.
 *
 * Its real job is not the timer. It is to answer, for everyone at once, "are we
 * ready?" — which franchises are actually at their desks, which are still an
 * empty chair, and how long is left before it stops mattering. An auctioneer
 * about to open a ₹120 crore auction needs that at a glance, and a franchise
 * needs to see that it has been counted.
 *
 * So the grid is the content and the clock is the frame. Connected franchises
 * are solid and coloured; absent ones are outlines. The count is stated
 * plainly rather than left to be inferred from ten chips.
 *
 * The countdown is advisory. It is the auctioneer who starts the auction, and
 * they can do it at any point — the timer running out does not start anything
 * by itself. That is deliberate: a room that starts itself while three
 * franchises are still connecting is worse than one that waits to be told.
 */
import { motion, useReducedMotion } from "framer-motion";

import { EASE, pressable } from "../../console/motion";
import type { AuctionSocket } from "../../hooks/useAuctionSocket";

export interface WaitingRoomProps {
  socket: AuctionSocket;
  /** Leave the room and go back to the seat picker. */
  onLeave: () => void;
  /**
   * Return to the split-screen control console without leaving the room.
   *
   * Optional, and supplied only for the auctioneer. Before this existed, an
   * auctioneer who opened the waiting room was held on this screen until they
   * started the auction: the only other control was "Leave seat", which drops
   * the seat entirely. So the way back to the pool, the ledger and the Scout
   * was to give up the chair and re-claim it — which is a lock-out, not a
   * navigation choice.
   *
   * A franchise is never given this. There is nothing for them to go back to,
   * and the room would refuse it regardless.
   */
  onEnterControlRoom?: () => void;
}

export default function WaitingRoom({
  socket,
  onLeave,
  onEnterControlRoom,
}: WaitingRoomProps) {
  const reduced = useReducedMotion();
  const { state, seat, secondsLeft } = socket;

  const isAuctioneer = seat?.role === "auctioneer";
  const teams = state?.teams ?? [];
  const present = teams.filter((team) => team.connected).length;

  const expired = secondsLeft !== null && secondsLeft <= 0;

  return (
    <div className="grid min-h-screen place-items-center bg-surface bg-dots px-5 py-10">
      <div className="w-full max-w-2xl">
        <header className="mb-7 text-center">
          <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
            AUCTIQ · waiting room
          </span>
          <h1 className="mt-1.5 font-head text-[30px] font-bold leading-tight text-slate-ink">
            {expired ? "Ready when you are" : "The auction is about to begin"}
          </h1>

          {/*
            The clock. Rendered in the numerals family at a size you can read
            from across a room, because during these ten minutes it is the only
            thing anyone is looking at.
          */}
          <div className="mt-5">
            <Countdown seconds={secondsLeft} reduced={!!reduced} />
          </div>

          <p className="mt-3 font-ui text-[12.5px] text-slate-muted">
            {isAuctioneer
              ? "Start whenever the room is ready — the clock does not start it for you."
              : expired
                ? "Waiting for the auctioneer to begin."
                : "Stay on this screen. The block opens automatically when the auctioneer starts."}
          </p>
        </header>

        <section className="rounded-xl border border-line bg-surface-card p-4 shadow-soft">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-ui text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-muted">
              Franchises in the room
            </h2>
            <span className="font-ui text-[10px] uppercase tracking-[0.1em] text-slate-faint">
              <b className="font-num text-[13px] text-slate-ink">{present}</b> of {teams.length}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {teams.map((team, index) => {
              const isMine = seat?.team_id === team.id;
              return (
                <motion.div
                  key={team.id}
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, ease: EASE, delay: index * 0.02 }}
                  className={`relative overflow-hidden rounded-lg border px-2.5 py-2 pl-3 transition-colors ${
                    team.connected
                      ? "border-line bg-surface-card shadow-chip"
                      : "border-dashed border-line bg-surface-sunken/50"
                  } ${isMine ? "ring-1 ring-slate-ink/15" : ""}`}
                  title={
                    team.connected
                      ? `${team.name} is connected`
                      : `${team.name} has not joined`
                  }
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{
                      backgroundColor: team.connected ? team.color : "transparent",
                    }}
                  />
                  <span className="flex items-center gap-1.5">
                    {/* A steady dot is present, a hollow one is not. */}
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        team.connected ? "" : "border border-slate-faint"
                      }`}
                      style={{
                        backgroundColor: team.connected ? team.color : "transparent",
                      }}
                    />
                    <span
                      className={`font-ui text-[10px] font-semibold uppercase leading-none tracking-[0.08em] ${
                        team.connected ? "text-slate-body" : "text-slate-faint"
                      }`}
                    >
                      {team.code}
                    </span>
                    {isMine && (
                      <span className="ml-auto font-ui text-[8px] uppercase leading-none tracking-[0.08em] text-slate-faint">
                        you
                      </span>
                    )}
                  </span>
                  <span
                    className={`mt-1 block font-ui text-[8.5px] uppercase leading-none tracking-[0.06em] ${
                      team.connected ? "text-slate-faint" : "text-slate-faint/60"
                    }`}
                  >
                    {team.connected ? "ready" : "not joined"}
                  </span>
                </motion.div>
              );
            })}
          </div>
        </section>

        <div className="mt-5 flex items-center justify-center gap-3">
          {isAuctioneer ? (
            /*
              The manual override. Prominent, because it is the action this
              screen exists to offer the auctioneer, and because waiting for a
              timer you are allowed to skip is a silly thing to do.
            */
            <motion.button
              {...(reduced ? {} : pressable)}
              type="button"
              data-testid="waiting-start-auction"
              onClick={socket.startAuction}
              className="rounded-lg border border-slate-ink bg-slate-ink px-5 py-2.5 font-ui text-[11px] font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-slate-ink/90"
            >
              Start the auction now
            </motion.button>
          ) : (
            <span className="rounded-lg border border-line bg-surface-card px-4 py-2 font-ui text-[10px] uppercase tracking-[0.12em] text-slate-muted">
              {socket.status === "open" ? "Connected · holding" : "Reconnecting…"}
            </span>
          )}

          {/*
            The way back to the console.

            Placed between "start" and "leave" deliberately: it is the middle
            option in every sense — less final than starting the auction, far
            less destructive than giving up the chair. An auctioneer watching
            franchises trickle in has ten minutes with nothing to do, and this
            is the button that lets them spend it reading the pool instead of
            staring at a countdown they are not allowed to leave.

            Rendered only when a handler is supplied, which is only for the
            auctioneer. The room enforces that independently; this just avoids
            offering a franchise a door that would be shut in their face.
          */}
          {isAuctioneer && onEnterControlRoom && (
            <motion.button
              {...(reduced ? {} : pressable)}
              type="button"
              data-testid="waiting-control-room"
              onClick={onEnterControlRoom}
              title="Return to the pool, the ledger and the Scout without leaving the room"
              className="rounded-lg border border-line bg-surface-card px-4 py-2.5 font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
            >
              Control room
            </motion.button>
          )}

          <button
            type="button"
            data-testid="waiting-leave-seat"
            onClick={onLeave}
            className="rounded-lg border border-line bg-surface-card px-3.5 py-2 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
          >
            Leave seat
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * mm:ss, large.
 *
 * The colon does not blink and the digits do not animate. A countdown that
 * draws attention to itself every second is exhausting over ten minutes, and
 * the number is already the largest thing on the page.
 */
function Countdown({ seconds, reduced }: { seconds: number | null; reduced: boolean }) {
  if (seconds === null) {
    return (
      <span className="font-num text-[44px] font-bold leading-none text-slate-faint">
        —
      </span>
    );
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  // Under a minute the clock warms, which is the one moment it should be
  // louder than the grid beneath it.
  const urgent = seconds > 0 && seconds <= 60;

  return (
    <motion.span
      animate={urgent && !reduced ? { scale: [1, 1.03, 1] } : { scale: 1 }}
      transition={
        urgent && !reduced
          ? { duration: 1, repeat: Infinity, ease: "easeInOut" }
          : { duration: 0.2 }
      }
      className={`inline-block font-num text-[56px] font-bold leading-none tabular-nums ${
        seconds === 0 ? "text-slate-faint" : urgent ? "text-red-600" : "text-slate-ink"
      }`}
    >
      {minutes}:{String(rest).padStart(2, "0")}
    </motion.span>
  );
}
