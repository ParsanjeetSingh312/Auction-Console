"""
news_desk.py
SCOUT's answer to "Arshdeep Singh has been traded to which team before IPL
2027?" and "why did Nathan Ellis miss IPL 2026?".

Questions about trades, moves and availability are not shortlist searches, so
they do not go through the advisor's candidate machinery. They are answered
from two kinds of record, both ingested rather than searched for:

  * the player-news ledger (scout/news.py) -- sourced records of trades,
    retentions, releases, injuries and withdrawals;
  * what the ball-by-ball archive itself shows -- which franchise a player
    turned out for each season, and seasons he did not appear in.

**The archive can show that something happened, never why.** A player with no
IPL 2026 appearance missed the season; whether it was an injury, national duty
or a squad decision is news, and only the ledger can say which. The answer
keeps the two apart, and when the ledger has nothing it says so rather than
letting a model supply a reason from memory.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from scout.schemas.queries import AdvisorRecommendation, Candidate, Engine, TeamContext

logger = logging.getLogger(__name__)

_SYSTEM = """You are SCOUT, an IPL assistant, answering a question about player news:
a trade, a transfer, a retention or release, an injury, or whether a player is
available. You answer with JSON only: {"answer": "<your answer>"}.

Rules you must not break:
- Use ONLY the RECORDS below. They are SCOUT's ingested news ledger (each with
  its source) and what the IPL ball-by-ball archive shows. You have no other
  knowledge of trades or injuries; anything else you write is a fabrication.
- Lead with the direct answer in one sentence, then the supporting detail.
  Name the source and date of any news record you rely on.
- The archive shows WHERE a player played and WHICH seasons he missed, never
  WHY. Never give a reason for an absence unless a news record states it.
- If the records do not answer the question, say plainly that SCOUT has no
  recorded update on it, then say what the data does show (last IPL season,
  franchise) in one sentence.
- This is a conversation: use earlier turns to resolve "he", "they", "that
  trade", but answer the new question.
- Keep it under 90 words."""


def _pool_rows(ids: list[int]) -> dict[int, dict[str, Any]]:
    if not ids:
        return {}
    from db import get_player_db

    marks = ",".join("?" for _ in ids)
    rows = get_player_db().execute_query(
        f"SELECT id, player_name, role FROM players WHERE id IN ({marks})", tuple(ids)
    )
    return {int(r["id"]): dict(r) for r in rows}


def _records(question: str, subjects: list[dict[str, Any]], knowledge: str | None):
    """The news items and the archive facts this answer may use."""
    from scout import knowledge as kb
    from scout import news

    items = news.load_news()
    names = [s["name"] for s in subjects] + news.names_in_question(question, items)
    ids = [int(s["id"]) for s in subjects]
    found = news.items_for(names, ids, items)

    season = news.season_in(question)
    if season:
        # Prefer records for the season asked about, but keep the rest: a
        # trade "before IPL 2027" may be filed under 2027 or carry no season.
        found = sorted(found, key=lambda i: i.season != season)

    archive: list[str] = []
    for subject in subjects:
        record = kb.player_record(int(subject["id"]))
        if not record:
            archive.append(f"{subject['name']}: no IPL appearances in the ingested archive.")
            continue
        last = record.get("last_season")
        archive.append(
            f"{subject['name']}: last IPL appearance {last} for {record.get('last_team')}; "
            f"franchises {'; '.join(record.get('franchises') or [])}."
        )
        archive.extend(record.get("events") or [])
    return found, archive, names


def _deterministic_answer(question: str, items, archive: list[str], names: list[str]) -> str:
    who = ", ".join(dict.fromkeys(names)) or "that player"
    if items:
        lead = items[0]
        text = lead.headline()
        extra = [i.headline() for i in items[1:3]]
        return text + ("\n" + "\n".join(extra) if extra else "")
    base = (
        f"SCOUT has no recorded trade, injury or availability update for {who} in its "
        "news ledger, so it cannot say what happened."
    )
    if archive:
        base += " What the IPL data shows: " + " ".join(archive[:2])
    return base


def _cards(subjects: list[dict[str, Any]], items, team: TeamContext | None) -> list[Candidate]:
    """One card per pool player the answer is about, citing its records."""
    from scout import knowledge as kb

    rows = _pool_rows([int(s["id"]) for s in subjects])
    cards: list[Candidate] = []
    for subject in subjects[:3]:
        row = rows.get(int(subject["id"]))
        if row is None:
            continue
        mine = [i for i in items if i.player_id == row["id"] or i.player_name == row["player_name"]]
        record = kb.player_record(int(row["id"])) or {}
        evidence = [i.headline()[:200] for i in mine[:3]]
        if record.get("seasons"):
            evidence.append(record["seasons"][0][:200])
        if record.get("franchises"):
            evidence.append("Franchises: " + "; ".join(record["franchises"])[:200])
        if not evidence:
            continue
        risks = [
            i.summary[:200] for i in mine
            if i.kind in ("injury", "ruled_out", "withdrawn", "unavailable", "suspension")
        ][:3]
        rationale = (
            mine[0].summary if mine
            else f"No news recorded for {row['player_name']}; the IPL archive record is below."
        )
        try:
            cards.append(Candidate(
                player_id=int(row["id"]), player_name=row["player_name"], role=row["role"],
                rationale=rationale[:600] if len(rationale) >= 10 else rationale + " (from the ledger)",
                evidence=evidence[:8], risks=risks,
            ))
        except Exception as exc:  # noqa: BLE001 - a card is a courtesy, not the answer
            logger.debug("news card for %s skipped: %s", row["player_name"], exc)
    return cards


async def answer_news(
    question: str,
    *,
    subjects: list[dict[str, Any]],
    knowledge: str | None,
    history: list[dict[str, str]],
    memory_summary: str | None,
    team: TeamContext | None,
    timeout: float = 30.0,
) -> AdvisorRecommendation:
    """A trade or availability question, answered from the records."""
    from rag import llm_provider
    from scout.knowledge import training_brief

    items, archive, names = await asyncio.to_thread(_records, question, subjects, knowledge)
    notes: list[str] = []
    if not items:
        notes.append("No news record matched this question.")

    records = ["NEWS LEDGER:"] + ([f"- {i.headline()}" for i in items[:8]] or ["- (no matching records)"])
    records += ["", "IPL ARCHIVE:"] + ([f"- {a}" for a in archive[:10]] or ["- (no players resolved)"])
    if knowledge:
        records += ["", "OTHER TRAINED KNOWLEDGE:", knowledge[:1500]]

    system = _SYSTEM
    brief = training_brief()
    if brief:
        system += "\n\n" + brief
    if memory_summary:
        system += "\n\nEARLIER IN THIS CONVERSATION (compacted notes):\n" + memory_summary

    prompt = "RECORDS:\n" + "\n".join(records) + f"\n\nQUESTION: {question}"
    answered_by: list[Engine] = []
    answer: str | None = None
    engine: Engine = "local_analyst"
    if llm_provider.available():
        try:
            raw = await asyncio.to_thread(
                llm_provider.complete,
                system, [*history, {"role": "user", "content": prompt}],
                task="rag", temperature=0.1, max_tokens=500, timeout=timeout,
                json_object=True, on_answer=answered_by.append,
            )
            match = re.search(r"\{.*\}", raw or "", re.DOTALL)
            parsed = json.loads(match.group(0)) if match else {}
            answer = str(parsed.get("answer") or "").strip() or None
            if answer:
                engine = answered_by[0] if answered_by else llm_provider.active_provider()  # type: ignore[assignment]
        except Exception as exc:  # noqa: BLE001 - the records answer on their own
            logger.warning("news answer by model failed: %s", exc)
            notes.append(f"The model did not answer ({type(exc).__name__}); answered from the records.")

    if not answer:
        answer = _deterministic_answer(question, items, archive, names)

    return AdvisorRecommendation(
        answer=answer[:4000],
        candidates=await asyncio.to_thread(_cards, subjects, items, team),
        engine_used=engine,
        notes=notes[:12],
        max_bid_lakh=team.max_bid_lakh if team else None,
    )
