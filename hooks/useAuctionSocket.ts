/**
 * useAuctionSocket.ts
 * The client half of the server-owned auction.
 *
 * This hook holds no auction logic, and that is the entire point. It sends
 * intents and renders whatever the room sends back. Nothing here decides
 * whether a bid is legal, what the next ask is, or who is winning — every one
 * of those questions is answered by `auction/room.py`, because a client that
 * computes them is a client that can disagree with the room, and ten clients
 * disagreeing with the room is the bug this whole phase exists to prevent.
 *
 * Compare `useAuctionEngine`, which owns the auction outright. That is still
 * the right design for `/console`: one operator, one browser, no server. This
 * is the right design for a room. They coexist deliberately.
 *
 * Three things this hook does take responsibility for:
 *
 *   **Reconnection.** Auctions run for hours and laptops sleep. The socket
 *   reconnects with backoff and re-claims its seat automatically, because
 *   losing your franchise to a dropped Wi-Fi signal mid-lot is not acceptable.
 *
 *   **Staleness.** Every bid carries the `lot_version` the user could actually
 *   see when they clicked. If the room has moved on, the room refuses it. That
 *   is what stops a click landing on a lot that changed while the packet was in
 *   flight — see the race guard in `room.py`.
 *
 *   **StrictMode.** The socket is created inside the effect rather than in a
 *   memo. React 18 mounts, unmounts and remounts in development; a memoised
 *   socket would be closed by the first cleanup and the second mount would
 *   reuse the dead instance. This mistake has been made in this codebase
 *   before, in the Phase 3 mock feed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { wsUrl } from "../console/apiBase";

/* ------------------------------------------------------------------ *
 * The wire format, mirroring auction/schemas.py
 * ------------------------------------------------------------------ */

export type Phase = "lobby" | "waiting" | "live" | "finished";
export type Role = "auctioneer" | "franchise" | "spectator";

export interface Seat {
  role: Role;
  team_id: number | null;
  team_code: string | null;
  client_id: string;
}

export interface TeamState {
  id: number;
  name: string;
  code: string;
  color: string;
  spent: number;
  left: number;
  size: number;
  /** [playerId, price] pairs for everything this franchise has bought. */
  buys?: [number, number][];
  overseas: number;
  max_bid: number;
  connected: boolean;
  /** Strategic buffers this franchise has not spent yet. */
  timeouts_left: number;
}

export interface LotState {
  player_id: number;
  player_name: string;
  role: string;
  country: string | null;
  overseas: boolean;
  rating: number | null;
  base: number;
  bid: number;
  bidder_id: number | null;
  bidder_code: string | null;
  next_ask: number;
  version: number;

  /**
   * Which countdown is running, and therefore what its expiry means:
   * `opening` -> UNSOLD, `closing` and `timeout` -> SOLD to the highest bid.
   */
  clock: "opening" | "closing" | "timeout" | null;
  /** Unix seconds the countdown fires. */
  deadline: number | null;
  /**
   * Seconds left when the room wrote this frame.
   *
   * This, not `deadline`, is what a display should count down from. Seven
   * seconds is short enough that a laptop whose clock runs two seconds fast
   * would otherwise show a lot expiring while the room still holds it open.
   */
  ends_in: number | null;
  timeout_by_id: number | null;
  timeout_by_code: string | null;
  /** Franchises that have bid on this lot and not withdrawn from it. */
  contenders: number[];
  contender_codes: string[];
}

/**
 * A countdown, packaged so a display can tick it locally.
 *
 * `key` changes on every re-arm. A component keyed on it restarts its own
 * animation from the top rather than interpolating from wherever the last
 * buffer had got to, which is what makes a bid visibly reset the clock.
 */
export interface LotClock {
  kind: "opening" | "closing" | "timeout";
  /** Seconds remaining as of the frame this came from. */
  endsIn: number;
  /** The full length of this kind of buffer, for a progress bar's denominator. */
  total: number;
  key: string;
}

export interface LogItem {
  seq: number;
  kind: "note" | "bid" | "sold" | "unsold" | "timeout" | "withdraw";
  what: string;
  amount: number | null;
  ts: number;
}

export interface RoomState {
  version: number;
  phase: Phase;
  rules: {
    purse: number;
    max_squad: number;
    min_squad: number;
    max_overseas: number;
    /** The clock, owned by the room so the dial cannot disagree with it. */
    open_seconds: number;
    close_seconds: number;
    timeout_seconds: number;
    timeouts_per_team: number;
  };
  teams: TeamState[];
  lot: LotState | null;
  log: LogItem[];
  counts: { available: number; sold: number; unsold: number; spent: number };
  unsold?: number[];
  countdown_ends_at: number | null;
  connected: number;
}

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

/** What we asked to be, so a reconnect can ask for it again. */
export interface SeatRequest {
  role: "auctioneer" | "franchise";
  teamId?: number;
  displayName?: string;
}

/* ------------------------------------------------------------------ *
 * Endpoint
 * ------------------------------------------------------------------ */

/**
 * The room's address, resolved by `apiBase` rather than worked out here.
 *
 * This function used to carry its own copy of the dev/production split, which
 * meant the socket could disagree with `ragClient` about where the backend is.
 * That disagreement had a specific and confusing symptom: the console would
 * hydrate its 284-player roster over REST perfectly well and then fail to join
 * the room, because the two halves were dialling different places.
 *
 * `wsUrl` derives ws/wss and the authority from the same base the REST client
 * uses, so the two can no longer drift. VITE_AUCTION_WS still overrides it
 * outright for the case where the socket really does live somewhere else.
 */
function socketUrl(): string {
  return wsUrl();
}

/** Backoff schedule, in ms. Caps rather than growing without bound. */
const BACKOFF = [400, 900, 1800, 3000, 5000, 8000];
const PING_INTERVAL = 25_000;

export interface AuctionSocket {
  status: SocketStatus;
  state: RoomState | null;
  seat: Seat | null;
  /** Most recent refusal from the room. Cleared by `dismissError`. */
  error: string | null;
  dismissError: () => void;

  /** Seconds left on the waiting-room countdown, or null outside `waiting`. */
  secondsLeft: number | null;

  claimSeat: (request: SeatRequest) => void;
  openWaitingRoom: (seconds?: number) => void;
  startAuction: () => void;
  putUp: (playerId: number) => void;
  /** `amount` omitted bids the standard increment; supplied, it is a jumpbid. */
  bid: (amount?: number) => void;
  sell: () => void;
  markUnsold: () => void;
  undo: () => void;
  finish: () => void;
  /** Auctioneer: wipe the auction back to an empty lobby, keeping seats. */
  resetRoom: () => void;
  /**
   * Franchise: step out of the contest for the lot on the block.
   *
   * An accelerator, not a veto. The buffer settles every lot on its own; this
   * says "do not wait for me", and once everyone but the standing bidder has
   * said it the lot goes at once instead of sitting out a buffer nobody will
   * use. Per-lot: the next player puts you back in contention.
   */
  withdraw: () => void;
  /** Franchise: spend a lifeline and freeze the block for thirty seconds. */
  callTimeout: () => void;

  /** Convenience readings derived from `state` and `seat`. */
  myTeam: TeamState | null;
  isWinning: boolean;
  canAct: boolean;

  /** The running countdown, or null when nothing is armed. */
  lotClock: LotClock | null;
  /** Lifelines this franchise has left. */
  timeoutsLeft: number;
  /** This franchise has bid on the current lot and not withdrawn. */
  amContending: boolean;
  /**
   * Whether these two controls should be offered at all.
   *
   * Mirrors the room's own refusals so a control that would be rejected is
   * never presented as available. The room re-checks regardless and its answer
   * is the one that counts -- this only avoids offering a dead button.
   */
  canWithdraw: boolean;
  canCallTimeout: boolean;
}

export function useAuctionSocket(): AuctionSocket {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [state, setState] = useState<RoomState | null>(null);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const socketRef = useRef<WebSocket | null>(null);
  /** Held across reconnects so the seat can be re-claimed without asking. */
  const seatRequest = useRef<SeatRequest | null>(null);
  /** Read inside send() so a bid always quotes the version on screen. */
  const lotVersion = useRef<number | null>(null);
  const attempt = useRef(0);
  const closed = useRef(false);

  /* ---------------- the connection ---------------- */

  useEffect(() => {
    closed.current = false;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;

    const connect = () => {
      if (closed.current) return;

      // Created here, not memoised — StrictMode's double mount would otherwise
      // hand the second mount a socket the first mount's cleanup had closed.
      const socket = new WebSocket(socketUrl());
      socketRef.current = socket;
      setStatus(attempt.current === 0 ? "connecting" : "reconnecting");

      socket.onopen = () => {
        attempt.current = 0;
        setStatus("open");

        // Re-claim the seat we held before the drop. The room frees a seat on
        // disconnect, so this is a fresh claim and can legitimately fail if
        // someone else took it meanwhile — which surfaces as an error, not as
        // a silent demotion to spectator.
        const request = seatRequest.current;
        if (request) {
          socket.send(
            JSON.stringify({
              type: "join",
              role: request.role,
              team_id: request.teamId ?? null,
              display_name: request.displayName ?? null,
            }),
          );
        }

        pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL);
      };

      socket.onmessage = (event) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data as string);
        } catch {
          return; // The server does not emit malformed JSON; ignore noise.
        }

        switch (payload.type) {
          case "state": {
            const next = payload as unknown as RoomState;
            setState(next);
            lotVersion.current = next.lot?.version ?? null;
            break;
          }
          case "joined":
            setSeat((payload as { seat: Seat }).seat);
            break;
          case "error":
            setError(String(payload.message ?? "The room refused that."));
            break;
          case "pong":
          default:
            break;
        }
      };

      socket.onclose = () => {
        window.clearInterval(pingTimer);
        if (closed.current) {
          setStatus("closed");
          return;
        }
        setStatus("reconnecting");
        const wait = BACKOFF[Math.min(attempt.current, BACKOFF.length - 1)];
        attempt.current += 1;
        reconnectTimer = window.setTimeout(connect, wait);
      };

      // `onerror` is always followed by `onclose`, which owns the retry. Doing
      // anything here as well would schedule two reconnects for one failure.
      socket.onerror = () => {};
    };

    connect();

    return () => {
      closed.current = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  /* ---------------- countdown ---------------- */

  useEffect(() => {
    if (state?.phase !== "waiting" || !state.countdown_ends_at) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.phase, state?.countdown_ends_at]);

  const secondsLeft = useMemo(() => {
    if (state?.phase !== "waiting" || !state.countdown_ends_at) return null;
    // `ceil`, not `round`: a countdown should show "1" for the whole of the
    // last second and reach zero only when the time is actually up.
    const msLeft = state.countdown_ends_at * 1000 - now;
    return Math.max(0, Math.ceil(msLeft / 1000));
  }, [state?.phase, state?.countdown_ends_at, now]);

  /* ---------------- sending ---------------- */

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Not connected to the auction room.");
      return;
    }
    socket.send(JSON.stringify(payload));
  }, []);

  const claimSeat = useCallback(
    (request: SeatRequest) => {
      seatRequest.current = request;
      send({
        type: "join",
        role: request.role,
        team_id: request.teamId ?? null,
        display_name: request.displayName ?? null,
      });
    },
    [send],
  );

  const bid = useCallback(
    (amount?: number) => {
      // The version is attached here rather than by the caller, so no call site
      // can forget it and quietly reintroduce the race.
      send({
        type: "bid",
        amount: amount ?? null,
        lot_version: lotVersion.current,
      });
    },
    [send],
  );

  const actions = useMemo(
    () => ({
      openWaitingRoom: (seconds = 600) =>
        send({ type: "open_waiting_room", countdown_seconds: seconds }),
      startAuction: () => send({ type: "start_auction" }),
      putUp: (playerId: number) => send({ type: "put_up", player_id: playerId }),
      sell: () => send({ type: "sell" }),
      markUnsold: () => send({ type: "unsold" }),
      undo: () => send({ type: "undo" }),
      finish: () => send({ type: "finish" }),
      resetRoom: () => send({ type: "reset" }),
      withdraw: () => send({ type: "withdraw" }),
      callTimeout: () => send({ type: "timeout" }),
    }),
    [send],
  );

  /* ---------------- derived ---------------- */

  const myTeam = useMemo(
    () =>
      state && seat?.team_id != null
        ? (state.teams.find((team) => team.id === seat.team_id) ?? null)
        : null,
    [state, seat?.team_id],
  );

  const isWinning = !!(
    state?.lot &&
    seat?.team_id != null &&
    state.lot.bidder_id === seat.team_id
  );

  /* ---------------- the clock ----------------
     Packaged, not ticked. Counting down here would re-render every consumer of
     this hook ten times a second during the tensest part of a lot; the display
     component owns its own tick and this only tells it where to start. */

  const lotClock = useMemo<LotClock | null>(() => {
    const lot = state?.lot;
    if (!lot?.clock || lot.ends_in == null || !state) return null;
    const total =
      lot.clock === "opening"
        ? state.rules.open_seconds
        : lot.clock === "timeout"
          ? state.rules.timeout_seconds
          : state.rules.close_seconds;
    return {
      kind: lot.clock,
      endsIn: lot.ends_in,
      total: total || 7,
      // Deadline is in the key, so re-arming the same kind of buffer still
      // reads as a new clock and restarts the dial.
      key: `${lot.player_id}:${lot.clock}:${lot.deadline}`,
    };
  }, [state]);

  const myTeamId = seat?.team_id ?? null;
  const timeoutsLeft = myTeam?.timeouts_left ?? 0;
  const live = state?.phase === "live";
  const connected = status === "open" && seat !== null;

  const amContending = !!(
    state?.lot &&
    myTeamId != null &&
    (state.lot.contenders ?? []).includes(myTeamId)
  );

  // You may not withdraw from your own standing bid: that is retracting an
  // offer, not declining a player, and the ladder underneath it was built on
  // the assumption it stands.
  const canWithdraw = !!(
    connected && live && amContending && state?.lot?.bidder_id !== myTeamId
  );

  // A timeout answers a bid, so it needs one to answer -- and the franchise
  // holding it cannot call one on itself.
  const canCallTimeout = !!(
    connected &&
    live &&
    state?.lot?.clock === "closing" &&
    state.lot.bidder_id !== myTeamId &&
    timeoutsLeft > 0
  );

  return {
    status,
    state,
    seat,
    error,
    dismissError: useCallback(() => setError(null), []),
    secondsLeft,
    claimSeat,
    bid,
    ...actions,
    myTeam,
    isWinning,
    canAct: connected,
    lotClock,
    timeoutsLeft,
    amContending,
    canWithdraw,
    canCallTimeout,
  };
}
