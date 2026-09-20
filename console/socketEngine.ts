/**
 * socketEngine.ts
 * The live room, wearing the console's interface.
 *
 * `BlockPanel`, `TeamsView`, `PoolTable`, `TeamBudgetGrid` and `LedgerPanel`
 * are good components and there are about two thousand lines of them. They all
 * speak `AuctionEngine`. The room speaks JSON over a socket. Rather than write
 * a second set of views for the room — which would mean every future fix had to
 * be made twice, and the two would drift within a week — this adapts one shape
 * into the other.
 *
 * It is the same trick as `readOnlyEngine`, aimed the other way: that one seals
 * the write half, this one redirects it. A view calling `engine.putOnBlock(12)`
 * here does not mutate anything locally; it sends `put_up` and waits for the
 * broadcast. Nothing is applied optimistically, which is the important part —
 * an optimistic client is a client that can show a bid the room rejected.
 *
 * Two halves, two sources:
 *
 *   **The pool** still comes from `useAuctionEngine`, because hydrating 284
 *   players from `GET /api/v1/players` and normalising them is work the room
 *   has no reason to repeat. Only the *auction* half is overridden.
 *
 *   **The auction** comes entirely from the room's broadcast — records, purses,
 *   the block, the ledger, and what is legal. Every reading below is a
 *   projection of that payload, never a local computation, so this client
 *   cannot disagree with the server about whether a bid was allowed.
 *
 * The one deliberate local computation is `blockedReason`, which is used to
 * disable buttons *before* they are pressed. It mirrors the server's rule, and
 * the server re-checks regardless — so if the two ever disagree, the server
 * wins and the only cost is a button that looked enabled.
 */
import { useMemo } from "react";

import { money } from "./format";
import type {
  AuctionRecord,
  BlockState,
  ConsolePlayer,
  LogEntry,
  Rules,
  RoleShort,
  Team,
  TeamSummary,
} from "./types";
import type { AuctionEngine, IntentResult } from "./useAuctionEngine";
import type { AuctionSocket } from "../hooks/useAuctionSocket";

const AVAILABLE: AuctionRecord = { status: "available", teamId: null, price: null };

/**
 * Intents return immediately and optimistically-successfully.
 *
 * The socket is fire-and-forget: a refusal arrives asynchronously as an `error`
 * frame and is surfaced by the host through `socket.error`, not as the return
 * value of this call. Returning `{ok:true}` here means "sent", not "applied",
 * and the views only use the return value to decide whether to clear a search
 * box — which is harmless to do either way.
 */
const SENT: IntentResult = { ok: true };

function refuse(message: string): IntentResult {
  return { ok: false, message };
}

export function useSocketEngine(
  local: AuctionEngine,
  socket: AuctionSocket,
): AuctionEngine {
  const room = socket.state;

  return useMemo<AuctionEngine>(() => {
    /* ---------------- teams and rules ---------------- */

    const teams: Team[] = (room?.teams ?? []).map((team) => ({
      id: team.id,
      name: team.name,
      code: team.code,
      color: team.color,
    }));

    const rules: Rules = room
      ? {
          purse: room.rules.purse,
          maxSquad: room.rules.max_squad,
          minSquad: room.rules.min_squad,
          maxOverseas: room.rules.max_overseas,
        }
      : local.rules;

    /* ---------------- records ----------------
       Rebuilt from the compact `buys` lists rather than sent per player, so a
       bid costs a few kilobytes on the wire instead of the whole table. */

    const records: Record<number, AuctionRecord> = {};
    for (const team of room?.teams ?? []) {
      // Defensive against a server one version behind the client. A schema
      // skew should cost a missing squad list, not a white screen -- during a
      // live auction the difference between "the purses look empty" and "the
      // page is gone" is the difference between a nuisance and an incident.
      for (const [playerId, price] of team.buys ?? []) {
        records[playerId] = { status: "sold", teamId: team.id, price };
      }
    }
    for (const playerId of room?.unsold ?? []) {
      records[playerId] = { status: "unsold", teamId: null, price: null };
    }

    const recordFor = (id: number): AuctionRecord => records[id] ?? AVAILABLE;

    /* ---------------- squads and summaries ---------------- */

    const byId = new Map(local.players.map((player) => [player.id, player]));

    const summaries: TeamSummary[] = (room?.teams ?? []).map((team) => {
      const squad = (team.buys ?? [])
        .map(([playerId]) => byId.get(playerId))
        .filter((player): player is ConsolePlayer => player !== undefined);

      const composition: Record<RoleShort, number> = { BAT: 0, BOWL: 0, AR: 0, WK: 0 };
      for (const player of squad) composition[player.roleShort] += 1;

      return {
        team: { id: team.id, name: team.name, code: team.code, color: team.color },
        squad,
        spent: team.spent,
        left: team.left,
        overseas: team.overseas,
        maxBid: team.max_bid,
        composition,
        // The room's own count, not `squad.length` — they differ for a moment
        // if the pool has not finished loading, and the room's is the truth.
        size: team.size,
      };
    });

    /* ---------------- the block ---------------- */

    const block: BlockState | null = room?.lot
      ? {
          playerId: room.lot.player_id,
          bid: room.lot.bid,
          bidderId: room.lot.bidder_id,
        }
      : null;

    const activePlayer = block ? (byId.get(block.playerId) ?? null) : null;

    /* ---------------- ledger ----------------
       The room's `what` strings are already written for display; only the
       field names differ. */

    const log: LogEntry[] = (room?.log ?? []).map((item) => ({
      seq: item.seq,
      kind: item.kind,
      what: item.what,
      amount: item.amount,
      ts: item.ts * 1000,
    }));

    /* ---------------- legality ----------------
       A mirror of the server's rule, used only to grey out a control before it
       is pressed. The server re-checks every time and its answer is the one
       that counts. */

    const blockedReason = (
      teamId: number,
      player: ConsolePlayer,
      amount: number,
    ): string | null => {
      const summary = summaries.find((entry) => entry.team.id === teamId);
      if (!summary) return "unknown team";
      if (summary.size >= rules.maxSquad) return `squad full (${rules.maxSquad})`;
      if (player.overseas && summary.overseas >= rules.maxOverseas) {
        return `overseas full (${rules.maxOverseas})`;
      }
      if (amount > summary.maxBid) return `over budget — max ${money(summary.maxBid)}`;
      return null;
    };

    /* ---------------- guards ----------------
       A view can be on screen before the socket is open or a seat is held. The
       refusals below say which, rather than dropping the click silently. */

    const requireLive = (action: string): IntentResult | null => {
      if (!socket.canAct) return refuse(`Not connected — cannot ${action}.`);
      if (room?.phase !== "live") return refuse("The auction is not running.");
      return null;
    };

    return {
      /* ---- pool: straight through from the local hydration ---- */
      players: local.players,
      playerById: local.playerById,
      totalPlayers: local.totalPlayers,
      isLoadingRoster: local.isLoadingRoster,
      rosterError: local.rosterError,
      reloadRoster: local.reloadRoster,

      /* ---- auction: the room's, projected ---- */
      teams: teams.length > 0 ? teams : local.teams,
      rules,
      block,
      activePlayer,
      log,
      recordFor,
      teamById: (id) => teams.find((team) => team.id === id),
      summaries,
      summaryFor: (teamId) => summaries.find((entry) => entry.team.id === teamId),
      blockedReason,
      nextAsk: room?.lot?.next_ask ?? 0,
      counts: room?.counts ?? { available: 0, sold: 0, unsold: 0, spent: 0 },

      /* ---- intents: sent, never applied locally ---- */

      putOnBlock: (playerId) => {
        const blocked = requireLive("put a player up");
        if (blocked) return blocked;
        socket.putUp(playerId);
        return SENT;
      },

      /**
       * Bid for a franchise.
       *
       * The room bids for *the seat that asked*, so `teamId` is only checked
       * here — a franchise console cannot bid on another team's behalf, and
       * saying so locally is clearer than letting the server reject it.
       */
      bidFor: (teamId) => {
        const blocked = requireLive("bid");
        if (blocked) return blocked;
        if (socket.seat?.role !== "franchise") {
          return refuse("Only a franchise can bid. Take a seat first.");
        }
        if (socket.seat.team_id !== teamId) {
          return refuse("You can only bid for your own franchise.");
        }
        socket.bid();
        return SENT;
      },

      /**
       * The auctioneer's manual raise has no equivalent in the room.
       *
       * Deliberately so: raising the ask without a bidder was a single-operator
       * affordance, and in a room with ten live franchises the price moves
       * because someone bid. Refused with the reason rather than silently
       * doing nothing.
       */
      raiseAsk: () =>
        refuse("The ask moves when a franchise bids — there is no manual raise in the room."),

      sell: () => {
        if (!socket.canAct) return refuse("Not connected.");
        socket.sell();
        return SENT;
      },

      pass: () => {
        if (!socket.canAct) return refuse("Not connected.");
        socket.markUnsold();
        return SENT;
      },

      returnToPool: () =>
        refuse("Use undo to reverse a sale in the live room."),

      undo: () => {
        if (!socket.canAct) return refuse("Not connected.");
        socket.undo();
        return SENT;
      },

      // The room keeps its own undo stack; the client cannot see how deep it
      // is, so the control stays available whenever a seat is held and the
      // room answers "nothing to undo" if there is nothing.
      canUndo: socket.seat?.role === "auctioneer",

      setRules: () => {},
      resetAuction: () => {},
    };
  }, [room, local, socket]);
}
