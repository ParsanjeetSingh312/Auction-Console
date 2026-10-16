"""
loadtest_auction.py
Traffic for the live auction: real WebSocket clients, bidding like people.

Not a pytest file. It drives a running server over the network, the way the
browsers do, so what it measures is the whole path -- socket, validation, the
room's lock, the broadcast -- and not the room object on its own (that is what
test_phase1_concurrency.py is for).

Each simulated auction is one room: an auctioneer who puts players up and
brings the hammer down when the bidding stops, and one franchise per team, each
with a private valuation of every lot, bidding after a human reaction delay
whenever it is not already the leader and the price is still under what it
thinks the player is worth.

Measured, per scenario:
  * bid -> confirmation: how long the bidder waits to see its own bid as the
    leading bid in a broadcast;
  * bid -> whole room: how long until every client in the room has seen it
    (the number that decides whether a rival can respond in time);
  * refused joins, errors by kind, dropped sockets, frames and bytes.

Usage (against a local server; never point this at production unannounced):

    AUCTIONEER_PASSWORD=... python security/loadtest_auction.py \
        --base http://127.0.0.1:8011 --mega 2 --mini 4 --lots 8

    # find the ceiling: run 6, 12, 24 ... rooms in turn
    ... --ramp 6,12,24,48 --lots 5

`--rooms-param` sends each auction to its own room (?room=<code>). Without it
every simulated auction dials the same socket, which is how the server behaved
before it had rooms.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import statistics
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from auction.rules import MARQUEE_PLAYERS  # skip the 9-second reveal holds
except Exception:  # noqa: BLE001
    MARQUEE_PLAYERS = ()


# --------------------------------------------------------------- stats --


@dataclass
class Stats:
    bids_sent: int = 0
    bids_confirmed: int = 0
    ack_ms: list[float] = field(default_factory=list)
    fanout_ms: list[float] = field(default_factory=list)
    errors: Counter = field(default_factory=Counter)
    join_refusals: Counter = field(default_factory=Counter)
    joined: Counter = field(default_factory=Counter)
    dropped: int = 0
    connect_failures: Counter = field(default_factory=Counter)
    frames: int = 0
    bytes: int = 0
    lots_settled: int = 0
    lot_seconds: list[float] = field(default_factory=list)


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    values = sorted(values)
    k = min(len(values) - 1, max(0, round(p / 100 * (len(values) - 1))))
    return values[k]


# ---------------------------------------------------------------- room --


class Room:
    """One simulated auction: what its clients share."""

    def __init__(self, code: str, kind: str, teams: int, ws_url: str, stats: Stats) -> None:
        self.code = code
        self.kind = kind
        self.teams = teams
        self.ws_url = ws_url
        self.stats = stats
        # (player_id, amount) -> monotonic time the bid was sent.
        self.sent: dict[tuple[int, int], float] = {}
        self.sent_by: dict[tuple[int, int], str] = {}
        # Which clients have already seen each bid.
        self.seen: dict[tuple[int, int], set[str]] = {}
        self.members: set[str] = set()
        self.last_bid_at = 0.0
        self.done = asyncio.Event()

    def observe(self, who: str, state: dict[str, Any]) -> None:
        lot = state.get("lot")
        if not lot or lot.get("bidder_id") is None:
            return
        key = (lot["player_id"], lot["bid"])
        t0 = self.sent.get(key)
        if t0 is None:
            return
        seen = self.seen.setdefault(key, set())
        if who in seen:
            return
        seen.add(who)
        ms = (time.perf_counter() - t0) * 1000
        self.stats.fanout_ms.append(ms)
        if self.sent_by.get(key) == who:
            self.stats.ack_ms.append(ms)
            self.stats.bids_confirmed += 1


async def connect(room: Room, who: str):
    try:
        return await websockets.connect(room.ws_url, open_timeout=15, max_size=2**22, ping_interval=20)
    except Exception as exc:  # noqa: BLE001
        room.stats.connect_failures[type(exc).__name__ + ": " + str(exc)[:60]] += 1
        return None


async def frames(ws, room: Room):
    """Yield parsed frames, counting them."""
    async for raw in ws:
        room.stats.frames += 1
        room.stats.bytes += len(raw)
        yield json.loads(raw)


# ----------------------------------------------------------- franchise --


async def franchise(room: Room, team_id: int, delay: tuple[float, float], appetite: float) -> None:
    who = f"{room.code}/t{team_id}"
    ws = await connect(room, who)
    if ws is None:
        return
    room.members.add(who)
    rnd = random.Random(hash(who))
    valuations: dict[int, int] = {}
    pending: asyncio.Task | None = None
    latest: dict[str, Any] = {}

    async def bid_later(player_id: int, version: int, amount: int) -> None:
        await asyncio.sleep(rnd.uniform(*delay))
        lot = latest.get("lot") or {}
        # A person looks again before clicking: only bid if nothing moved.
        if lot.get("player_id") != player_id or lot.get("version") != version:
            return
        if (player_id, amount) not in room.sent:
            room.sent[(player_id, amount)] = time.perf_counter()
            room.sent_by[(player_id, amount)] = who
        room.last_bid_at = time.perf_counter()
        room.stats.bids_sent += 1
        await ws.send(json.dumps({"type": "bid", "amount": amount, "lot_version": version}))

    try:
        await ws.send(json.dumps({"type": "join", "role": "franchise", "team_id": team_id, "display_name": f"Bot {team_id}"}))
        acked = False
        async for msg in frames(ws, room):
            kind = msg.get("type")
            if kind == "joined":
                room.stats.joined["franchise"] += 1
                continue
            if kind == "error":
                about = msg.get("about")
                if about == "join":
                    room.stats.join_refusals[msg.get("message", "")[:70]] += 1
                    break
                room.stats.errors[f"{about}: {msg.get('message', '')[:50]}"] += 1
                continue
            if kind != "state" and "phase" not in msg:
                continue
            latest = msg
            room.observe(who, msg)
            if room.done.is_set():
                break
            if not acked and msg.get("rules_version") is not None:
                acked = True
                await ws.send(json.dumps({"type": "acknowledge_rules", "rules_version": msg["rules_version"]}))
            lot = msg.get("lot")
            if msg.get("phase") != "live" or not lot or lot.get("clock") == "presenting":
                continue
            if lot.get("bidder_id") == team_id:
                continue
            me = next((t for t in msg.get("teams", []) if t.get("id") == team_id), None)
            ask = lot.get("next_ask") or 0
            value = valuations.setdefault(lot["player_id"], int(lot["base"] * rnd.uniform(1.0, appetite)))
            if not me or ask > me.get("max_bid", 0) or ask > value:
                continue
            if pending and not pending.done():
                continue
            pending = asyncio.create_task(bid_later(lot["player_id"], lot["version"], ask))
    except websockets.ConnectionClosed:
        if not room.done.is_set():
            room.stats.dropped += 1
    finally:
        if pending:
            pending.cancel()
        await ws.close()


# ----------------------------------------------------------- auctioneer --


async def auctioneer(room: Room, password: str, pool: list[int], lots: int, hammer: float, settled: asyncio.Event) -> None:
    who = f"{room.code}/auc"
    ws = await connect(room, who)
    if ws is None:
        room.done.set()
        return
    state: dict[str, Any] = {}
    joined = asyncio.Event()
    refused: list[str] = []
    news = asyncio.Event()

    async def reader() -> None:
        nonlocal state
        try:
            async for msg in frames(ws, room):
                if msg.get("type") == "joined":
                    room.stats.joined["auctioneer"] += 1
                    joined.set()
                elif msg.get("type") == "error":
                    if msg.get("about") == "join":
                        refused.append(msg.get("message", ""))
                        joined.set()
                    elif msg.get("about") not in ("put_up", "sell", "unsold"):
                        room.stats.errors[f"auc {msg.get('about')}: {msg.get('message', '')[:50]}"] += 1
                elif "phase" in msg:
                    state = msg
                    room.observe(who, msg)
                    news.set()
        except websockets.ConnectionClosed:
            if not room.done.is_set():
                room.stats.dropped += 1

    task = asyncio.create_task(reader())
    try:
        await ws.send(json.dumps({"type": "join", "role": "auctioneer", "display_name": "Load test", "password": password}))
        await asyncio.wait_for(joined.wait(), 15)
        if refused:
            room.stats.join_refusals["auctioneer: " + refused[0][:60]] += 1
            return
        await asyncio.sleep(2.0)  # let the franchises take their seats
        await ws.send(json.dumps({"type": "start_auction"}))
        rnd = random.Random(room.code)
        candidates = pool[:]
        rnd.shuffle(candidates)
        put = 0
        while put < lots and candidates:
            pid = candidates.pop()
            news.clear()
            await ws.send(json.dumps({"type": "put_up", "player_id": pid}))
            t_open = time.perf_counter()
            room.last_bid_at = t_open
            # Wait for the lot to appear (or be refused: sold elsewhere, etc).
            try:
                await asyncio.wait_for(_until(lambda: (state.get("lot") or {}).get("player_id") == pid, news), 5)
            except asyncio.TimeoutError:
                continue
            put += 1
            # The hammer: `hammer` seconds of quiet after the last bid.
            while True:
                await asyncio.sleep(0.2)
                lot = state.get("lot")
                if not lot or lot.get("player_id") != pid:
                    break  # the room's own clock settled it
                if time.perf_counter() - room.last_bid_at >= hammer:
                    await ws.send(json.dumps({"type": "sell" if lot.get("bidder_id") else "unsold"}))
                    try:
                        await asyncio.wait_for(_until(lambda: (state.get("lot") or {}).get("player_id") != pid, news), 5)
                    except asyncio.TimeoutError:
                        pass
                    break
            room.stats.lots_settled += 1
            room.stats.lot_seconds.append(time.perf_counter() - t_open)
    except (websockets.ConnectionClosed, asyncio.TimeoutError):
        pass
    finally:
        room.done.set()
        settled.set()
        await asyncio.sleep(0.5)
        task.cancel()
        await ws.close()


async def _until(pred, news: asyncio.Event) -> None:
    while not pred():
        news.clear()
        await news.wait()


# ------------------------------------------------------------ scenario --


def server_cpu_seconds(pid: int | None) -> float | None:
    if not pid:
        return None
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {pid}).TotalProcessorTime.TotalSeconds"],
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        return float(out)
    except Exception:  # noqa: BLE001
        return None


async def scenario(args, mega: int, mini: int, label: str) -> dict[str, Any]:
    stats = Stats()
    base = args.base.rstrip("/")
    ws_base = base.replace("http", "ws", 1) + "/api/v1/auction/ws"
    async with httpx.AsyncClient(timeout=60) as http:
        rows = (await http.get(base + "/api/v1/players", params={"limit": 500})).json()["players"]
    marquee = {name.lower() for name in MARQUEE_PLAYERS}
    pool = [r["id"] for r in rows if str(r.get("player_name", "")).lower() not in marquee]

    rooms: list[Room] = []
    # Unique per run *and* per process (--tag), so parallel generators never
    # walk into each other's rooms.
    run = f"{args.tag}{int(time.time()) % 100000}"
    for i in range(mega + mini):
        kind, teams = ("mega", 10) if i < mega else ("mini", 12)
        code = f"LT{run}-{i}"  # a valid room code: letters, digits, dashes
        url = ws_base + (f"?room={code}&kind={kind}" if args.rooms_param else "")
        rooms.append(Room(code, kind, teams, url, stats))

    cpu0 = server_cpu_seconds(args.server_pid)
    t0 = time.perf_counter()
    tasks = []
    for room in rooms:
        settled = asyncio.Event()
        tasks.append(asyncio.create_task(auctioneer(room, args.password, pool, args.lots, args.hammer, settled)))
        for team_id in range(1, room.teams + 1):
            tasks.append(asyncio.create_task(franchise(room, team_id, (args.delay_min, args.delay_max), args.appetite)))
        await asyncio.sleep(args.stagger)
    await asyncio.wait(tasks, timeout=args.timeout)
    for t in tasks:
        t.cancel()
    elapsed = time.perf_counter() - t0
    cpu1 = server_cpu_seconds(args.server_pid)

    clients = sum(r.teams + 1 for r in rooms)
    result = {
        "scenario": label,
        "rooms": len(rooms),
        "mega": mega,
        "mini": mini,
        "clients": clients,
        "seconds": round(elapsed, 1),
        "joined_auctioneers": stats.joined["auctioneer"],
        "joined_franchises": stats.joined["franchise"],
        "join_refusals": dict(stats.join_refusals),
        "connect_failures": dict(stats.connect_failures),
        "lots_settled": stats.lots_settled,
        "bids_sent": stats.bids_sent,
        "bids_per_sec": round(stats.bids_sent / elapsed, 1),
        "bids_won_lead": stats.bids_confirmed,
        "ack_ms": {p: round(pct(stats.ack_ms, p), 1) for p in (50, 95, 99)},
        "room_ms": {p: round(pct(stats.fanout_ms, p), 1) for p in (50, 95, 99)},
        "room_ms_max": round(max(stats.fanout_ms), 1) if stats.fanout_ms else None,
        "frames": stats.frames,
        "mb_out_of_server": round(stats.bytes / 1e6, 2),
        "errors": dict(stats.errors.most_common(8)),
        "dropped": stats.dropped,
        "server_cpu_pct_of_one_core": (
            round((cpu1 - cpu0) / elapsed * 100, 1) if cpu0 is not None and cpu1 is not None else None
        ),
    }
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8011")
    ap.add_argument("--mega", type=int, default=2)
    ap.add_argument("--mini", type=int, default=4)
    ap.add_argument("--ramp", default="", help="comma list of room counts, mixed 1 mega : 2 mini")
    ap.add_argument("--lots", type=int, default=8)
    ap.add_argument("--hammer", type=float, default=1.5, help="seconds of quiet before the auctioneer sells")
    ap.add_argument("--delay-min", type=float, default=0.15)
    ap.add_argument("--delay-max", type=float, default=0.9)
    ap.add_argument("--appetite", type=float, default=6.0, help="max valuation as a multiple of base")
    ap.add_argument("--stagger", type=float, default=0.05, help="seconds between starting rooms")
    ap.add_argument("--tag", default="", help="letters/digits to keep this process's room codes unique")
    ap.add_argument("--timeout", type=float, default=600)
    ap.add_argument("--rooms-param", action="store_true", help="send each auction to its own ?room=")
    ap.add_argument("--server-pid", type=int, default=None)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    args.password = os.environ.get("AUCTIONEER_PASSWORD", "")

    plans = []
    if args.ramp:
        for n in (int(x) for x in args.ramp.split(",")):
            mega = max(1, n // 3)
            plans.append((mega, n - mega, f"{n}rooms"))
    else:
        plans.append((args.mega, args.mini, f"{args.mega}mega+{args.mini}mini"))

    results = []
    for mega, mini, label in plans:
        print(f"\n== {label}: {mega} mega (10 teams) + {mini} mini (12 teams) ==", flush=True)
        r = asyncio.run(scenario(args, mega, mini, label))
        results.append(r)
        print(json.dumps(r, indent=2), flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
