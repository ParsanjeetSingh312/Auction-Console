"""
cricket_advisor.py
The node that turns a question into a recommendation a bidder can act on.

Four steps: understand the ask, retrieve, reason, bound. The last one is the
one that matters, and it is the reason this is not just a RAG call with a
cricket prompt.

**The ceiling is enforced, not requested.** `TeamContext.max_bid_lakh` comes
from the room's own `summary_for`, which holds back enough purse to fill a
minimum squad -- a franchise with 12,000 lakh left can legally bid only 11,490.
No prompt reliably respects an arithmetic constraint, so every suggested bid is
clamped against that ceiling in code before the recommendation is built, and
the clamp is reported. `AdvisorRecommendation` then validates the same rule a
second time, so an unclamped number cannot reach a user even by mistake.

**Constraints are parsed by rule first, and by model only if that fails.**
"All-Rounder under 15 Cr with a strike rate above 140" is a regex problem, not
a reasoning problem. Doing it deterministically costs nothing, cannot
hallucinate a filter the user did not ask for, and -- on a free tier of twenty
requests a day -- leaves the quota for the part that actually needs a model.

**Hermes gets first refusal, and is never required.** The advisor asks for it
by name through `prefer="hermes"`. If the teammate's machine is asleep the call
falls through to the local ladder, and if that is exhausted too a deterministic
recommendation is built from the retrieved rows. Each of the three says which
one it was in `engine_used`, because "Hermes 70B recommended this bid" and "a
rule wrote this bid" are different claims and a bidder is entitled to know
which one they are holding.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from config.settings import get_settings
from scout.graph.state import RetrievedRef, ScoutState, seconds_left
from scout.schemas.queries import (
    AdvisorQuery,
    AdvisorRecommendation,
    Candidate,
    Constraints,
    Engine,
    TeamContext,
    crore_to_lakh,
    money_lakh,
)
from scout.tools.search_engine import RetrievalResult, retrieve_for

logger = logging.getLogger(__name__)

#: Role words as they actually appear in questions, mapped to the four values
#: `players.role` holds. Ordered longest-first so "wicket keeper" is not eaten
#: by a "keeper" rule that fires on the second word.
_ROLE_WORDS: tuple[tuple[str, str], ...] = (
    ("all-rounder", "All-Rounder"), ("all rounder", "All-Rounder"),
    ("allrounder", "All-Rounder"), ("all-round", "All-Rounder"),
    ("wicket keeper", "Wicket Keeper"), ("wicket-keeper", "Wicket Keeper"),
    ("wicketkeeper", "Wicket Keeper"), ("keeper", "Wicket Keeper"),
    ("bowler", "Bowler"), ("bowling", "Bowler"),
    ("batter", "Batter"), ("batsman", "Batter"), ("batting", "Batter"),
    ("anchor", "Batter"), ("finisher", "Batter"), ("opener", "Batter"),
)

_NUM = r"(\d+(?:\.\d+)?)"


def parse_constraints(question: str) -> tuple[Constraints, list[str]]:
    """
    A question turned into filters, by rule.

    Returns the constraints and a list of what was recognised, which is what
    lets a user see that "under 15 Cr" became 1,500 lakh rather than 15.
    """
    text = question.lower()
    found: list[str] = []
    fields: dict[str, Any] = {}

    for word, role in _ROLE_WORDS:
        if word in text:
            fields["role"] = role
            found.append(f"role={role}")
            break

    # Crore before lakh: "15 cr" must not be read as the bare number 15.
    crore = re.search(rf"(?:under|below|less than|upto|up to|max)\s*(?:rs\.?\s*)?{_NUM}\s*(?:cr|crore)", text)
    lakh = re.search(rf"(?:under|below|less than|upto|up to|max)\s*(?:rs\.?\s*)?{_NUM}\s*(?:l|lakh|lakhs)", text)
    if crore:
        fields["max_price_lakh"] = crore_to_lakh(float(crore.group(1)))
        found.append(f"max_price={money_lakh(fields['max_price_lakh'])}")
    elif lakh:
        fields["max_price_lakh"] = int(float(lakh.group(1)))
        found.append(f"max_price={money_lakh(fields['max_price_lakh'])}")

    above_crore = re.search(rf"(?:above|over|more than|at least)\s*(?:rs\.?\s*)?{_NUM}\s*(?:cr|crore)", text)
    if above_crore:
        fields["min_price_lakh"] = crore_to_lakh(float(above_crore.group(1)))
        found.append(f"min_price={money_lakh(fields['min_price_lakh'])}")

    for pattern, key, label in (
        (rf"(?:strike rate|sr)\s*(?:of\s*)?(?:above|over|>|greater than|at least)?\s*{_NUM}", "min_bat_sr", "strike rate"),
        (rf"(?:batting average|bat avg|average)\s*(?:of\s*)?(?:above|over|>|at least)?\s*{_NUM}", "min_bat_avg", "batting average"),
        (rf"(?:economy|econ)\s*(?:of\s*)?(?:under|below|<|less than|at most)?\s*{_NUM}", "max_economy", "economy"),
        (rf"rating\s*(?:of\s*)?(?:above|over|>|at least)?\s*{_NUM}", "min_rating", "rating"),
        (rf"{_NUM}\s*\+?\s*rating", "min_rating", "rating"),
        (rf"(?:at least|above|over|more than)\s*{_NUM}\s*wickets", "min_wickets", "wickets"),
        (rf"(?:at least|above|over|more than)\s*{_NUM}\s*matches", "min_matches", "matches"),
    ):
        if key in fields:
            continue
        match = re.search(pattern, text)
        if match:
            fields[key] = float(match.group(1))
            found.append(f"{label}{'<=' if key.startswith('max') else '>='}{match.group(1)}")

    if re.search(r"\boverseas\b|\bforeign\b", text):
        fields["overseas"] = True
        found.append("overseas only")
    elif re.search(r"\bindian\b|\bdomestic\b|\blocal\b", text):
        fields["overseas"] = False
        found.append("Indian only")

    if "uncapped" in text:
        fields["cap_status"] = "UNCAPPED"
        found.append("uncapped")
    elif "capped" in text:
        fields["cap_status"] = "CAPPED"
        found.append("capped")

    try:
        return Constraints(**fields), found
    except Exception as exc:  # noqa: BLE001 - a bound or the price window rejected it
        logger.info("rule-parsed constraints were invalid (%s); ignoring them", exc)
        return Constraints(), []


# ---------------------------------------------------------------------------
# Reasoning
# ---------------------------------------------------------------------------

_SYSTEM = """You are SCOUT, an IPL auction advisor. You answer with JSON only.

Rules you must not break:
- Recommend only players that appear in the CANDIDATES block. Never invent one.
- Every candidate needs `evidence`: the actual figures your rationale rests on.
- `suggested_max_bid_lakh` is in LAKH and must never exceed the stated ceiling.
- If the candidates do not satisfy the question, say so in `answer` and return
  fewer candidates rather than padding the list.
"""


def _context_block(refs: list[RetrievedRef], team: TeamContext | None, limit: int = 12) -> str:
    """The retrieved rows and the team's position, as a model reads them."""
    lines = ["CANDIDATES (recommend only from these):"]
    for ref in refs[:limit]:
        tag = "[research]" if ref.from_research else "[pool]"
        pid = f"id={ref.player_id}" if ref.player_id else "id=unknown"
        lines.append(f"- {tag} {pid} {ref.player_name}: {' '.join(ref.text.split())[:300]}")

    if team:
        lines += [
            "",
            "YOUR TEAM:",
            f"- {team.name} ({team.code})",
            f"- purse left: {money_lakh(team.purse_left_lakh)}",
            f"- MAXIMUM LEGAL BID: {team.max_bid_lakh} lakh ({money_lakh(team.max_bid_lakh)})",
            f"- squad {team.squad_size}/{team.max_squad}, "
            f"overseas {team.overseas_count}/{team.max_overseas}",
        ]
    else:
        lines += ["", "No team context: do not suggest bid amounts."]
    return "\n".join(lines)


def _extract_json(text: str) -> dict[str, Any] | None:
    """
    The JSON object out of whatever a model wrapped it in.

    Fenced blocks and a sentence of preamble are both normal, and neither is
    worth failing a whole recommendation over.
    """
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    start, end = candidate.find("{"), candidate.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(candidate[start : end + 1])
    except json.JSONDecodeError:
        return None


def _clamp(payload: dict[str, Any], team: TeamContext | None, notes: list[str]) -> None:
    """
    Bring every suggested bid inside the ceiling, in place.

    Clamped rather than rejected: one number over the limit should not throw
    away an otherwise sound shortlist, and a bid pinned to the ceiling is the
    right advice anyway. The adjustment is always reported.
    """
    if team is None:
        for candidate in payload.get("candidates") or []:
            candidate.pop("suggested_max_bid_lakh", None)
        return

    for candidate in payload.get("candidates") or []:
        bid = candidate.get("suggested_max_bid_lakh")
        if isinstance(bid, (int, float)) and bid > team.max_bid_lakh:
            notes.append(
                f"{candidate.get('player_name', 'a candidate')}: suggested "
                f"{money_lakh(bid)} was above the {money_lakh(team.max_bid_lakh)} "
                "ceiling and has been reduced to it."
            )
            candidate["suggested_max_bid_lakh"] = team.max_bid_lakh


def _deterministic(
    query: AdvisorQuery, retrieval: RetrievalResult, notes: list[str]
) -> AdvisorRecommendation:
    """
    A recommendation built by rule, when no model will answer.

    The same bargain `local_analyst` already makes for the RAG chain: an answer
    composed from the data, which reads plainly as such. It never invents a
    reason -- the rationale states what matched and nothing more.
    """
    team = query.team
    candidates: list[Candidate] = []

    for ref in retrieval.refs:
        if ref.player_id is None or len(candidates) >= query.constraints.limit:
            continue
        facts = [f.strip() for f in ref.text.split(",") if re.search(r"\d", f)][:4]
        role_match = re.search(r"(All-Rounder|Wicket Keeper|Batter|Bowler)", ref.text)
        try:
            candidates.append(Candidate(
                player_id=ref.player_id,
                player_name=ref.player_name,
                role=role_match.group(1) if role_match else "Batter",  # type: ignore[arg-type]
                rationale=(
                    f"{ref.player_name} satisfies the filters that were understood from "
                    f"your question. No model was available, so this is a data match "
                    f"rather than an assessment."
                ),
                evidence=facts or [f"matched by {ref.scored_by}"],
                suggested_max_bid_lakh=None,
            ))
        except Exception as exc:  # noqa: BLE001 - a bound rejected it
            logger.debug("skipped deterministic candidate %s: %s", ref.player_name, exc)

    return AdvisorRecommendation(
        answer=(
            f"{len(candidates)} player(s) match your question. No language model was "
            "available, so these are ranked by the filters and by similarity, with no "
            "written assessment and no bid guidance."
        ),
        candidates=candidates,
        engine_used="local_analyst",
        notes=notes,
        max_bid_lakh=team.max_bid_lakh if team else None,
    )


def _why(exc: Exception) -> str:
    """
    The part of a validation error a bidder can act on.

    Pydantic ends every message with a docs URL, so taking the last line -- the
    obvious thing -- puts "For further information visit
    https://errors.pydantic.dev/..." in front of the user in place of the
    reason. These notes are shown in the UI, so a dropped candidate has to say
    what was wrong with it.
    """
    lines = [
        line.strip() for line in str(exc).splitlines()
        if line.strip() and "errors.pydantic.dev" not in line
    ]
    if not lines:
        return type(exc).__name__
    # Drop pydantic's "N validation errors for X" header when there is more.
    if len(lines) > 1 and "validation error" in lines[0]:
        lines = lines[1:]
    return " ".join(lines)[:110]


async def advise(
    query: AdvisorQuery,
    *,
    timeout: float = 30.0,
    use_reranker: bool = False,
    use_web: bool | None = None,
) -> AdvisorRecommendation:
    """
    One question, one recommendation. Callable outside the graph.

    `use_web` defaults to "only when local research is stale", so a question
    asked twice in a minute does not pay for two searches.
    """
    from rag import llm_provider

    settings = get_settings()
    notes: list[str] = []

    retrieval = await retrieve_for(
        query.question, query.constraints, use_reranker=use_reranker, use_web=False
    )
    if use_web is None:
        use_web = retrieval.is_stale
    if use_web:
        from scout.tools.search_engine import web_search

        web_refs, web_notes = await web_search(query.question)
        retrieval.refs.extend(web_refs)
        notes.extend(web_notes)
    notes.extend(retrieval.notes)

    if not retrieval.refs:
        return AdvisorRecommendation(
            answer="Nothing in the pool matches that question.",
            candidates=[], engine_used="local_analyst",
            notes=notes + ["Retrieval returned no rows."],
            max_bid_lakh=query.team.max_bid_lakh if query.team else None,
        )

    prompt = (
        f"{_context_block(retrieval.refs, query.team)}\n\n"
        f"QUESTION: {query.question}\n\n"
        f"Reply with JSON matching this schema:\n"
        f"{json.dumps(AdvisorRecommendation.model_json_schema())}"
    )

    prefer: Engine | None = "hermes" if llm_provider.hermes_configured() else None
    try:
        # `complete` is synchronous -- it posts with sync httpx and, on the
        # Groq and Anthropic rungs, through SDKs that block. Called directly
        # from this coroutine it stops the event loop for the whole call:
        # measured at 46.7 seconds. That loop also runs the auction's
        # WebSocket and its seven-second bid timers, so a single advisor
        # question would freeze every bidder in the room. Off to a thread.
        raw = await asyncio.to_thread(
            llm_provider.complete,
            _SYSTEM, [{"role": "user", "content": prompt}],
            task="rag", temperature=0.2, max_tokens=2600, timeout=timeout,
            prefer=prefer,  # type: ignore[arg-type]
            json_object=True,
        )
    except llm_provider.LLMError as exc:
        notes.append(f"No model answered ({exc}); built the shortlist by rule instead.")
        return _deterministic(query, retrieval, notes)
    except Exception as exc:  # noqa: BLE001 - see below
        # Deliberately broad, and not a substitute for the arm above.
        #
        # `complete` promises LLMError, and mostly keeps that promise: the
        # Groq and Anthropic arms wrap with `except Exception`. The Gemini
        # and Hermes arms wrap `httpx.HTTPError` only, so a malformed
        # response body -- a KeyError, a JSONDecodeError -- escapes as
        # itself, past the ladder, past the handler above, and out of the
        # node. The graph does not survive that, and the failure arrives
        # during a live lot.
        #
        # Advice built by rule is a worse answer than the model would have
        # given and a far better one than a traceback, so the bidder gets
        # the shortlist and the log gets the type.
        logger.exception("Unexpected %s from the provider ladder", type(exc).__name__)
        notes.append(
            f"The model call failed unexpectedly ({type(exc).__name__}); "
            "built the shortlist by rule instead."
        )
        return _deterministic(query, retrieval, notes)

    payload = _extract_json(raw)
    if payload is None:
        notes.append("The model's reply was not valid JSON; built the shortlist by rule instead.")
        return _deterministic(query, retrieval, notes)

    # The engine names itself, not the model: a model asked which vendor is
    # serving it will guess.
    engine: Engine = prefer if prefer else llm_provider.active_provider()  # type: ignore[assignment]
    payload["engine_used"] = engine
    payload["max_bid_lakh"] = query.team.max_bid_lakh if query.team else None
    _clamp(payload, query.team, notes)

    # Validate candidates one at a time rather than the whole reply at once.
    #
    # All-or-nothing throws away four sound candidates because a fifth arrived
    # with an empty `evidence` list -- and the failure is intermittent, so the
    # same question answers well one minute and falls back to rule-based prose
    # the next. A candidate that does not satisfy the contract is dropped and
    # named; the rest are kept.
    raw_candidates = list(payload.pop("candidates", None) or [])
    kept: list[Candidate] = []
    for item in raw_candidates:
        try:
            kept.append(Candidate.model_validate(item))
        except Exception as exc:  # noqa: BLE001 - one bad candidate, not a bad reply
            name = item.get("player_name", "an unnamed candidate") if isinstance(item, dict) else "?"
            notes.append(f"Dropped {name}: {_why(exc)}")

    payload["candidates"] = kept

    # Dropping every candidate is not the same as having none.
    #
    # The loop above is right to drop what does not fit the contract, and it
    # stays right until it drops *everything* -- because an empty list is
    # perfectly legal, the payload then validates, and the caller receives
    # prose with no players while retrieval is still holding rows that matched
    # the filters exactly. Measured across four runs of one unchanged question:
    # 5, 1, 0 and 2 candidates, from an identical set of five SQL rows. One run
    # in four showed the user nothing.
    #
    # So when nothing survives, rebuild the shortlist from retrieval. The prose
    # is still the model's own work and is kept; `engine_used` still names the
    # model, because the model did write the answer the user reads. The note is
    # where the seam is admitted, rather than hiding it behind a label that
    # would be wrong about one half either way.
    if not kept and any(r.player_id is not None for r in retrieval.refs):
        rebuilt = _deterministic(query, retrieval, [])
        if rebuilt.candidates:
            payload["candidates"] = rebuilt.candidates
            notes.append(
                f"The model returned no usable shortlist, so these "
                f"{len(rebuilt.candidates)} player(s) are the filter matches ranked by "
                "rating. The written answer is still the model's."
            )

    payload["notes"] = notes + [n for n in (payload.get("notes") or []) if n not in notes]

    try:
        return AdvisorRecommendation.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 - the reply itself was unusable
        notes.append(f"The model's reply did not satisfy the contract ({str(exc)[:150]}); "
                     "built the shortlist by rule instead.")
        return _deterministic(query, retrieval, notes)


async def cricket_advisor_node(state: ScoutState) -> dict:
    """
    The LangGraph node.

    The timeout handed to the model is whatever is left of the turn's budget,
    not the configured maximum -- retrieval has already spent some of it, and a
    node that starts its own clock would blow through the bid window that the
    budget exists to protect.
    """
    budget = seconds_left(state)
    team = state.get("team")
    if isinstance(team, dict):
        team = TeamContext.model_validate(team)

    constraints = state.get("constraints") or Constraints()
    parse_notes: list[str] = []
    if constraints.is_empty():
        constraints, parse_notes = parse_constraints(state["question"])

    query = AdvisorQuery(
        question=state["question"],
        constraints=constraints,
        team=team,
        on_block_player_id=state.get("on_block_player_id"),
    )

    recommendation = await advise(
        query, timeout=min(budget if budget != float("inf") else 30.0, 30.0)
    )

    notes = list(recommendation.notes)
    if parse_notes:
        notes.insert(0, "Understood as: " + ", ".join(parse_notes))

    return {
        "constraints": constraints,
        "recommendation": recommendation.model_copy(update={"notes": notes}),
        "engine_used": recommendation.engine_used,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.agents.cricket_advisor "all-rounder under 15 Cr with SR above 140"
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import asyncio
    import sys

    logging.basicConfig(level=logging.WARNING)
    question = " ".join(sys.argv[1:]) or "Find a primary All-Rounder under 15 Cr with a strike rate above 140"

    constraints, recognised = parse_constraints(question)
    print(f"question    : {question}")
    print(f"understood  : {', '.join(recognised) or 'nothing (semantic only)'}")

    team = TeamContext(team_id=1, name="Mumbai", code="MUM", purse_left_lakh=12000,
                       max_bid_lakh=11490, squad_size=0, overseas_count=0)
    started = time.perf_counter()
    rec = asyncio.run(advise(AdvisorQuery(question=question, constraints=constraints, team=team)))

    print(f"\nengine      : {rec.engine_used}   ({time.perf_counter() - started:.1f}s)")
    print(f"ceiling     : {money_lakh(rec.max_bid_lakh)}")
    for note in rec.notes:
        print(f"  ! {note}")
    print(f"\n{rec.answer}\n")
    for c in rec.candidates:
        bid = money_lakh(c.suggested_max_bid_lakh) if c.suggested_max_bid_lakh else "no bid given"
        print(f"  {c.player_name} ({c.role}) - up to {bid}")
        print(f"    {' '.join(c.rationale.split())[:150]}")
        print(f"    evidence: {c.evidence}")
        if c.risks:
            print(f"    risks   : {c.risks}")
