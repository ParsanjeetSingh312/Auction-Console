"""
knowledge_context.py
The Data Researcher's per-question pass: what SCOUT's trained knowledge says
about this question.

It replaces the live web pass (`live_context.py`, Tavily). SCOUT now answers
from the data the site ingests, so this node does not leave the machine: it
reads the knowledge file and the knowledge collection that `scout.knowledge`
builds after every ingest, and hands the advisor a block of plain text.

**Exact first, semantic second.** For the players a question is about --
named in it, or carried over from the conversation -- the season lines,
franchise history, archive events and news are read by id, exactly; a vector
search has no business guessing which "Sharma" a follow-up meant. Only a
question about nobody in particular ("who won IPL 2025?", "who led the wicket
charts last season?") goes to the collection by similarity, gated the same way
the pool search is.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from config.settings import get_settings

logger = logging.getLogger(__name__)

#: Players a context block will describe in full. More than this and the
#: block crowds out the candidate rows it exists to support.
MAX_SUBJECTS = 5

#: Ceiling on the assembled block, in characters.
CONTEXT_CHARS = 3600


def _player_block(subject: dict[str, Any], news_lines: list[str]) -> str | None:
    from scout import knowledge

    record = knowledge.player_record(int(subject["id"]))
    lines: list[str] = []
    if record:
        lines.append(f"{subject['name']}:")
        if record.get("seasons"):
            lines.append("  Seasons: " + " ".join(record["seasons"][:4]))
        if record.get("franchises"):
            lines.append("  Franchises: " + "; ".join(record["franchises"]))
        for event in record.get("events") or []:
            lines.append("  Archive: " + event)
    elif news_lines:
        lines.append(f"{subject['name']}: no IPL season lines in the ingested archive.")
    for line in news_lines:
        lines.append("  News: " + line)
    return "\n".join(lines) if lines else None


def gather(question: str, subjects: list[dict[str, Any]], *, intent: str) -> tuple[str | None, list[str]]:
    """The knowledge block for one question, and notes on what was used."""
    from scout import knowledge, news

    notes: list[str] = []
    if not knowledge.status().get("trained"):
        notes.append("SCOUT has not been trained on the ingested data yet; answering from the pool alone.")

    items = news.load_news()
    blocks: list[str] = []

    # --- the players the question is about --------------------------------
    for subject in subjects[:MAX_SUBJECTS]:
        lines = [i.headline() for i in news.items_for([subject["name"]], [int(subject["id"])], items)[:4]]
        block = _player_block(subject, lines)
        if block:
            blocks.append(block)

    # --- news about players outside the pool -------------------------------
    pool_names = {s["name"] for s in subjects}
    outside = [n for n in news.names_in_question(question, items) if n not in pool_names]
    for name in outside[:MAX_SUBJECTS]:
        lines = [i.headline() for i in news.items_for([name], [], items)[:4]]
        if lines:
            blocks.append(f"{name} (not in the auction pool):\n" + "\n".join("  News: " + ln for ln in lines))

    # --- a season the question names -----------------------------------------
    year = news.season_in(question)
    if year:
        summary = knowledge.season_summary(year)
        if summary:
            leaders = summary.get("leaders") or {}
            blocks.append(
                f"IPL {year}: "
                + (f"champion {summary['champion']} (runner-up {summary.get('runner_up')}). "
                   if summary.get("champion") else "")
                + "Most runs: " + "; ".join(leaders.get("runs") or []) + ". "
                + "Most wickets: " + "; ".join(leaders.get("wickets") or []) + "."
            )
        elif intent != "news":
            notes.append(f"The ingested archive has no IPL {year} season.")

    # --- nobody in particular: the collection, by similarity ----------------
    if not subjects and not outside and intent != "research":
        try:
            found = knowledge.semantic(question, n_results=6)
        except Exception as exc:  # noqa: BLE001 - an unreadable collection is no context
            logger.warning("knowledge search failed: %s", exc)
            found = []
        if found:
            floor = get_settings().SCOUT_MIN_SIMILARITY
            best = max(score for _, _, score in found)
            kept = [text for text, _, score in found if score >= max(floor, best - 0.08)]
            # A season the question already named is in the block above.
            kept = [t for t in kept if not (year and t.startswith(f"IPL {year} season summary"))]
            blocks.extend(kept[:4])

    if not blocks:
        return None, notes
    text = "\n".join(blocks)
    if len(text) > CONTEXT_CHARS:
        text = text[:CONTEXT_CHARS].rsplit("\n", 1)[0]
    notes.append("Read SCOUT's trained IPL knowledge for this question.")
    return text, notes


async def knowledge_context_node(state) -> dict:
    """The researcher's advise/news turn: one read of the trained knowledge."""
    question = state.get("question", "")
    subjects = list(state.get("subjects") or [])
    try:
        text, notes = await asyncio.wait_for(
            asyncio.to_thread(gather, question, subjects, intent=state.get("intent") or "advise"),
            timeout=max(2.0, get_settings().SCOUT_LIVE_CONTEXT_TIMEOUT),
        )
    except asyncio.TimeoutError:
        return {"notes": ["Reading the trained knowledge took too long; answering from the pool."]}
    except Exception as exc:  # noqa: BLE001 - a researcher that throws takes the turn with it
        logger.warning("knowledge context failed: %s", exc)
        return {"notes": [f"Could not read the trained knowledge ({type(exc).__name__})."]}
    return {"research_context": text, "notes": notes}


def latest_season_line(player_id: int | None) -> str | None:
    """The newest season line SCOUT holds for a pool player, for candidate rows."""
    if player_id is None:
        return None
    from scout import knowledge

    record = knowledge.player_record(int(player_id))
    seasons = (record or {}).get("seasons") or []
    return re.sub(r"\s+", " ", seasons[0]) if seasons else None
