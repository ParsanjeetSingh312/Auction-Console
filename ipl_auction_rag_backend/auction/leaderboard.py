"""
leaderboard.py
Live standings: every franchise's position in the auction, as it happens.

Computed by the server, once per broadcast, so every screen ranks the room
the same way and the figures cannot drift between clients. A pure function of
the room -- records, players, rules -- and cheap: a pool is a few hundred
players and this is one pass over the sales.

Per franchise:

    spent, left, size, overseas, uncapped     against the room's limits
    roles                                     WK / BAT / AR / BOWL counts
    avg_price, top_buy, last_buy              what the money bought
    strength                                  the mean pool percentile of its
                                              buys' ratings, 0-100: how good the
                                              squad is on paper
    value                                     the AUCTONIQ value of its buys
                                              minus what it paid, in lakh: the
                                              report card's curve, calibrated to
                                              this room, so positive is money
                                              saved against the market
    steals                                    buys at a steal on the report
                                              card's own scale
    curve                                     cumulative spend after each of
                                              its buys, in order, for a sparkline

and for the room: totals, the record buy, and the last few sales with the
verdict on each.
"""
from __future__ import annotations

import statistics
from typing import Any, Callable

from auction import report_card

ROLES = ("WK", "BAT", "AR", "BOWL")
RECENT = 6


def sold_records(room: Any) -> list[tuple[int, Any]]:
    return [
        (pid, rec) for pid, rec in room.records.items()
        if rec.status == "sold" and rec.price is not None and pid in room.players
    ]


def valuer(room: Any) -> tuple[Callable[[Any], float | None], Callable[[Any], float | None]]:
    """
    (pct_of, expected_of) for this room: a player's rating percentile in the
    pool, and his AUCTONIQ value in lakh -- the report card's curve against
    the purse, calibrated once on every sale the room has made. Shared by the
    standings and the squads, so a verdict reads the same everywhere.
    """
    purse = int(room.rules.get("purse") or 0)
    ratings = [float(p.rating) for p in room.players.values() if p.rating is not None]
    pct = report_card._percentile_map(ratings) if ratings else {}

    def pct_of(player: Any) -> float | None:
        return pct.get(float(player.rating)) if player.rating is not None else None

    factor, _ = report_card._calibration(
        [(pct_of(room.players[pid]) or 0.0, room.players[pid].base, int(rec.price)) for pid, rec in sold_records(room)],
        purse,
    )

    def expected_of(player: Any) -> float | None:
        p = pct_of(player)
        if p is None:
            return None
        return max(1.0, report_card._curve_expected(p, player.base, purse) * factor)

    return pct_of, expected_of


def standings(room: Any) -> dict[str, Any]:
    purse = int(room.rules.get("purse") or 0)
    pct_of, expected_of = valuer(room)
    sold = sold_records(room)

    teams: dict[int, dict[str, Any]] = {}
    for team in room.teams:
        teams[team["id"]] = {
            "id": team["id"], "code": team["code"], "name": team["name"], "color": team.get("color"),
            "spent": 0, "size": 0, "overseas": 0, "uncapped": 0,
            "roles": {role: 0 for role in ROLES},
            "value": 0, "steals": 0, "top_buy": None, "last_buy": None, "curve": [],
            "_pcts": [],
        }

    recent: list[dict[str, Any]] = []
    for pid, rec in sorted(sold, key=lambda kv: (kv[1].seq or 0)):
        row = teams.get(rec.team_id)
        if row is None:
            continue
        player = room.players[pid]
        price = int(rec.price)
        row["spent"] += price
        row["size"] += 1
        row["overseas"] += 1 if player.overseas else 0
        row["uncapped"] += 1 if player.uncapped else 0
        row["roles"][player.role_short] = row["roles"].get(player.role_short, 0) + 1
        row["curve"].append(row["spent"])
        buy = {"player": player.name, "price": price, "seq": rec.seq}
        row["last_buy"] = buy
        if row["top_buy"] is None or price > row["top_buy"]["price"]:
            row["top_buy"] = buy
        p = pct_of(player)
        if p is not None:
            row["_pcts"].append(p)
        expected = expected_of(player)
        verdict = None
        if expected:
            row["value"] += round(expected - price)
            verdict = report_card._verdict(price / expected)
            if verdict == "steal":
                row["steals"] += 1
        recent.append({
            "player": player.name, "team_code": row["code"], "team": row["name"],
            "price": price, "verdict": verdict, "seq": rec.seq,
        })

    out = []
    for row in teams.values():
        pcts = row.pop("_pcts")
        row["left"] = purse - row["spent"]
        row["avg_price"] = round(row["spent"] / row["size"]) if row["size"] else 0
        row["strength"] = round(statistics.mean(pcts) * 100) if pcts else 0
        out.append(row)

    prices = [int(rec.price) for _, rec in sold]
    record = max(recent, key=lambda s: s["price"]) if recent else None
    unsold = sum(1 for rec in room.records.values() if rec.status == "unsold")
    return {
        "teams": out,
        "room": {
            "sold": len(sold),
            "unsold": unsold,
            "spent": sum(prices),
            "avg_price": round(statistics.mean(prices)) if prices else 0,
            "median_price": round(statistics.median(prices)) if prices else 0,
            "record": record,
        },
        "recent": list(reversed(recent[-RECENT:])),
    }
