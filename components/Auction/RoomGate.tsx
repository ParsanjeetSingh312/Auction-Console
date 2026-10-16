/**
 * RoomGate.tsx
 * The way into Live Bidding: create a room, or join one.
 *
 * The server runs several auctions at once, each under a room code
 * (console/auctionRoom.ts). This is the first screen of `/auction`, before the
 * tab is in any room:
 *
 *   Create a room   the auctioneer. Their login (designation and password)
 *                   creates the room and takes its chair in one step, and they
 *                   land straight on the control panel, where the room's code
 *                   is shown for them to send to the franchise owners.
 *   Join a room     a franchise. The code they were sent takes them into the
 *                   room, where they choose their franchise, read the briefing
 *                   and bid.
 *
 * The code is never shown here: a franchise's typing is masked, and a refused
 * code is not repeated back. Every room seats up to twelve franchises, so one
 * kind of room serves every auction.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import { createRoom, DEFAULT_ROOM, enterRoom, normaliseRoomCode } from "../../console/auctionRoom";
import { cardVariants, gridVariants } from "../../console/motion";
import type { AuctionSocket } from "../../hooks/useAuctionSocket";

const LABEL = "font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-body";
const INPUT =
  "mt-1 w-full rounded-lg border border-line bg-surface-sunken px-3 py-2 font-ui text-[13px] text-slate-ink outline-none transition-colors focus:border-slate-faint";
const PRIMARY =
  "rounded-lg bg-slate-ink px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export default function RoomGate({
  socket,
  notice,
}: {
  socket: AuctionSocket;
  /** Why the tab is back here: a code refused, a login turned away. */
  notice: string | null;
}) {
  return (
    <div className="min-h-screen bg-surface bg-dots px-5 py-10">
      <motion.div
        className="mx-auto w-full max-w-3xl"
        variants={gridVariants}
        initial="initial"
        animate="animate"
      >
        <motion.header className="mb-7 flex items-start justify-between gap-4" variants={cardVariants}>
          <div>
            <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
              Live bidding
            </span>
            <h1 className="mt-1 font-head text-[28px] font-bold leading-tight text-slate-ink">
              Create or join an auction room
            </h1>
          </div>
          <Link
            to="/"
            className="shrink-0 rounded-lg border border-line bg-surface-card px-3 py-1.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink"
          >
            ← AUCTONIQ
          </Link>
        </motion.header>

        {notice && (
          <motion.p
            variants={cardVariants}
            role="alert"
            className="mb-5 rounded-lg border border-[#C0453A]/40 bg-[#C0453A]/10 px-3.5 py-2.5 font-ui text-[12px] leading-relaxed text-[#C0453A]"
          >
            {notice}
          </motion.p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <CreateRoom socket={socket} />
          <JoinRoom socket={socket} />
        </div>

        <motion.p variants={cardVariants} className="mt-6 text-center font-ui text-[11.5px] text-slate-faint">
          Running the single shared room instead?{" "}
          <button
            type="button"
            onClick={() => {
              socket.queueSeat(null);
              enterRoom(DEFAULT_ROOM);
            }}
            className="font-semibold text-slate-muted underline underline-offset-2 hover:text-slate-ink"
          >
            Open the main room
          </button>
        </motion.p>
      </motion.div>
    </div>
  );
}

/** The auctioneer: log in, and the room is created around them. */
function CreateRoom({ socket }: { socket: AuctionSocket }) {
  const [designation, setDesignation] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (designation.trim().toUpperCase() !== "AUCTIONEER") {
      setFormError('Enter "AUCTIONEER" as the designation.');
      return;
    }
    if (!password) {
      setFormError("Enter the auctioneer password.");
      return;
    }
    // The claim waits for the new room's connection; on success the seat is the
    // auctioneer's and Live Bidding opens the control panel. A refused login
    // brings the tab back here with the room's reason.
    socket.queueSeat({ role: "auctioneer", password });
    createRoom();
  };

  return (
    <motion.form
      variants={cardVariants}
      onSubmit={submit}
      noValidate
      className="relative overflow-hidden rounded-xl border border-line bg-surface-card p-5 shadow-soft"
      aria-label="Create a room"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-slate-ink" />
      <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
        Auctioneer · password protected
      </span>
      <h2 className="mt-1.5 font-head text-[20px] font-bold leading-tight text-slate-ink">Create a room</h2>
      <p className="mt-1.5 font-ui text-[12px] leading-relaxed text-slate-muted">
        Log in to open a new auction room and take its chair. Its code is on your control panel to
        send to the franchise owners.
      </p>

      <label className="mt-4 block">
        <span className={LABEL}>Designation</span>
        <input
          type="text"
          value={designation}
          onChange={(event) => setDesignation(event.target.value)}
          placeholder="AUCTIONEER"
          autoComplete="off"
          className={INPUT}
        />
      </label>
      <label className="mt-3 block">
        <span className={LABEL}>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          className={INPUT}
        />
      </label>

      {formError && (
        <p role="alert" className="mt-3 font-ui text-[11.5px] leading-relaxed text-[#C0453A]">
          {formError}
        </p>
      )}

      <button type="submit" className={`${PRIMARY} mt-5 w-full`}>
        Create room &amp; enter control panel
      </button>
    </motion.form>
  );
}

/** A franchise: the code they were sent, and in. */
function JoinRoom({ socket }: { socket: AuctionSocket }) {
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const room = normaliseRoomCode(code);
    if (!room) {
      setFormError("Room codes are letters and digits, like the one your auctioneer sent.");
      return;
    }
    socket.queueSeat(null);
    enterRoom(room);
  };

  return (
    <motion.form
      variants={cardVariants}
      onSubmit={submit}
      noValidate
      className="relative overflow-hidden rounded-xl border border-line bg-surface-card p-5 shadow-soft"
      aria-label="Join a room"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-neon-orange" />
      <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
        Franchise owners
      </span>
      <h2 className="mt-1.5 font-head text-[20px] font-bold leading-tight text-slate-ink">Join a room</h2>
      <p className="mt-1.5 font-ui text-[12px] leading-relaxed text-slate-muted">
        Enter the room code your auctioneer sent you, then choose your franchise.
      </p>

      <label className="mt-4 block">
        <span className={LABEL}>Room code</span>
        <input
          type="password"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.toUpperCase());
            setFormError(null);
          }}
          maxLength={24}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          className={`${INPUT} font-num tracking-[0.18em]`}
        />
      </label>

      {formError && (
        <p role="alert" className="mt-3 font-ui text-[11.5px] leading-relaxed text-[#C0453A]">
          {formError}
        </p>
      )}

      <button type="submit" className={`${PRIMARY} mt-5 w-full`} disabled={!code.trim()}>
        Enter room
      </button>
    </motion.form>
  );
}
