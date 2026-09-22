/**
 * AuctionBlock.tsx
 * The war-room view driven by a socket — real or simulated.
 *
 * This is the standalone demo: with no `socket` prop it runs its own mock
 * auction, so the layout and every animation can be exercised with no backend
 * at all. Pass a real socket and nothing else changes.
 *
 * All presentation lives in BlockView; this file is only transport and the
 * state it produces. The live driver (LiveBlock) renders the same view from the
 * Phase 2 auction engine, so both share one implementation of the layout and
 * the animation.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { LotClock } from "../../hooks/useAuctionSocket";
import BlockView from "./BlockView";
import { incrementFor, type Lot, type TickerEntry } from "./blockTypes";

/* ------------------------------------------------------------------ *
 * Wire format
 * ------------------------------------------------------------------ */

export interface BidEvent {
  /** ₹ lakh. */
  amount: number;
  /** Three-letter franchise code. */
  team: string;
  at: number;
}

export interface SoldEvent {
  playerId: number;
  team: string;
  amount: number;
}

type Handler<T> = (payload: T) => void;

/**
 * The subset of a socket this component needs.
 *
 * Declared structurally rather than importing a client library, so the same
 * component runs against socket.io, a raw WebSocket wrapper, or the mock below
 * without conditional code.
 */
export interface AuctionSocket {
  on(event: "broadcast_new_lot", handler: Handler<Lot>): void;
  on(event: "broadcast_new_bid", handler: Handler<BidEvent>): void;
  on(event: "broadcast_lot_sold", handler: Handler<SoldEvent>): void;
  off(event: string, handler?: Handler<never>): void;
  emit(event: "place_bid", payload: { team: string; amount: number }): void;
}

const TEAMS = ["MUM", "CHE", "BLR", "KOL", "DEL", "PBK", "RAJ", "HYD"] as const;

/* ------------------------------------------------------------------ *
 * Mock socket
 * ------------------------------------------------------------------ */

/**
 * A self-contained auction, so the animations can be exercised with no backend.
 *
 * It behaves like a room rather than a metronome: rivals bid at irregular
 * intervals, drop out once the price passes what they would sensibly pay, and
 * the lot closes when nobody answers. Every lot therefore ends, which is what
 * makes the sold state and the vault drain reachable in a demo.
 */
/**
 * The closing window: how long the room waits for an answer before the hammer.
 *
 * One constant, read by both the mock that ends a lot and the clock the dial
 * counts down. Two numbers here would mean a countdown that reaches zero while
 * bidding continues, or a sale while seconds still show.
 */
const CLOSING_MS = 7000;
/** The pause on a fresh lot, before bidding is treated as open. */
const OPENING_MS = 4000;

export function createMockSocket(myTeam: string): AuctionSocket & { stop: () => void } {
  const listeners: Record<string, Handler<never>[]> = {};
  const fire = <T,>(event: string, payload: T) => {
    for (const fn of listeners[event] ?? []) (fn as Handler<T>)(payload);
  };

  const pool: Lot[] = [
    { id: 1, name: "Jos Buttler", role: "Wicket Keeper", country: "England", base: 200, rating: 9.5, headline: "4,647 runs · 149.70 SR" },
    { id: 2, name: "Jasprit Bumrah", role: "Bowler", country: "India", base: 200, rating: 9.75, headline: "184 wickets · 7.30 econ" },
    { id: 3, name: "Rashid Khan", role: "All-Rounder", country: "Afghanistan", base: 200, rating: 9.75, headline: "163 wickets · 6.78 econ" },
    { id: 4, name: "Shashank Singh", role: "Batter", country: "India", base: 30, rating: 9.25, headline: "486 runs · 158.31 SR" },
    { id: 5, name: "Heinrich Klaasen", role: "Wicket Keeper", country: "South Africa", base: 200, rating: 9.5, headline: "1,447 runs · 171.10 SR" },
  ];

  let lotIndex = -1;
  let bid = 0;
  let leader = "";
  let timer: number | undefined;
  /**
   * The hammer timer, kept separate from the rival timer.
   *
   * A lot ends because nobody answered inside the closing window, not because
   * a rival ran out of money. Modelling those as one timer is what made this
   * mock sell the instant rivals stopped: there was no window to watch, so the
   * countdown dial had nothing to count and the five-second alarm could never
   * fire. A bid from any station cancels this; silence lets it through.
   */
  let hammer: number | undefined;
  /** Every franchise that has bid on the current lot, in order of first bid. */
  let contenders: string[] = [];
  let stopped = false;

  /** The most a rival will pay for this lot — what gives every auction an end. */
  let ceiling = 0;

  function schedule(delay: number) {
    window.clearTimeout(timer);
    timer = window.setTimeout(tick, delay);
  }

  /** Restart the closing window. Called on every bid, from any station. */
  function armHammer() {
    window.clearTimeout(hammer);
    hammer = window.setTimeout(() => {
      if (stopped) return;
      window.clearTimeout(timer);
      if (leader) {
        fire("broadcast_lot_sold", {
          playerId: pool[lotIndex].id,
          team: leader,
          amount: bid,
        });
      }
      window.setTimeout(openLot, 3000);
    }, CLOSING_MS);
  }

  function openLot() {
    if (stopped) return;
    lotIndex = (lotIndex + 1) % pool.length;
    const lot = pool[lotIndex];
    bid = lot.base;
    leader = "";
    contenders = [];
    window.clearTimeout(hammer);
    // Rivals chase to somewhere between 1.6x and 3.4x the reserve.
    ceiling = Math.round(lot.base * (1.6 + Math.random() * 1.8));
    fire("broadcast_new_lot", lot);
    schedule(2200);
  }

  function tick() {
    if (stopped) return;

    const next = leader ? bid + incrementFor(bid) : bid;

    // Nobody counters. Say nothing and let the hammer timer run out, which is
    // what puts a visible countdown on screen before the sale.
    if (next > ceiling) return;

    // A rival bids — never this station, whose bids come from the button.
    const rivals = TEAMS.filter((t) => t !== myTeam && t !== leader);
    const team = rivals[Math.floor(Math.random() * rivals.length)];
    bid = next;
    leader = team;
    if (!contenders.includes(team)) contenders = [...contenders, team];
    fire("broadcast_new_bid", { amount: bid, team, at: Date.now(), contenders });

    armHammer();
    // Always shorter than the closing window, or every lot would end on the
    // clock and the rivals would never actually compete for anything.
    schedule(1500 + Math.random() * 3200);
  }

  const socket: AuctionSocket & { stop: () => void } = {
    on(event, handler) {
      (listeners[event] ??= []).push(handler as Handler<never>);
    },
    off(event, handler) {
      if (!handler) delete listeners[event];
      else listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
    },
    emit(_event, payload) {
      // The local bid is echoed back as a broadcast, so the view learns its own
      // bid the same way it learns everyone else's. Anything else would let an
      // optimistic path and the authoritative path drift apart.
      if (stopped) return;
      bid = payload.amount;
      leader = payload.team;
      if (!contenders.includes(leader)) contenders = [...contenders, leader];
      fire("broadcast_new_bid", { amount: bid, team: leader, at: Date.now(), contenders });
      armHammer();
      schedule(1500 + Math.random() * 2200);
    },
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(hammer);
    },
  };

  window.setTimeout(openLot, 400);
  return socket;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface AuctionBlockProps {
  /** Omit to run against the built-in mock. */
  socket?: AuctionSocket;
  /** The franchise this station bids for. */
  myTeam?: string;
  /** Opening purse, ₹ lakh. */
  purse?: number;
  corner?: React.ReactNode;
}

export default function AuctionBlock({
  socket: providedSocket,
  myTeam = "MUM",
  purse = 12000,
  corner,
}: AuctionBlockProps) {
  const [lot, setLot] = useState<Lot | null>(null);
  const [currentBid, setCurrentBid] = useState(0);
  const [leadingTeam, setLeadingTeam] = useState("");
  const [purseLeft, setPurseLeft] = useState(purse);
  const [ticker, setTicker] = useState<TickerEntry[]>([]);
  const [clock, setClock] = useState<LotClock | null>(null);
  const [contenders, setContenders] = useState<string[]>([]);

  // `purse` only seeds state, so a later prop change would otherwise be
  // ignored — which would make the query-string demo lie about its budget.
  useEffect(() => setPurseLeft(purse), [purse]);

  const tickerId = useRef(0);
  const pushTicker = useCallback((entry: Omit<TickerEntry, "id">) => {
    setTicker((prev) => [{ ...entry, id: tickerId.current++ }, ...prev].slice(0, 24));
  }, []);

  /**
   * Transport lifecycle.
   *
   * The socket is created inside the effect rather than memoised outside it.
   * That matters under StrictMode: the effect mounts, cleans up, and mounts
   * again, so a socket held in a memo would be stopped by the first cleanup and
   * never rebuilt — the feed would go silent before the first lot. Creating it
   * per effect run means each mount gets a live instance and each cleanup
   * disposes exactly the instance it opened.
   */
  const socketRef = useRef<AuctionSocket | null>(null);

  useEffect(() => {
    const mock = providedSocket ? null : createMockSocket(myTeam);
    const active: AuctionSocket = providedSocket ?? mock!;
    socketRef.current = active;

    const onLot = (next: Lot) => {
      setLot(next);
      setCurrentBid(next.base);
      setLeadingTeam("");
      setContenders([]);
      setClock({
        kind: "opening",
        endsIn: OPENING_MS / 1000,
        total: OPENING_MS / 1000,
        key: `lot:${next.id}`,
      });
      pushTicker({ kind: "lot", text: `${next.name} on the block`, amount: next.base, mine: false });
    };

    const onBid = (event: BidEvent & { contenders?: string[] }) => {
      setCurrentBid(event.amount);
      setLeadingTeam(event.team);
      if (event.contenders) setContenders(event.contenders);
      // A new key restarts the dial; `TimerDisplay` counts down locally from
      // `endsIn`, so it only re-reads when one of these two changes.
      setClock({
        kind: "closing",
        endsIn: CLOSING_MS / 1000,
        total: CLOSING_MS / 1000,
        key: `bid:${event.amount}:${event.team}:${event.at}`,
      });
      pushTicker({
        kind: "bid",
        text: `${event.team} bids`,
        amount: event.amount,
        mine: event.team === myTeam,
      });
    };

    const onSold = (event: SoldEvent) => {
      pushTicker({
        kind: "sold",
        text: `SOLD to ${event.team}`,
        amount: event.amount,
        mine: event.team === myTeam,
      });
      // Only our own purchases move our purse.
      if (event.team === myTeam) setPurseLeft((left) => Math.max(0, left - event.amount));
      // The lot is over; nothing is closing any more.
      setClock(null);
    };

    active.on("broadcast_new_lot", onLot);
    active.on("broadcast_new_bid", onBid);
    active.on("broadcast_lot_sold", onSold);

    return () => {
      active.off("broadcast_new_lot", onLot as Handler<never>);
      active.off("broadcast_new_bid", onBid as Handler<never>);
      active.off("broadcast_lot_sold", onSold as Handler<never>);
      mock?.stop();
      socketRef.current = null;
    };
  }, [providedSocket, myTeam, pushTicker]);

  const handleBid = useCallback(
    (amount: number) => socketRef.current?.emit("place_bid", { team: myTeam, amount }),
    [myTeam],
  );

  /*
    Jumpbid goes through the same path as a standard raise.

    The room does not have a second kind of bid — a jump is a bid with an
    amount chosen rather than stepped, which is exactly what `emit` already
    takes. Supplying this is also what makes the control appear at all, and
    what lets the coin cascade ever show more than one coin.
  */
  const handleJumpBid = useCallback(
    (amount: number) => socketRef.current?.emit("place_bid", { team: myTeam, amount }),
    [myTeam],
  );

  return (
    <BlockView
      lot={lot}
      currentBid={currentBid}
      leadingTeam={leadingTeam}
      myTeam={myTeam}
      purse={purse}
      purseLeft={purseLeft}
      ticker={ticker}
      onBid={handleBid}
      onJumpBid={handleJumpBid}
      clock={clock}
      contenders={contenders}
      corner={corner}
    />
  );
}
