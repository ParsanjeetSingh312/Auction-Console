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
    NO_MATCH_ANSWER,
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

#: Who a player is being measured AGAINST: "against fast bowlers", "vs spin",
#: "facing pace", "to left-handers". Everything this matches is about the
#: opposition, so it is cut out of the text before the role is read -- it was
#: "bowlers" in "a batter ... against fast bowlers" that made the old parser
#: answer role=Bowler, because it tested its word list in a fixed order
#: (bowler before batter) rather than reading the question.
_OPPOSITION = re.compile(
    r"\b(?:against|vs\.?|versus|facing|v)\s+(?:the\s+)?"
    r"(?P<who>(?:(?:left|right)[- ]arm\s+)?"
    r"(?:fast|pace|pacers?|seam(?:ers?)?|quicks?|spin(?:ners?)?|leg[- ]?spin(?:ners?)?|"
    r"off[- ]?spin(?:ners?)?|wrist[- ]?spin(?:ners?)?|finger[- ]?spin(?:ners?)?)"
    r"(?:\s+(?:bowl(?:ers?|ing)|attacks?))?"
    r"|(?:left|right)[- ]hand(?:ed|ers)?(?:\s+(?:batters?|batsmen|batting))?)"
)

#: Phases of an innings people ask about, which the pool has no split for.
_UNSUPPORTED_PHASES = re.compile(r"\b(death overs?|at the death|powerplay|middle overs|slog overs)\b")


def parse_constraints(question: str) -> tuple[Constraints, list[str]]:
    """
    A question turned into filters, by rule.

    Returns the constraints and a list of what was recognised, which is what
    lets a user see that "under 15 Cr" became 1,500 lakh rather than 15.

    Two passes, in this order:

    1. **The opposition is read and removed.** "Against fast bowlers" says what
       kind of split a strike rate is measured on; it says nothing about the
       role of the player being asked for. Taken out first, so it can neither
       set the role nor be mistaken for one.
    2. **The role is the earliest role word left in the question**, not the
       first one in `_ROLE_WORDS`. People name what they want first ("a batter
       who ..."), and the list order was an implementation detail that decided
       the answer whenever a question mentioned two roles.

    Each call starts from nothing. No constraint survives from a previous
    question -- the graph's supervisor clears the stored copy every turn, and
    this function holds no state of its own.
    """
    text = question.lower()
    found: list[str] = []
    fields: dict[str, Any] = {}
    #: Where each stat filter's label sits in `found`, so a split can relabel it.
    label_at: dict[str, int] = {}

    # --- pass 1: who the player is measured against ---------------------
    versus: str | None = None  # "fast" | "spin" | "lhb" | "rhb"
    opposition = _OPPOSITION.search(text)
    if opposition:
        who = opposition.group("who")
        if "hand" in who:
            versus = "lhb" if who.startswith("left") else "rhb"
        elif "spin" in who:
            versus = "spin"
        else:
            versus = "fast"
        text = _OPPOSITION.sub(" ", text)
    role_text = text

    # --- pass 2: the role, by position --------------------------------------
    earliest: tuple[int, str] | None = None
    for word, role in _ROLE_WORDS:
        at = role_text.find(word)
        if at >= 0 and (earliest is None or at < earliest[0]):
            earliest = (at, role)
    if earliest:
        fields["role"] = earliest[1]
        found.append(f"role={earliest[1]}")

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
            label_at[key] = len(found)
            found.append(f"{label}{'<=' if key.startswith('max') else '>='}{match.group(1)}")

    # --- splits: move a figure onto the split it was asked about -----------
    # Moved, not copied. Keeping the career filter as well would demand both
    # numbers, which is the bug this exists to fix: a batter brutal against
    # pace and ordinary against spin has a modest career strike rate.
    def _move(old_key: str, new_key: str, label: str) -> None:
        value = fields.pop(old_key)
        fields[new_key] = value
        op = "<=" if new_key.startswith("max") else ">="
        found[label_at.pop(old_key)] = f"{label}{op}{value:g}"

    if versus in ("fast", "spin") and "min_bat_sr" in fields:
        _move("min_bat_sr", f"min_sr_vs_{versus}", f"strike rate vs {'pace' if versus == 'fast' else 'spin'}")
    if versus in ("lhb", "rhb") and "max_economy" in fields:
        _move("max_economy", f"max_econ_vs_{versus}",
              f"economy vs {'left' if versus == 'lhb' else 'right'}-handers")

    boundary = re.search(
        rf"boundar(?:y|ies)\s*(?:percentage|%|pct|percent)\s*(?:of\s*)?(?:above|over|>|at least)?\s*{_NUM}",
        text,
    )
    if boundary and versus in ("fast", "spin"):
        key = f"min_boundary_pct_{versus}"
        fields[key] = float(boundary.group(1))
        found.append(f"boundary % vs {'pace' if versus == 'fast' else 'spin'}>={boundary.group(1)}")

    if versus and not any(k.startswith(("min_sr_vs", "max_econ_vs", "min_boundary_pct")) for k in fields):
        # The opposition was named but no figure was tied to it ("scores
        # quickly against pace"). Said, rather than silently ignored.
        found.append(f"measured against {'pace' if versus == 'fast' else 'spin' if versus == 'spin' else 'left-handers' if versus == 'lhb' else 'right-handers'} (no figure given, so no split filter)")

    phase = _UNSUPPORTED_PHASES.search(text)
    if phase and any(k in fields for k in ("min_bat_sr", "max_economy", "min_bat_avg")):
        # The pool holds no phase-of-innings splits. The career figure is the
        # closest thing it has, and the user is told that is what was used.
        found.append(f"no '{phase.group(1)}' split in the pool, so the career figure was used")

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

#: The advisor's instructions.
#:
#: **`candidates` is a list and the prompt says so in as many words.** The old
#: wording ("return fewer candidates rather than padding the list") was read as
#: "pick the best one": handed four players who all met the filters, the model
#: returned one card and mentioned the other three in prose, where the console
#: cannot render them. Every CANDIDATES row marked [match] has already passed
#: the user's filters in SQL, so the model's job for those is to rank and
#: explain them, not to decide whether they qualify.
_SYSTEM = """You are SCOUT, an IPL auction advisor. You answer with JSON only.

Rules you must not break:
- `candidates` is an ARRAY. Return one entry for EVERY player in the CANDIDATES
  block marked [match], up to the stated limit, best first. Those players have
  already passed the user's filters in the database; do not drop one because
  another looks better. Never return a single "best fit" when several match.
- Recommend only players that appear in the CANDIDATES block, using their exact
  `id` as `player_id` and their exact name. Never invent a player or an id.
- Use only the keys in the schema. Do not add keys of your own.
- Every candidate needs `evidence`: the actual figures your rationale rests on.
- `suggested_max_bid_lakh` is in LAKH and must never exceed the stated ceiling.
- Players marked [pool] or [research] are context: include them only if they
  genuinely answer the question.
"""


def _context_block(
    refs: list[RetrievedRef], team: TeamContext | None, limit: int = 12, *, wanted: int = 5,
) -> str:
    """The retrieved rows and the team's position, as a model reads them."""
    lines = [f"CANDIDATES (recommend only from these; return up to {wanted}):"]
    for ref in refs[:limit]:
        # [match] = passed every SQL filter in the question. The prompt tells the
        # model to return a card for each of these, which is what fixes the
        # one-card answers.
        tag = (
            "[research]" if ref.from_research
            else "[match]" if ref.scored_by == "keyword"
            else "[pool]"
        )
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

    # How current the candidate figures are, so the model trusts them over its
    # own memory of an older season (scout/stats_refresh.py writes this).
    from datetime import datetime

    from scout.stats_refresh import load_status

    season = load_status().get("season_through")
    lines += [
        "",
        f"DATA FRESHNESS: today is {datetime.now():%d %B %Y}."
        + (
            f" Candidate figures are complete IPL career records through the IPL "
            f"{season} season. Quote them, never older totals from memory."
            if season
            else " Quote only the figures given here, never totals from memory."
        ),
    ]
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
    query: AdvisorQuery,
    retrieval: RetrievalResult,
    notes: list[str],
    *,
    why: str = "No model was available, so this is a data match rather than an assessment.",
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
                    f"your question. {why}"
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
        notes=notes[:12],
        max_bid_lakh=team.max_bid_lakh if team else None,
    )


def no_match_recommendation(query: AdvisorQuery, notes: list[str]) -> AdvisorRecommendation:
    """
    The fixed answer for "nobody matches".

    Shared by the advisor and the graph's supervisor, which checks the filters
    before spending a web search on a question nobody can answer. Written by
    rule and labelled as such: `engine_used="local_analyst"` says no model was
    involved, because none was.
    """
    return AdvisorRecommendation(
        answer=NO_MATCH_ANSWER,
        candidates=[],
        engine_used="local_analyst",
        notes=list(dict.fromkeys(notes))[:12],
        max_bid_lakh=query.team.max_bid_lakh if query.team else None,
    )


#: The keys a model may put on a candidate and on the reply. Anything else is a
#: hallucinated key: stripped before validation and reported in the notes, so
#: it never reaches the console and never silently changes meaning later.
_CANDIDATE_KEYS = frozenset(Candidate.model_fields)
_REPLY_KEYS = frozenset(AdvisorRecommendation.model_fields)


def _strip_unknown(item: dict[str, Any], allowed: frozenset[str], where: str, notes: list[str]) -> dict[str, Any]:
    """`item` without keys the schema does not define; each one dropped is noted."""
    extra = sorted(k for k in item if k not in allowed)
    if extra:
        notes.append(f"Ignored unexpected key(s) {', '.join(extra)} on {where}.")
    return {k: v for k, v in item.items() if k in allowed}


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


def _is_ledger_freshness(note: str) -> bool:
    """The two notes `retrieve_for` writes about the saved research ledger."""
    return note.startswith("No research recorded yet") or (
        note.startswith("Research is ") and "days old" in note
    )


async def advise(
    query: AdvisorQuery,
    *,
    timeout: float = 30.0,
    use_reranker: bool = False,
    use_web: bool | None = None,
    research_context: str | None = None,
) -> AdvisorRecommendation:
    """
    One question, one recommendation. Callable outside the graph.

    `use_web` defaults to "only when local research is stale", so a question
    asked twice in a minute does not pay for two searches.

    `research_context` is what the Data Researcher found on the live web for
    this turn, already summarised. When it is present this function does not
    search again whatever `use_web` would have decided -- the researcher node
    has just made that call on this same question, and paying Tavily twice for
    one question buys nothing but latency. Passing `use_web=True` explicitly
    still forces a second search, because a caller outside the graph has no
    researcher in front of it.
    """
    from rag import llm_provider

    settings = get_settings()
    notes: list[str] = []

    from scout.tools.search_engine import refs_for_mentioned

    async def _no_mentions() -> tuple[list[RetrievedRef], list[str]]:
        return [], []

    # Retrieval and the research-name lookup are independent, so they run
    # together instead of one after the other.
    retrieval, (named_refs, named_notes) = await asyncio.gather(
        retrieve_for(query.question, query.constraints, use_reranker=use_reranker, use_web=False),
        asyncio.to_thread(refs_for_mentioned, research_context) if research_context else _no_mentions(),
    )

    # Empty-state short-circuit. Nobody in the pool passed the question's
    # filters (or, for an unfiltered question, nothing cleared the similarity
    # gate), so there is nothing to recommend and no model is asked to. This
    # is the case that used to produce cards for players who did not meet the
    # criteria: retrieval fell back to the nearest vector matches, and the
    # model dutifully explained why each was a fit. Checked before the web
    # search too -- news about other players cannot make a filter match.
    if retrieval.no_match:
        return no_match_recommendation(query, notes + retrieval.notes)

    if use_web is None:
        # The researcher already searched for this turn, so its context stands
        # in for the staleness check that would otherwise trigger one here.
        use_web = retrieval.is_stale and not research_context
    if use_web:
        from scout.tools.search_engine import web_search

        web_refs, web_notes = await web_search(query.question)
        retrieval.refs.extend(web_refs)
        notes.extend(web_notes)
    # Pull in the pool rows for whoever the research actually named, ahead of
    # the constraint matches. Without this the advisor reads about one set of
    # players and is offered a different set to choose from -- see
    # `refs_for_mentioned` for the measurement.
    if research_context:
        known = {r.player_id for r in retrieval.refs if r.player_id is not None}
        # With filters in the question, a player the news names is only added
        # if they passed those filters -- and every such player is already in
        # `known`. Adding the rest would hand the advisor candidates who fail
        # the criteria, which is the leak the similarity gate exists to close.
        fresh = (
            [] if not query.constraints.is_empty()
            else [r for r in named_refs if r.player_id not in known]
        )
        # Prepended, not appended. `_context_block` truncates at twelve rows,
        # and the players the news is discussing are the ones that must survive
        # that cut.
        retrieval.refs = fresh + retrieval.refs
        notes.extend(named_notes)

    # The ledger's freshness notes describe SAVED research only. With live
    # research in hand for this very question they are wrong twice over: "No
    # research recorded yet; answering from the spreadsheet alone" contradicts
    # the answer the user is reading (whose evidence cites the live research),
    # and that wording is exactly what `route_from_advisor` reads as stale --
    # so the turn was sent back to the researcher to run the same web search
    # again. Observed on Railway, whose volume starts with an empty ledger:
    # every answer said "spreadsheet alone" and every turn ran the researcher
    # and the advisor twice. Without live context the notes stand, and so does
    # the refresh they trigger.
    if research_context:
        notes.extend(n for n in retrieval.notes if not _is_ledger_freshness(n))
        notes.append("Answered with live research gathered for this question.")
    else:
        notes.extend(retrieval.notes)

    if not retrieval.refs:
        return AdvisorRecommendation(
            answer="Nothing in the pool matches that question.",
            candidates=[], engine_used="local_analyst",
            notes=notes + ["Retrieval returned no rows."],
            max_bid_lakh=query.team.max_bid_lakh if query.team else None,
        )

    # Ahead of the candidates on purpose. A model reading a long prompt
    # weights the top of it most heavily, and this is the only part that
    # can contradict the pool -- a player the spreadsheet rates highly who
    # was ruled out yesterday is exactly the case the live pass exists to
    # catch.
    # **This block tells the model what to DO with the research, not just that
    # it exists.** The first version handed over the text with "prefer it on
    # form, fitness and availability" and changed nothing: on 2026-09-25 the
    # live research named Hardik Pandya, Rinku Singh and David Miller as
    # finishers and the advisor returned Travis Head, Suryakumar Yadav and
    # Shreyas Iyer, having read both.
    #
    # It was not ignoring the block so much as having no legal way to act on
    # it. The candidate list below says "recommend only from these", and the
    # schema requires a `player_id` that only a pool row has, so a name that
    # appears in the news and not in the pool cannot be returned at all --
    # correctly. The instruction therefore has to describe the moves that ARE
    # available: reorder the pool candidates, and write what the research says
    # into the rationale and the risks.
    live_block = (
        "LIVE RESEARCH -- gathered from the web for this question, minutes "
        "ago. The CANDIDATES below come from a spreadsheet that cannot know "
        "any of it.\n"
        f"{research_context}\n\n"
        "USE IT AS FOLLOWS. Prefer candidates the live research speaks well "
        "of, and rank them higher. Put anything it says about a candidate -- "
        "form, a score, a role -- into that candidate's `evidence` or "
        "`rationale`, and say it came from live research. Put any injury, "
        "doubt or unavailability into their `risks`, and drop or demote a "
        "candidate the research says is unavailable. Where the research and "
        "the spreadsheet disagree about current form, the research is newer "
        "and wins.\n"
        "Do NOT recommend a player who is not in CANDIDATES, however well the "
        "research speaks of them -- they are not in this auction pool.\n"
        "If the research does not mention any candidate, that is normal and "
        "not a problem: recommend from CANDIDATES on their own merits exactly "
        "as you would without it. NEVER return an empty shortlist because the "
        "research did not match.\n\n"
        if research_context
        else ""
    )

    prompt = (
        f"{live_block}{_context_block(retrieval.refs, query.team, wanted=query.constraints.limit)}\n\n"
        f"QUESTION: {query.question}\n\n"
        f"Reply with JSON matching this schema:\n"
        f"{json.dumps(AdvisorRecommendation.model_json_schema())}"
    )

    # Gated, not automatic. Hermes being reachable says nothing about whether
    # it is the right engine for THIS agent: the advisor has to return JSON
    # satisfying AdvisorRecommendation, and the endpoint configured for the
    # researcher is a local hermes3:8b. See SCOUT_ADVISOR_USES_HERMES.
    prefer: Engine | None = (
        "hermes"
        if settings.SCOUT_ADVISOR_USES_HERMES and llm_provider.hermes_configured()
        else None
    )
    answered_by: list[Engine] = []
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
            on_answer=answered_by.append,
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
    # serving it will guess. And it is the rung that answered, not the one
    # asked first -- `prefer` and `active_provider()` both name the head of the
    # ladder, which says "hermes" when Hermes was asleep and Groq replied.
    engine: Engine = (
        answered_by[0] if answered_by
        else prefer if prefer
        else llm_provider.active_provider()  # type: ignore[assignment]
    )
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
    payload = _strip_unknown(payload, _REPLY_KEYS | {"candidates"}, "the reply", notes)

    # The players the model was actually shown, by id. A candidate whose id is
    # not here is a hallucination however well-formed it is -- schema
    # validation alone cannot catch an invented `player_id: 9001`.
    offered = {r.player_id: r for r in retrieval.refs if r.player_id is not None}

    kept: list[Candidate] = []
    for item in raw_candidates:
        if not isinstance(item, dict):
            notes.append("Dropped a candidate that was not an object.")
            continue
        name = item.get("player_name", "an unnamed candidate")
        item = _strip_unknown(item, _CANDIDATE_KEYS, str(name), notes)
        # The contract first, so a malformed candidate is dropped with the
        # reason it is malformed ("role: Input should be ...").
        try:
            candidate = Candidate.model_validate(item)
        except Exception as exc:  # noqa: BLE001 - one bad candidate, not a bad reply
            notes.append(f"Dropped {name}: {_why(exc)}")
            continue
        # Then membership: well-formed is not the same as real.
        ref = offered.get(candidate.player_id)
        if ref is None:
            notes.append(f"Dropped {name}: not one of the players retrieved for this question.")
            continue
        if any(c.player_id == ref.player_id for c in kept):
            continue
        # The pool's spelling, not the model's: a card titled with a near-miss
        # name ("V Kohli", "Virat Kholi") for a correct id is still wrong.
        kept.append(candidate.model_copy(update={"player_name": ref.player_name}))

    # Every exact match gets a card. The prompt asks for this; this makes it
    # true when the model ignores the prompt. A player who passed every SQL
    # filter and was left out of the reply is added after the model's own
    # picks, built by rule from the data and saying so in its rationale -- the
    # alternative is the old behaviour, four matches and one card.
    if kept:
        missing = [
            r for r in retrieval.refs
            if r.scored_by == "keyword" and not r.from_research and r.player_id is not None
            and all(c.player_id != r.player_id for c in kept)
        ]
        room = max(0, query.constraints.limit - len(kept))
        if missing and room:
            filler = _deterministic(
                query, RetrievalResult(refs=missing[:room]), [],
                why="The model's reply left this player out, so this card is the data match, "
                    "not a written assessment.",
            ).candidates
            kept.extend(filler)
            notes.append(
                f"Added {len(filler)} more player(s) who match every filter but were "
                "left out of the model's reply."
            )

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

    # Capped at the schema's twelve. More notes than that would fail the final
    # validation and throw away a good reply over its own commentary.
    payload["notes"] = (notes + [n for n in (payload.get("notes") or []) if n not in notes])[:12]

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
        query,
        timeout=min(budget if budget != float("inf") else 30.0, 30.0),
        research_context=state.get("research_context"),
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
