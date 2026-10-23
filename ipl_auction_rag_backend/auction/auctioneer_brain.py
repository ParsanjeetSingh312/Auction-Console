"""
auctioneer_brain.py
What the AI auctioneer knows, and how it says it.

The AI auctioneer is a Senior Auctioneer Analyst for IPL cricket. It is not
SCOUT: SCOUT is a researcher answering questions; this presides over a room,
announcing each lot and calling each result. It draws on three sources:

    its own data     the player database the room was loaded from -- the IPL
                     auction sheet's statistics, base price and rating
    AUCTONIQ report  the report card's value curve (auction/report_card.py):
                     where a player's rating sits in this pool, what that is
                     worth against the purse, calibrated to what this room has
                     actually been paying
    SCOUT            SCOUT's research store and its web search (recent news,
                     form, injuries), through scout/tools/search_engine.py

**Rulings are not the model's.** Whether a sale was a steal or an overpay is
computed here, deterministically, with the report card's own verdict scale;
the model is told the verdict and asked to say it well. Every rule of the room
(purse, squad, overseas) stays in the rules engine. The model only speaks.

**It never holds up the room.** Every source has a short timeout, and every
call has a template fallback, so a slow provider or a missing key costs
eloquence, never the auction. Nothing here runs on the bid path.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import statistics
from typing import Any

from auction import report_card
from config.settings import get_settings

logger = logging.getLogger("auction.brain")

SYSTEM = """You are the AUCTONIQ AI Auctioneer: a Senior Auctioneer Analyst for IPL \
cricket auctions, presiding over a live room of franchises.

How you speak:
- Like a seasoned IPL auctioneer at the podium: crisp, confident, warm, never \
breathless. One or two sentences, at most 40 words.
- Money in rupees crore or lakh exactly as given ("Rs 6.30 Cr"). Franchises by \
the name given. Write AUCTONIQ in capitals.
- Lead with the cricket: his role, then one vivid reason a franchise wants him,
drawn from the numbers given (a strike rate, an economy, a wicket haul). Skip
dull labels such as "capped" unless they matter to the call.

What you must never do:
- Invent a statistic, price, injury or result. Use only the facts provided. If a \
fact is missing, leave it out.
- Change a verdict. When a verdict is given (steal, good bid, fair price, paid \
over), explain it; it is the room's ruling, not yours to make.
- Use betting, gambling or odds language. This is a virtual auction for \
entertainment and analysis.

Reply with the line itself: plain text, no quotes, no labels, no JSON.

The examples below show the voice only. The players in them are fictional:
never reuse their names, numbers or wording.
Announcing: On the block: Arjun Mehra, a left-arm quick who owns the powerplay. 61 wickets at 7.1 an over. Base Rs 1.50 Cr.
Calling a sale (verdict "fair price"): Sold to Chennai for Rs 7.25 Cr. A fair price: proven new-ball wickets cost this much in any room.
Calling a pass: Unsold at Rs 50 L. No franchise moved for him this time."""


# ------------------------------------------------------------- the data --


class PoolRows:
    """The players table, read once per room and kept: a pool is a few hundred rows."""

    def __init__(self) -> None:
        self._rows: dict[int, dict[str, Any]] | None = None

    def get(self, player_id: int) -> dict[str, Any] | None:
        if self._rows is None:
            try:
                from db import get_player_db

                rows = get_player_db().get_all_players(limit=10_000, offset=0)
                self._rows = {int(r["id"]): r for r in rows if r.get("id") is not None}
            except Exception as exc:  # noqa: BLE001 - the room still has the essentials
                logger.warning("auctioneer could not read the player table: %s", exc)
                self._rows = {}
        return self._rows.get(player_id)


def dossier(room: Any, rows: PoolRows, player_id: int) -> str:
    """The player as a few facts a model can read. Never "None"."""
    row = rows.get(player_id)
    if row is not None:
        try:
            from scout.tools.search_engine import _describe

            return _describe(row)
        except Exception:  # noqa: BLE001 - fall back to what the room knows
            pass
    player = room.players[player_id]
    bits = [f"{player.name}", player.role]
    if player.country:
        bits.append(player.country)
    if player.overseas:
        bits.append("overseas")
    if player.rating is not None:
        bits.append(f"rating {player.rating}")
    bits.append(f"base price {player.base} lakh")
    return ", ".join(bits) + "."


# ------------------------------------------------------ the AUCTONIQ report --


def valuation(room: Any, player_id: int) -> dict[str, Any]:
    """
    What the report card's curve says this player is worth in this room: his
    rating's percentile in the pool, against the purse, calibrated on every
    sale the room has made so far. `expected` in lakh, or None without a rating.
    """
    player = room.players[player_id]
    ratings = [float(p.rating) for p in room.players.values() if p.rating is not None]
    if player.rating is None or not ratings:
        return {"expected": None, "percentile": None, "calibrated": False}
    pct = report_card._percentile_map(ratings)
    purse = int(room.rules.get("purse") or 0)
    sales = []
    for pid, record in room.records.items():
        if record.status == "sold" and record.price is not None and pid in room.players:
            other = room.players[pid]
            sales.append((pct.get(float(other.rating), 0.0) if other.rating is not None else 0.0, other.base, int(record.price)))
    factor, calibrated = report_card._calibration(sales, purse)
    rating_pct = pct.get(float(player.rating), 0.0)
    expected = max(1.0, report_card._curve_expected(rating_pct, player.base, purse) * factor)
    return {"expected": round(expected), "percentile": round(rating_pct * 100), "calibrated": calibrated}


def verdict(price: int, expected: float | None) -> str | None:
    """The room's ruling on a sale, on the report card's own scale."""
    if not expected:
        return None
    return report_card._verdict(price / expected)


# ----------------------------------------------------------------- SCOUT --


async def scout_notes(name: str) -> list[str]:
    """
    What SCOUT can add about a player: its research store first, then recent
    news from its web search. Short, best-effort, and bounded in time.
    """
    settings = get_settings()
    notes: list[str] = []
    try:
        from scout.tools import search_engine

        async def research() -> None:
            refs = await asyncio.to_thread(search_engine.semantic, name, n_results=3, include_research=True)
            for ref in refs:
                if getattr(ref, "from_research", False) and ref.text:
                    notes.append(ref.text[:280])

        async def news() -> None:
            if not settings.AI_AUCTIONEER_WEB_SEARCH or not search_engine.search_available():
                return
            refs, _ = await search_engine.web_search(
                f"{name} IPL form injury", max_results=3, timeout=3.5,
                topic="news", days=60,
            )
            notes.extend(ref.text[:280] for ref in refs[:2])

        # Tighter than a model call: the announcement should land while the
        # lot's seven-second opening clock is still running.
        await asyncio.wait_for(
            asyncio.gather(research(), news(), return_exceptions=True),
            timeout=min(3.5, settings.AI_AUCTIONEER_TIMEOUT),
        )
    except Exception as exc:  # noqa: BLE001 - SCOUT is a bonus, never a dependency
        logger.info("auctioneer went without SCOUT for %s: %s", name, exc)
    return notes[:3]


# ---------------------------------------------------------------- speech --


def crore(lakh: float) -> str:
    return f"Rs {lakh / 100:.2f} Cr" if lakh >= 100 else f"Rs {round(lakh)} L"


async def speak(facts: dict[str, Any], fallback: str) -> tuple[str, str]:
    """
    One line for the room, from the model given `facts`, or `fallback` when no
    model answers in time. Returns (line, source): source is "ai" or "template".
    """
    settings = get_settings()
    try:
        from rag import llm_provider

        if not llm_provider.available():
            return fallback, "template"
        reply = await asyncio.wait_for(
            asyncio.to_thread(
                llm_provider.complete,
                SYSTEM,
                [{"role": "user", "content": json.dumps(facts, ensure_ascii=False)}],
                task="rag",
                temperature=0.55,
                # Room for a reasoning model to think before it writes: the
                # line is short, but gpt-oss spends tokens before answering.
                max_tokens=900,
                timeout=settings.AI_AUCTIONEER_TIMEOUT,
            ),
            timeout=settings.AI_AUCTIONEER_TIMEOUT + 1,
        )
        line = clean_line(reply)
        if line:
            return line, "ai"
    except Exception as exc:  # noqa: BLE001 - the template keeps the room talking
        logger.info("auctioneer fell back to a template: %s", exc)
    return fallback, "template"


def clean_line(reply: str) -> str | None:
    """
    The line out of whatever the model sent: plain text as asked, or JSON if
    it insisted, minus quotes and labels. None if nothing usable is left.
    """
    text = (reply or "").strip()
    if text.startswith("{"):
        try:
            text = str(json.loads(text).get("line") or "")
        except ValueError:
            return None
    # Strip leading labels the model echoed from the prompt, in any order:
    # "AUCTONIQ:", "AUCTONIQ Announcing:", "Calling a sale (verdict ...):".
    while True:
        stripped = PROMPT_LABEL.sub("", BRAND.sub("", text, count=1), count=1)
        if stripped == text:
            break
        text = stripped
    text = " ".join(text.strip().strip('"').strip("'").split())
    return text if 0 < len(text) <= 400 else None


#: The brand at the very start, when a label or punctuation follows it.
BRAND = re.compile(
    r"^\s*AUCTONIQ(?:\s+AI\s+Auctioneer)?\s*(?:[:\-\u2013\u2014]\s*|(?=(?:Announcing|Calling|Line)\b))",
    re.IGNORECASE,
)
#: The prompt's own example labels.
PROMPT_LABEL = re.compile(
    r"^\s*(?:Announcing|Calling a sale|Calling a pass|Line)\b[^:]{0,40}:\s*",
    re.IGNORECASE,
)


# --------------------------------------------------- the calls, as facts --


def lot_facts(room: Any, rows: PoolRows, player_id: int, notes: list[str]) -> tuple[dict[str, Any], str]:
    player = room.players[player_id]
    value = valuation(room, player_id)
    facts = {
        "call": "announce the player now on the block",
        "player": dossier(room, rows, player_id),
        "base_price": crore(player.base),
        "pool_percentile": value["percentile"],
        "auctoniq_value": crore(value["expected"]) if value["expected"] else None,
        "scout_notes": notes,
        "franchises_bidding": len(room.teams),
    }
    fallback = f"On the block: {player.name}, {player.role.lower()}. Base {crore(player.base)}."
    if value["expected"] and value["expected"] > player.base * 1.5:
        fallback += f" AUCTONIQ values him near {crore(value['expected'])}."
    return facts, fallback


def sale_facts(room: Any, sale: dict[str, Any]) -> tuple[dict[str, Any], str, str | None]:
    value = valuation(room, sale["player_id"])
    ruling = verdict(sale["price"], value["expected"])
    facts = {
        "call": "announce the sale and explain the verdict",
        "player": sale["player"],
        "franchise": sale["team"],
        "price": crore(sale["price"]),
        "base_price": crore(sale.get("base") or room.players[sale["player_id"]].base),
        "auctoniq_value": crore(value["expected"]) if value["expected"] else None,
        "verdict": ruling,
    }
    fallback = f"Sold to {sale['team']} for {crore(sale['price'])}."
    if ruling:
        fallback += {
            "steal": " A steal against AUCTONIQ's value.",
            "good bid": " A good bid.",
            "fair price": " A fair price.",
            "paid over": " A premium paid.",
        }[ruling]
    return facts, fallback, ruling


def unsold_facts(room: Any, data: dict[str, Any]) -> tuple[dict[str, Any], str]:
    player = room.players.get(data["player_id"])
    facts = {
        "call": "announce that the player went unsold. Give no reason beyond room_reason: "
                "nobody knows why the franchises passed, so do not guess",
        "player": data["player"],
        "role": player.role if player else None,
        "base_price": crore(data["base"]),
        # What the room itself knows, e.g. "no bid in 7s". Nothing else is known.
        "room_reason": data.get("why"),
    }
    return facts, f"{data['player']} goes unsold at {crore(data['base'])}."


def summary_facts(room: Any) -> tuple[dict[str, Any], str]:
    """The closing call: the biggest buy, the best value, the biggest spender."""
    sales = [
        (pid, rec) for pid, rec in room.records.items() if rec.status == "sold" and rec.price is not None
    ]
    if not sales:
        return {"call": "close the auction; nothing was sold"}, "The auction is closed. No players were sold."
    top_pid, top = max(sales, key=lambda kv: kv[1].price)
    spend: dict[int, int] = {}
    for _, rec in sales:
        spend[rec.team_id] = spend.get(rec.team_id, 0) + int(rec.price)
    spender = room.team_by_id(max(spend, key=spend.get)) or {"name": "?"}
    best = None
    for pid, rec in sales:
        expected = valuation(room, pid)["expected"]
        if expected:
            ratio = rec.price / expected
            if best is None or ratio < best[0]:
                best = (ratio, pid, rec)
    facts = {
        "call": "close the auction with a two-sentence summary",
        "players_sold": len(sales),
        "total_spent": crore(sum(int(r.price) for _, r in sales)),
        "biggest_buy": f"{room.players[top_pid].name} to {(room.team_by_id(top.team_id) or {}).get('name')} for {crore(top.price)}",
        "biggest_spender": f"{spender['name']}, {crore(max(spend.values()))}",
        "best_value": (
            f"{room.players[best[1]].name} to {(room.team_by_id(best[2].team_id) or {}).get('name')} for {crore(best[2].price)}"
            if best else None
        ),
        "median_price": crore(statistics.median(int(r.price) for _, r in sales)),
    }
    fallback = (
        f"The auction is closed: {len(sales)} players sold for {facts['total_spent']}. "
        f"Biggest buy: {facts['biggest_buy']}."
    )
    return facts, fallback
