"""
squad.py
One franchise's squad, as its bidder keeps track of it: the "My Squad" panel.

Organised the way AUCTEAM sheets a side -- Batters, Wicketkeeper, All-Rounders,
Bowlers (aucteam/aucteam_schema.py ROLE_BANDS) -- and measured against two
things a bidder is managing at once:

    the auction's rules    purse, squad size, overseas and uncapped minimums
                           and maximums, exactly as the room enforces them
    a playing XI           whether the squad can already field AUCTEAM's XI
                           (3-5 batters, 1-2 keepers, 1-3 all-rounders, 3-5
                           bowlers), and which positions it is still short of

Each buy carries its price, base and the room's verdict on it, from the same
valuation the leaderboard uses (leaderboard.valuer), so My Squad, the board
and the AI auctioneer never disagree about a deal.

Public data: a sale is announced to the whole room, so a squad holds nothing
its rivals have not already seen.
"""
from __future__ import annotations

from typing import Any

from auction import leaderboard, report_card
from aucteam.aucteam_schema import ROLE_BANDS

#: AUCTEAM's position codes and names, in its team-sheet order.
ORDER = ("BAT", "WK", "AR", "BWL")
NAMES = {"BAT": "Batters", "WK": "Wicketkeeper", "AR": "All-Rounders", "BWL": "Bowlers"}
XI = 11


def position(role_short: str) -> str:
    """The room's role code as AUCTEAM's: the room says BOWL, AUCTEAM says BWL."""
    return "BWL" if role_short == "BOWL" else role_short


def squad_for(room: Any, team_id: int) -> dict[str, Any] | None:
    team = room.team_by_id(team_id)
    if team is None:
        return None
    rules = room.rules
    _, expected_of = leaderboard.valuer(room)
    summary = room.summary_for(team_id)

    groups: dict[str, list[dict[str, Any]]] = {code: [] for code in ORDER}
    value = 0
    for pid, rec in leaderboard.sold_records(room):
        if rec.team_id != team_id:
            continue
        player = room.players[pid]
        price = int(rec.price)
        expected = expected_of(player)
        verdict = report_card._verdict(price / expected) if expected else None
        if expected:
            value += round(expected - price)
        groups[position(player.role_short)].append({
            "id": pid,
            "name": player.name,
            "role": player.role,
            "country": player.country,
            "overseas": player.overseas,
            "uncapped": player.uncapped,
            "rating": player.rating,
            "base": player.base,
            "price": price,
            "expected": round(expected) if expected else None,
            "verdict": verdict,
            "seq": rec.seq,
        })
    for players in groups.values():
        players.sort(key=lambda p: -p["price"])

    buys = [p for players in groups.values() for p in players]
    latest = max(buys, key=lambda p: p["seq"] or 0) if buys else None
    xi = []
    for code in ORDER:
        low, high = ROLE_BANDS[code]
        have = len(groups[code])
        xi.append({"role": code, "name": NAMES[code], "have": have, "min": low, "max": high, "short": max(0, low - have)})
    xi_short = sum(row["short"] for row in xi)

    return {
        "team": {"id": team["id"], "code": team["code"], "name": team["name"], "color": team.get("color")},
        "groups": [{"role": code, "name": NAMES[code], "players": groups[code]} for code in ORDER],
        "budget": {
            "purse": rules["purse"],
            "spent": summary["spent"],
            "left": summary["left"],
            "avg_price": round(summary["spent"] / len(buys)) if buys else 0,
            "value": value,
        },
        "limits": {
            "size": summary["size"], "max_squad": rules["max_squad"], "min_squad": rules["min_squad"],
            "overseas": summary["overseas"], "max_overseas": rules["max_overseas"], "min_overseas": rules["min_overseas"],
            "uncapped": summary["uncapped"], "min_uncapped": rules.get("min_uncapped", 0),
        },
        "needs": {
            "to_min_squad": max(0, rules["min_squad"] - summary["size"]),
            "overseas": summary["overseas_needed"],
            "uncapped": summary["uncapped_needed"],
            "places_left": max(0, rules["max_squad"] - summary["size"]),
        },
        "xi": {"positions": xi, "short": xi_short, "ready": xi_short == 0 and len(buys) >= XI},
        "latest": latest,
    }
