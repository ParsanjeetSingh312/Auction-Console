/**
 * RoomGate.tsx
 * The way into Live Bidding: create a room, or join one.
 *
 * The server runs several auctions at once, each under a room code
 * (console/auctionRoom.ts). This is the first screen of `/auction`, before the
 * tab is in any room:
 *
 *   Create a room   an Auctioneer account. One press creates the room and
 *                   takes its chair -- the account is the credential, carried
 *                   by the session cookie -- and lands on the control panel,
 *                   where the room's code is shown to send to the franchise
 *                   owners.
 *   Join a room     a Delegate or Free account. The code they were sent
 *                   takes them into the room, where they choose their
 *                   franchise, read the briefing and bid.
 *
 * Both cost a pass (accounts/passes.py): opening a room its kind's, a seat a
 * Delegate pass. Each card says what it will cost and what the wallet holds.
 *
 * The server enforces all of it (auction/room.py): what is hidden here for an
 * account that may not use it is a courtesy, not the lock.
 *
 * The code is never shown here: a franchise's typing is masked, and a refused
 * code is not repeated back. Every room seats up to twelve franchises, so one
 * kind of room serves every auction.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import { canJoinRooms, roomTypesFor, tagFor, useAccount } from "../../console/accountStore";
import type { Account } from "../../console/accountStore";
import { createRoom, DEFAULT_ROOM, enterRoom, normaliseRoomCode } from "../../console/auctionRoom";
import type { RoomType } from "../../console/auctionRoom";
import { cardVariants, gridVariants } from "../../console/motion";
import type { AuctionSocket } from "../../hooks/useAuctionSocket";
import LightSweep from "../UI/LightSweep";
import AuctionPass from "../Passes/AuctionPass";
import { useEcosystem } from "../../console/ecosystemStore";
import type { PassKind } from "../../console/ecosystemStore";

const LABEL = "font-ui text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-body";
const INPUT =
  "mt-1 w-full rounded-lg border border-line bg-surface-sunken px-3 py-2 font-ui text-[13px] text-slate-ink outline-none transition-colors focus:border-slate-faint";
const PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-slate-ink px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";
const SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-line bg-surface-card px-4 py-2 font-ui text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-body transition-colors hover:border-slate-faint/60 hover:text-slate-ink";

export default function RoomGate({
  socket,
  notice,
  nextRoom = null,
}: {
  socket: AuctionSocket;
  /** Why the tab is back here: a code refused, a login turned away. */
  notice: string | null;
  /**
   * The code of the next auction, when the auctioneer closed the last room to
   * open it. Filled into "Join a room", and the notice reads as news rather
   * than as an error.
   */
  nextRoom?: string | null;
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
            role={nextRoom ? "status" : "alert"}
            className={
              nextRoom
                ? "mb-5 rounded-lg border border-[var(--teal-ink)] bg-[var(--teal-tint)] px-3.5 py-2.5 font-ui text-[12px] leading-relaxed text-[var(--teal-ink)]"
                : "mb-5 rounded-lg border border-[#C0453A]/40 bg-[#C0453A]/10 px-3.5 py-2.5 font-ui text-[12px] leading-relaxed text-[#C0453A]"
            }
          >
            {notice}
          </motion.p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <CreateRoom socket={socket} />
          <JoinRoom socket={socket} initialCode={nextRoom ?? ""} />
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

/** Signed out: the way to an account that can do this, and back here after. */
function SignInPrompt({ role }: { role: "Auctioneer" | "Delegate" }) {
  return (
    <div className="mt-4">
      <p className="font-ui text-[12px] leading-relaxed text-slate-body">
        Log in with {role === "Auctioneer" ? "an" : "a"} {role} account to continue.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to="/login?next=/auction/live" className={PRIMARY}>
          Log in
        </Link>
        <Link to="/login?mode=register&next=/auction/live" className={SECONDARY}>
          Create an account
        </Link>
      </div>
    </div>
  );
}

/** Signed in with an account that may not do this: say so, and why. */
function WrongAccount({ account, need }: { account: Account; need: string }) {
  return (
    <p className="mt-4 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-ui text-[12px] leading-relaxed text-slate-muted">
      You are signed in as <b className="text-slate-ink">{account.name}</b>, a{" "}
      <b className="text-slate-ink">{tagFor(account)}</b> account. {need}
    </p>
  );
}

/** The auctioneer: their account creates the room and takes its chair. */
function CreateRoom({ socket }: { socket: AuctionSocket }) {
  const { status, account } = useAccount();
  const { balances } = useEcosystem();
  const types = roomTypesFor(account);

  const create = (type: RoomType) => {
    // The claim waits for the new room's connection, which carries the
    // session: the server opens the room for this account -- refusing a kind
    // the account may not create -- seats it in the chair, and Live Bidding
    // opens the control panel.
    socket.queueSeat({ role: "auctioneer" });
    createRoom(type);
  };

  return (
    <motion.section
      variants={cardVariants}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className="seat-chair relative overflow-hidden rounded-xl border border-line p-5"
      aria-label="Create a room"
    >
      <span aria-hidden className="seat-chair__rule" />
      <LightSweep />
      <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
        Run an auction
      </span>
      <h2 className="mt-1.5 font-head text-[20px] font-bold leading-tight text-slate-ink">Create a room</h2>
      <p className="mt-1.5 font-ui text-[12px] leading-relaxed text-slate-muted">
        Open a new auction room and run it from the control panel, where its code is shown to send to
        the franchise owners.
      </p>

      {status === "loading" ? (
        <p className="mt-4 font-ui text-[12px] text-slate-faint">Checking your account…</p>
      ) : !account ? (
        <SignInPrompt role="Auctioneer" />
      ) : types.length === 0 ? (
        <WrongAccount account={account} need="Member accounts cannot create auction rooms." />
      ) : (
        <div className="mt-4">
          <p className="font-ui text-[12px] text-slate-body">
            Signed in as <b className="text-slate-ink">{account.name}</b>
          </p>
          {/* One button for everyone who may create: the kind of room follows
              from the account (an auctioneer's or a delegate's), decided and
              enforced by the server, and never shown here. */}
          <PassCost account={account} kind={types[0] === "auctioneer" ? "A" : "D"} what="Opening the room" />
          <button
            type="button"
            onClick={() => create(types[0])}
            disabled={!hasPass(account, types[0] === "auctioneer" ? "A" : "D", balances)}
            className={`${PRIMARY} mt-3 w-full`}
          >
            Create room &amp; enter control panel
          </button>
        </div>
      )}
    </motion.section>
  );
}

/** A franchise: the code they were sent, and in. */
function JoinRoom({ socket, initialCode = "" }: { socket: AuctionSocket; initialCode?: string }) {
  const { status, account } = useAccount();
  const [code, setCode] = useState(initialCode);
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

  // Delegates join to bid; an auctioneer may come back into a room it created
  // (a new tab, another device) and take its chair from the room's own screen.
  const allowed = canJoinRooms(account);

  return (
    <motion.section
      variants={cardVariants}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className="seat-chair relative overflow-hidden rounded-xl border border-line p-5"
      aria-label="Join a room"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-neon-orange" />
      <LightSweep delay={0.55} />
      <span className="font-ui text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-faint">
        Join an auction
      </span>
      <h2 className="mt-1.5 font-head text-[20px] font-bold leading-tight text-slate-ink">Join a room</h2>
      <p className="mt-1.5 font-ui text-[12px] leading-relaxed text-slate-muted">
        Enter the room code your auctioneer sent you, then choose your franchise.
      </p>

      {status === "loading" ? (
        <p className="mt-4 font-ui text-[12px] text-slate-faint">Checking your account…</p>
      ) : !account ? (
        <SignInPrompt role="Delegate" />
      ) : !allowed ? (
        <WrongAccount account={account} need="Log in to take a seat in a live auction room." />
      ) : (
        <form onSubmit={submit} noValidate className="mt-4">
          <label className="block">
            <span className={LABEL}>
              {account.role === "auctioneer" && !account.admin ? "Code of a room you created" : "Room code"}
            </span>
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
          {(account.role === "delegate" || account.role === "member") && (
            <PassCost account={account} kind="D" what="A franchise seat, once per room," />
          )}
          <button type="submit" className={`${PRIMARY} mt-4 w-full`} disabled={!code.trim()}>
            Enter room
          </button>
        </form>
      )}
    </motion.section>
  );
}

function hasPass(account: Account, kind: PassKind, balances: Record<PassKind, number>): boolean {
  return !!account.admin || balances[kind] > 0;
}

/**
 * What the next step costs, in passes, and what the wallet holds. The server
 * charges it (auction/ws.py); this is so nobody is surprised by it.
 */
function PassCost({ account, kind, what }: { account: Account; kind: PassKind; what: string }) {
  const { balances } = useEcosystem();
  const have = balances[kind];
  const name = kind === "A" ? "gold Auctioneer pass" : "blue Delegate pass";
  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
      <AuctionPass kind={kind} size="xs" count={account.admin ? undefined : have} tilt={false} />
      <p className="font-ui text-[11.5px] leading-snug text-slate-body">
        {account.admin ? (
          <>Free for administrators.</>
        ) : have > 0 ? (
          <>
            {what} uses <b className="text-slate-ink">1 {name}</b>. You have {have}.
          </>
        ) : (
          <>
            {what} needs a {name}, and you have none.{" "}
            {kind === "A" ? "Check your notifications, or ask an administrator." : "Ask your Auctioneer to send you one."}
          </>
        )}
      </p>
    </div>
  );
}
