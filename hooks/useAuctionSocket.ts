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
  overseas: number;
  max_bid: number;
  connected: boolean;
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
}

export interface LogItem {
  seq: number;
  kind: "note" | "bid" | "sold" | "unsold";
  what: string;
  amount: number | null;
  ts: number;
}

export interface RoomState {
  version: number;
  phase: Phase;
  rules: { purse: number; max_squad: number; min_squad: number; max_overseas: number };
  teams: TeamState[];
  lot: LotState | null;
  log: LogItem[];
  counts: { available: number; sold: number; unsold: number; spent: number };
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
 * Same dev/production split as `ragClient`, in websocket terms.
 *
 * In production the console is served by the same FastAPI app, so the socket
 * is same-origin and the scheme simply follows the page's. In dev the console
 * is on Vite's 5173 and the backend on 8001, which is the only case that needs
 * an absolute origin.
 */
function socketUrl(): string {
  const override = import.meta.env?.VITE_AUCTION_WS as string | undefined;
  if (override) return override;

  if (import.meta.env?.DEV) return "ws://localhost:8001/api/v1/auction/ws";

  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/v1/auction/ws`;
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

  /** Convenience readings derived from `state` and `seat`. */
  myTeam: TeamState | null;
  isWinning: boolean;
  canAct: boolean;
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
    canAct: status === "open" && seat !== null,
  };
}
