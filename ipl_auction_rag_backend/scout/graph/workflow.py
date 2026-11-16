"""
workflow.py
The graph. Three nodes and the conversation around them.

    START -> supervisor -> researcher -+-- research --------> END
                                       |
                                       +-- advise / news --> advisor --> END

**The supervisor opens every turn with the conversation.** It reads the
thread's memory (scout/memory.py), works out who the question is about --
named in it, or carried over from earlier turns when it says "he" or "them" --
and classifies it: a shortlist search (advise), a trade or availability
question (news), or a request to ingest (research).

**The researcher reads what SCOUT was trained on, not the web.** Since 2026-11
SCOUT learns from the site's own ingests (scout/knowledge.py): season lines,
franchise history, league leaders, the dataset's patterns and the news ledger.
The advisor used to send stale turns back for another web search; with no web
pass a second read could not be fresher, so that cycle is gone.

**After the graph, the turn is remembered** (`remember_turn`), so the next
question on the thread is read as a follow-up to this one.

**The entry node seeds the clock, and that is not optional.**
`StateGraph(..., input_schema=ScoutInput)` filters the invoke payload down to
ScoutInput's own fields before the first node runs, so a deadline computed
outside the graph is silently discarded -- measured, not assumed. `open_turn`
inside the supervisor is what makes the budget real; without it `seconds_left`
returns infinity and nothing is ever bounded.

**Every turn goes through the researcher, and the edge OUT of it is what
differs.** It used to be reached only by a keyword or by the advisor's
staleness edge, which left it unscheduled on ordinary questions -- and an
unscheduled node renders in the interface as one that started and never
finished. Now the supervisor always hands off to it: a research turn ingests,
retrains and ends; an advise or news turn picks up trained knowledge and
continues to the advisor.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Any

from langgraph.graph import END, START, StateGraph

from config.settings import get_settings
from scout.agents.cricket_advisor import (
    cricket_advisor_node,
    no_match_recommendation,
    parse_constraints,
)
from scout.agents.data_researcher import data_researcher_node
from scout.agents.knowledge_context import knowledge_context_node
from scout.graph.state import (
    NOTES_RESET,
    Intent,
    ScoutInput,
    ScoutOutput,
    ScoutState,
    make_serde,
    open_turn,
)
from scout.schemas.queries import AdvisorQuery, Constraints, TeamContext

logger = logging.getLogger(__name__)

#: Words that mean "go and fetch new data" rather than "tell me who to bid on".
#: Deliberately narrow: an advise turn that mentions "form" must not be
#: rerouted into a scrape, so only imperatives about the data itself count.
_RESEARCH_INTENT = re.compile(
    r"\b(refresh|re-?scrape|scrape|re-?index|update the (?:data|pool|stats)|"
    r"pull (?:the )?latest|fetch (?:the )?latest|sync)\b",
    re.IGNORECASE,
)


#: Words that make a question news whoever it is about.
_STRONG_NEWS = re.compile(
    r"\b(trade[ds]?|trading|transferr?(?:ed|s)?|retain(?:ed|s)?|retention|releas(?:ed|es)|"
    r"injur(?:y|ed|ies)|ruled out|withdr[ae]wn?|withdrawal|pulled out|unavailab\w*|"
    r"availability|replace(?:d|ment)|suspen(?:ded|sion)|banned|news|comeback|fitness)\b"
    r"|\bmiss(?:ed|es|ing)?\b.*\b(?:ipl|season|20\d\d)\b",
    re.IGNORECASE,
)
#: Words that make a question news only when it is about a particular player:
#: "which team does Kohli play for" is news, "which team needs a keeper" is not.
_WEAK_NEWS = re.compile(
    r"\b(?:which|what) (?:team|franchise)\b|\bplay(?:s|ing|ed)? for\b|\bjoin(?:ed|s|ing)?\b|"
    r"\bsigned\b|\bmoved?\b|\bbought by\b|\bmiss(?:ed|es|ing)?\b|\bavailable\b|\bwhere is\b",
    re.IGNORECASE,
)


def classify_intent(question: str, *, about_a_player: bool = False) -> Intent:
    """
    Which branch a question belongs on.

    A keyword rule rather than a model call. Routing is the cheapest decision in
    the graph and the most frequent, and spending a request on it to tell
    "refresh the data" from "was he traded?" from everything else would be a
    poor trade. Anything unrecognised is an advise turn, because that is what
    the console asks for.
    """
    text = question or ""
    if _RESEARCH_INTENT.search(text):
        return "research"
    if _STRONG_NEWS.search(text) or (about_a_player and _WEAK_NEWS.search(text)):
        return "news"
    return "advise"


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def supervisor_node(state: ScoutState) -> dict:
    """
    Open the turn: start the clock, settle the intent, pre-parse the ask.

    Constraints are parsed here rather than in the advisor so that a refresh
    cycle does not re-parse them, and so a caller can see what was understood
    even on a turn that never reaches the advisor.
    """
    from scout import memory as conversation
    from scout import news as news_ledger
    from scout.agents.cricket_advisor import named_players

    settings = get_settings()
    question = state.get("question", "")

    # --- the conversation so far -----------------------------------------
    # Read before anything else, because it decides who "he" is -- and that
    # decides both the intent and the filters below.
    memory = await asyncio.to_thread(conversation.load, state.get("thread_id"))
    named = await asyncio.to_thread(named_players, question, surname_needs_capital=True)
    subjects = [{"id": pid, "name": name} for pid, name in named]
    carried: list[dict[str, Any]] = []
    if not subjects:
        carried = conversation.followup_players(question, memory)
    outside_pool = news_ledger.names_in_question(question)

    # Intent next, because it decides the clock. A deliberate research turn
    # and a question asked over a live bid window are not the same kind of
    # wait: one is an ingest somebody chose to sit through, the other has
    # seven seconds before the hammer.
    intent = state.get("intent") or classify_intent(
        question, about_a_player=bool(subjects or carried or outside_pool)
    )
    if intent == "research":
        default_budget = settings.SCOUT_RESEARCH_BUDGET
    else:
        default_budget = settings.SCOUT_CYCLE_TIMEOUT * 3

    update: dict[str, Any] = open_turn(state, default_budget=default_budget)
    update["intent"] = intent
    update["history"] = memory.messages()
    update["memory_summary"] = memory.summary or None

    # NOTES_RESET first: this node opens the turn, so anything the thread
    # accumulated on a previous question stops here.
    notes = [NOTES_RESET, f"intent: {intent}"]
    if not memory.is_empty():
        notes.append(f"remembering {len(memory.turns)} earlier turn(s) of this conversation")

    # Flush EVERYTHING that belongs to one question before reading this one.
    #
    # The console asks every question on one thread (`ScoutDrawer` keeps one
    # thread id per session) and the checkpointer resumes that thread's state,
    # so any per-turn field not reset here is inherited by the next question.
    # This used to reset three fields and leave the rest: a research turn kept
    # the previous advise turn's constraints, and `research`, `retrieved` and
    # `engine_used` rode along into answers they had nothing to do with. The
    # list is now every per-turn field ScoutState declares; `notes` has its own
    # sentinel (NOTES_RESET) and the input fields are overwritten by the
    # payload itself.
    #
    # `recommendation` in particular is load-bearing. `researcher_node` reads
    # it to tell a mandatory first pass from a genuine refresh, and one left
    # over from last turn makes every later turn look like a refresh -- which
    # spends SCOUT_MAX_REFRESH_CYCLES before the cycle it guards can be taken.
    update.update({
        "constraints": Constraints(),
        "research": None,
        "research_context": None,
        "retrieved": [],
        "recommendation": None,
        "engine_used": None,
        "refresh_cycles": 0,
        "subjects": [],
    })

    if intent == "news":
        subjects = subjects or carried
        if carried:
            notes.append("following up on " + ", ".join(p["name"] for p in carried))

    if intent == "advise":
        # Parsed from THIS question only; `parse_constraints` holds no state.
        constraints, recognised = parse_constraints(question)

        # A follow-up about someone already discussed: "and his economy?",
        # "what about against spin?". Taken only when the question either
        # points back in so many words or sets no filter of its own -- "what
        # about spin bowlers?" is a new search, not a question about him.
        if carried and (conversation.points_back(question) or constraints.is_empty()):
            constraints = Constraints(player_ids=[p["id"] for p in carried], limit=len(carried))
            recognised = [f"follow-up on {p['name']}" for p in carried]
            subjects = carried
        elif constraints.player_ids and not subjects:
            subjects = [{"id": pid, "name": name} for pid, name in named]

        update["constraints"] = constraints
        notes.append("understood as: " + (", ".join(recognised) or "no filters, semantic only"))

        # Empty-state short-circuit, before any research is paid for. With
        # filters in the question, one cheap COUNT says whether anybody in the
        # pool can answer it. If nobody can, the turn ends here with the fixed
        # answer: no web search, no model call, nothing for either to invent.
        if not constraints.is_empty():
            matched = await _count_matches(constraints)
            if matched == 0:
                team = state.get("team")
                if isinstance(team, dict):
                    team = TeamContext.model_validate(team)
                query = AdvisorQuery(
                    question=state.get("question") or "?", constraints=constraints, team=team
                )
                recommendation = no_match_recommendation(
                    query, ["Understood as: " + ", ".join(recognised)]
                )
                update["recommendation"] = recommendation
                update["engine_used"] = recommendation.engine_used
                notes.append("no player in the pool matches these filters; answered without research")

    update["subjects"] = subjects
    update["notes"] = notes
    return update


async def _count_matches(constraints: Constraints) -> int | None:
    """
    How many pool rows pass the filters. None if the count could not be taken.

    None is not zero: a database that cannot be reached must not be reported to
    a bidder as "nobody matches", so the turn carries on and the advisor's own
    retrieval surfaces the real error.
    """
    from scout.tools.search_engine import by_constraints

    try:
        _, _, matched = await asyncio.to_thread(by_constraints, constraints)
    except Exception as exc:  # noqa: BLE001 - see the docstring
        logger.warning("match count failed (%s); continuing the turn", exc)
        return None
    return matched


async def researcher_node(state: ScoutState) -> dict:
    """
    Run the Data Researcher at whichever of its two speeds this turn needs.

    **This node now runs on every turn, and that is the fix.** It used to be
    reachable only by a keyword ("refresh", "scrape") or by the advisor's
    staleness edge, which meant a normal question went START -> supervisor ->
    advisor -> END and the researcher was never scheduled at all. Traced live
    on 2026-09-25: three node labels drawn in the interface, two task events
    ever emitted, and the Data Researcher left sitting on "Waiting" for the
    whole run -- which reads as a hung agent rather than as a skipped one. The
    advisor was also answering with no live context for the same reason, since
    the only thing that would have fetched any was the node that never ran.

    The staleness edge was working exactly as written. `research_age_days()`
    returned 5.03 against a `STALE_AFTER_DAYS` of 7.0, so nothing was stale,
    so no refresh was requested. A path that only opens when the data is a
    week old is not a path a user will ever see open.

    **Two speeds, because the two jobs are not the same job.** A `research`
    turn is a deliberate ingest -- `POST /scout/research`, or a question that
    asks for one in so many words -- and it downloads an archive, writes to
    the pool and retrains SCOUT. An advise or news turn reads the trained
    knowledge for the players in question: a file read and, for questions
    about nobody in particular, one vector search. Nothing leaves the machine.
    """
    if state.get("intent") == "research":
        # A caller waiting on an ingest gets the whole ingest, and then SCOUT
        # is retrained on what it brought in. No web pass: since 2026-11 SCOUT
        # learns from ingested IPL data only (scout/knowledge.py).
        from scout import knowledge

        merged: dict[str, Any] = {}
        notes: list[str] = []
        try:
            heavy = await data_researcher_node(state)
            notes.extend(heavy.pop("notes", []) or [])
            merged.update(heavy)
        except Exception as exc:  # noqa: BLE001 - a thinner research turn, not a failed one
            logger.warning("research ingest failed: %s", exc)
            notes.append(f"The ingest failed ({type(exc).__name__}).")
        trained = await knowledge.train(reason="research turn")
        if trained.get("state") == "running":
            notes.append("A training run was already in progress; SCOUT will pick up this data from it.")
        else:
            notes.append(f"Retrained SCOUT on the ingested data: {trained.get('documents')} documents.")
        merged["notes"] = notes
        return merged

    # Advise and news turns read what SCOUT was trained on -- season lines,
    # franchise history, archive events and the news ledger -- exactly, for
    # the players in question. Nothing leaves the machine.
    return await knowledge_context_node(state)


async def advisor_node(state: ScoutState) -> dict:
    return await cricket_advisor_node(state)


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------


def route_from_advisor(state: ScoutState) -> str:
    """
    Always "done" now.

    The advisor used to send a turn back to the researcher when its data was
    stale, so the researcher could search the web again. SCOUT no longer
    searches the web: the researcher reads the trained knowledge, which a
    second read within the same second cannot make any fresher. A refresh
    would only pay for a second model call to write the same answer, so the
    cycle is gone. Fresh data arrives through an ingest, which retrains SCOUT
    (scout/knowledge.py).
    """
    del state
    return "done"


def route_from_supervisor(state: ScoutState) -> str:
    """
    To the researcher, unless the supervisor has already answered.

    It answers only one kind of question itself: one whose filters match
    nobody (see `supervisor_node`). Everything else goes on as before.
    """
    if state.get("intent") == "advise" and state.get("recommendation") is not None:
        return "answered"
    return "research"


def route_from_researcher(state: ScoutState) -> str:
    """On to the advisor for an advise or news turn; a research turn ends here."""
    return "advise" if state.get("intent") in ("advise", "news") else "done"


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def build() -> StateGraph:
    """The graph, uncompiled. Separate so a test can compile it without a saver."""
    graph = StateGraph(ScoutState, input_schema=ScoutInput)

    graph.add_node("supervisor", supervisor_node)
    graph.add_node("researcher", researcher_node)
    graph.add_node("advisor", advisor_node)

    graph.add_edge(START, "supervisor")
    # Unconditional. Both intents go through the researcher now -- a research
    # turn to ingest, an advise turn to pick up live context -- and the edge
    # OUT of the researcher is what still differs between them. This is the
    # edge whose absence left the Data Researcher on "Waiting".
    #
    # The one exception: a question whose filters match nobody in the pool is
    # answered by the supervisor and ends there (`route_from_supervisor`).
    graph.add_conditional_edges(
        "supervisor", route_from_supervisor,
        {"research": "researcher", "answered": END},
    )
    graph.add_edge("advisor", END)
    graph.add_conditional_edges(
        "researcher", route_from_researcher,
        {"advise": "advisor", "done": END},
    )
    return graph


_connection: Any = None
_compiled = None


async def _checkpointer():
    """
    The checkpointer, opened once for the process.

    **AsyncSqliteSaver, not SqliteSaver.** Every node here is a coroutine and
    the graph is driven with `ainvoke`, and the synchronous saver raises
    NotImplementedError from `aget_tuple` the moment the loop starts -- before
    any node runs, so the failure looks like a graph problem rather than a
    storage one. `aiosqlite` is already installed as a dependency of
    langgraph-checkpoint-sqlite; it is pinned explicitly in requirements.txt
    because this file now imports it directly rather than by accident.

    `from_conn_string` is not used: it is an async context manager and takes
    no serde, and SCOUT's state carries Pydantic models that LangGraph's
    msgpack layer warns about today and refuses in a future version.
    """
    import aiosqlite
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    global _connection
    if _connection is None:
        path = Path(get_settings().SCOUT_CHECKPOINT_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        _connection = await aiosqlite.connect(str(path))
    return AsyncSqliteSaver(_connection, serde=make_serde())


async def compiled():
    """The compiled graph, built once."""
    global _compiled
    if _compiled is None:
        _compiled = build().compile(checkpointer=await _checkpointer())
        logger.info("SCOUT graph compiled with an async SQLite checkpointer")
    return _compiled


async def aclose() -> None:
    """
    Release the checkpointer's connection.

    Not optional, and the failure is unusually confusing. `aiosqlite` runs its
    connection on a background thread that is **not** a daemon, so a process
    that never closes the connection never exits -- it finishes all its work,
    returns from `asyncio.run`, and then sits there. Worse, anything it printed
    is still in a buffered stdout that never flushes, so the symptom is a
    program that appears to hang with no output at all, having in fact already
    done everything it was asked to.

    A long-running server calls this from its shutdown hook. A script calls it
    in a `finally`.
    """
    global _connection, _compiled
    if _connection is not None:
        await _connection.close()
        _connection = None
    _compiled = None


# ---------------------------------------------------------------------------
# The public entry point
# ---------------------------------------------------------------------------


async def run(payload: ScoutInput, *, thread_id: str = "default") -> ScoutOutput:
    """
    One turn through the graph.

    `thread_id` is the checkpoint key: the same id resumes a conversation, a
    fresh one starts over. The caller owns it, because only the caller knows
    whether two questions are the same conversation.

    The final state is mapped to ScoutOutput by hand rather than through
    `output_schema`. `elapsed_seconds` is not a state field -- it is a fact
    about the run -- and a graph cannot report something it never held.
    """
    app = await compiled()
    started = time.perf_counter()
    if payload.thread_id is None:
        payload = payload.model_copy(update={"thread_id": thread_id})

    final: ScoutState = await app.ainvoke(
        payload.model_dump(), {"configurable": {"thread_id": thread_id}}
    )

    output = output_from(final, time.perf_counter() - started)
    return await remember_turn(payload.thread_id, payload.question, output)


def memory_text(output: ScoutOutput) -> str:
    """What the conversation remembers SCOUT said: the answer and its cards."""
    rec = output.recommendation
    if rec is None:
        return " ".join(output.notes[-3:]) or "Research pass finished."
    lines = [rec.answer]
    for c in rec.candidates[:5]:
        lines.append(f"- {c.player_name} ({c.role}): " + "; ".join(c.evidence[:3]))
    return "\n".join(lines)


async def remember_turn(thread_id: str | None, question: str, output: ScoutOutput) -> ScoutOutput:
    """
    Write the finished turn into the conversation memory and report its size.

    Never fails the turn: an answer the user can read is worth more than a
    memory write, so a storage error is logged and the answer goes out.
    """
    from scout import memory as conversation

    if not thread_id or output.intent == "research":
        return output
    try:
        remembered = await asyncio.to_thread(
            conversation.remember, thread_id, question, memory_text(output),
            output.players, intent=output.intent,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not remember the turn on %s: %s", thread_id, exc)
        return output
    if remembered is None:
        return output
    return output.model_copy(update={"context": remembered.usage()})


def output_from(final: ScoutState, elapsed_seconds: float) -> ScoutOutput:
    """
    The final state, as the thing a caller gets back.

    Extracted from `run` because there are now two ways to drive the graph --
    `ainvoke` above and `astream` in the streaming route -- and both have to
    produce an identical ScoutOutput. Two hand-written copies of this mapping
    would drift the first time a field is added, and the drift would show up as
    a field that is present over one transport and missing over the other.
    """
    recommendation = final.get("recommendation")
    players = [
        {"id": c.player_id, "name": c.player_name}
        for c in (recommendation.candidates if recommendation else [])
    ] or [
        {"id": int(s["id"]), "name": str(s["name"])} for s in (final.get("subjects") or [])
    ]
    return ScoutOutput(
        intent=final.get("intent") or "advise",
        players=players,
        recommendation=recommendation,
        research=final.get("research"),
        engine_used=final.get("engine_used"),
        research_context=final.get("research_context"),
        # Deduplicated in order: the researcher's notes travel on the batch as
        # well as in the accumulator, and a user reading the same sentence twice
        # assumes something ran twice.
        notes=list(dict.fromkeys(final.get("notes") or [])),
        refresh_cycles=final.get("refresh_cycles", 0),
        elapsed_seconds=round(elapsed_seconds, 2),
    )


def graph_shape() -> dict[str, Any]:
    """
    The compiled graph's nodes and edges, as data.

    Read off the compiled graph rather than written out by hand, so it cannot
    describe a shape the code does not have. Not `draw_ascii()`: that needs
    `grandalf`, and a drawing library is a poor trade for a debug view.
    """
    inner = build().compile().get_graph()
    return {
        "nodes": [n for n in inner.nodes if n not in ("__start__", "__end__")],
        "edges": [
            {
                "from": e.source.replace("__start__", "START").replace("__end__", "END"),
                "to": e.target.replace("__start__", "START").replace("__end__", "END"),
                "when": e.data if isinstance(e.data, str) else None,
                "conditional": bool(e.conditional),
            }
            for e in inner.edges
        ],
    }


def describe_graph() -> str:
    """The same thing as lines, for a terminal."""
    shape = graph_shape()
    lines = [f"nodes: {', '.join(shape['nodes'])}", "edges:"]
    for edge in shape["edges"]:
        label = f"  --{edge['when']}-->" if edge["when"] else "  -------->"
        lines.append(f"  {edge['from']:>12} {label} {edge['to']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
#
#   python -m scout.graph.workflow                       draw the graph
#   python -m scout.graph.workflow "who should I bid on under 5 Cr?"
#   python -m scout.graph.workflow --research            force a refresh turn
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import asyncio
    import sys

    logging.basicConfig(level=logging.WARNING)
    args = [a for a in sys.argv[1:] if a != "--research"]
    force_research = "--research" in sys.argv[1:]
    question = " ".join(args)

    if not question:
        print(describe_graph())
        raise SystemExit(0)

    team = TeamContext(team_id=1, name="Mumbai", code="MUM", purse_left_lakh=12000,
                       max_bid_lakh=11490, squad_size=0, overseas_count=0)
    payload = ScoutInput(
        question=question,
        intent="research" if force_research else None,
        team=team,
        budget_seconds=60.0,
    )

    async def _main():
        try:
            return await run(payload, thread_id="cli")
        finally:
            await aclose()

    out = asyncio.run(_main())

    print(f"intent          : {out.intent}")
    print(f"engine          : {out.engine_used}")
    print(f"refresh cycles  : {out.refresh_cycles}")
    print(f"elapsed         : {out.elapsed_seconds}s")
    print("\nnotes:")
    for note in out.notes:
        print(f"  - {note[:150]}")

    if out.recommendation:
        print(f"\n{out.recommendation.answer}\n")
        for c in out.recommendation.candidates:
            from scout.schemas.queries import money_lakh
            bid = money_lakh(c.suggested_max_bid_lakh) if c.suggested_max_bid_lakh else "-"
            print(f"  {c.player_name} ({c.role}) up to {bid}")
            print(f"    {' '.join(c.rationale.split())[:130]}")
    if out.research:
        print(f"\nresearch: {len(out.research.updates)} update(s), "
              f"{len(out.research.unresolved)} unresolved")
