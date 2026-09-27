"""
workflow.py
The graph. Three nodes, two conditional edges, and one cycle.

    START -> supervisor -> researcher -+-- research --> END
                                       |
                                       +-- advise ----> advisor
                                                          |  ^
                                                 refresh  |  |
                                                          +--+
                                                          |
                                                        done
                                                          |
                                                         END

**The cycle is the reason this is a graph.** Everything else here could be a
function that calls three others in order. The advisor handing a turn back to
the researcher -- "I can answer this, but the form data is nine days old" --
and then answering again with what came back is a loop, and a loop with state
is what LangGraph is for. `may_refresh` bounds it on two axes at once: a
counter, so it cannot run forever, and a wall clock, so it cannot run long.
Either alone is insufficient. The counter would permit one refresh that
overruns the bid window; the clock would permit an endless series of fast ones.

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
finished. Now the supervisor always hands off to it: a research turn ingests
and ends, an advise turn picks up live web context and continues to the
advisor. The node itself chooses which of its two speeds to run at; see
`researcher_node`.
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
from scout.agents.cricket_advisor import cricket_advisor_node, parse_constraints
from scout.agents.data_researcher import data_researcher_node
from scout.agents.live_context import live_context_node
from scout.graph.state import (
    NOTES_RESET,
    Intent,
    ScoutInput,
    ScoutOutput,
    ScoutState,
    elapsed,
    make_serde,
    may_refresh,
    open_turn,
    seconds_left,
)
from scout.schemas.queries import TeamContext

logger = logging.getLogger(__name__)

#: Words that mean "go and fetch new data" rather than "tell me who to bid on".
#: Deliberately narrow: an advise turn that mentions "form" must not be
#: rerouted into a scrape, so only imperatives about the data itself count.
_RESEARCH_INTENT = re.compile(
    r"\b(refresh|re-?scrape|scrape|re-?index|update the (?:data|pool|stats)|"
    r"pull (?:the )?latest|fetch (?:the )?latest|sync)\b",
    re.IGNORECASE,
)


def classify_intent(question: str) -> Intent:
    """
    Which branch a question belongs on.

    A keyword rule rather than a model call. Routing is the cheapest decision in
    the graph and the most frequent, and spending a request on it -- against a
    free tier of twenty a day -- to distinguish "refresh the data" from
    everything else would be a poor trade. Anything unrecognised is an advise
    turn, because that is what the console asks for.
    """
    return "research" if _RESEARCH_INTENT.search(question or "") else "advise"


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
    settings = get_settings()

    # Intent first, because it decides the clock. A deliberate research turn
    # and a question asked over a live bid window are not the same kind of
    # wait: one is an ingest somebody chose to sit through, the other has
    # seven seconds before the hammer. Giving both the advise budget is what
    # made the Hermes sub-agent unreachable -- it needs more time than an
    # advise turn has, and there was no turn that had more.
    intent = state.get("intent") or classify_intent(state.get("question", ""))
    if intent == "research":
        default_budget = settings.SCOUT_RESEARCH_BUDGET
    else:
        default_budget = settings.SCOUT_CYCLE_TIMEOUT * 3
        # An advise turn that is configured to reason with Hermes is widened
        # by what Hermes costs, rather than being asked to fit it into a
        # budget sized for a 3-second web search. Added, not carved out: the
        # advisor's share is unchanged and the researcher's is real.
        #
        # This is the line that makes SCOUT_RESEARCHER_USES_HERMES take effect
        # on ordinary questions. Without it the sub-agent needed 30s, the turn
        # allowed 8, and the rung was skipped on every single advise turn --
        # configured, verified working, and never once reached in the product.
        from rag.llm_provider import hermes_configured

        if settings.SCOUT_RESEARCHER_USES_HERMES and hermes_configured():
            default_budget += settings.SCOUT_HERMES_AGENT_TIMEOUT

    update: dict[str, Any] = open_turn(state, default_budget=default_budget)
    update["intent"] = intent

    # NOTES_RESET first: this node opens the turn, so anything the thread
    # accumulated on a previous question stops here.
    notes = [NOTES_RESET, f"intent: {intent}"]
    if intent == "advise":
        constraints, recognised = parse_constraints(state.get("question", ""))
        update["constraints"] = constraints
        notes.append("understood as: " + (", ".join(recognised) or "no filters, semantic only"))

    # Clear what belonged to the PREVIOUS question on this thread. `notes` has
    # its own sentinel for this (see `merge_notes`), and these two need the
    # same treatment for the same reason: a thread resumes from its checkpoint,
    # so without this the second question on a thread starts holding the first
    # question's answer.
    #
    # `recommendation` in particular is load-bearing now. `researcher_node`
    # reads it to tell a mandatory first pass from a genuine refresh, and a
    # recommendation left over from last turn makes every turn after the first
    # look like a refresh -- which spends SCOUT_MAX_REFRESH_CYCLES before the
    # cycle it guards can ever be taken.
    update["recommendation"] = None
    update["research_context"] = None
    update["refresh_cycles"] = 0

    update["notes"] = notes
    return update


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
    asks for one in so many words -- and it downloads an archive and writes to
    the pool: 17.6 seconds for 101 player updates, measured. An `advise` turn
    gets `live_context`: one search, one summary, nothing written, bounded to
    half of whatever is left of the turn. Putting the heavy pass on every
    question would mean every question arriving after the hammer.

    **The refresh counter is incremented here and only on a genuine refresh.**
    A researcher run reached from START is the normal path; one reached from
    the advisor is the cycle `SCOUT_MAX_REFRESH_CYCLES` exists to bound. The
    advisor having already produced a recommendation is what distinguishes
    them, and it is the only signal in the state that does.
    """
    if state.get("intent") == "research":
        # A caller waiting on an ingest gets the whole ingest -- and the live
        # pass alongside it, concurrently, because this is the only turn with
        # enough budget for the Hermes sub-agent to run at all. The archive
        # download is I/O and thread work while Hermes is a local socket, so
        # the two overlap rather than add up.
        heavy, live = await asyncio.gather(
            data_researcher_node(state),
            live_context_node(state, budget_override=seconds_left(state)),
            return_exceptions=True,
        )

        merged: dict[str, Any] = {}
        notes: list[str] = []
        for part in (heavy, live):
            if isinstance(part, BaseException):
                # One half failing is a thinner research turn, not a failed
                # one: the ingest and the live pass answer different questions
                # and neither depends on the other.
                logger.warning("research half failed: %s", part)
                notes.append(f"Part of the research pass failed ({type(part).__name__}).")
                continue
            notes.extend(part.pop("notes", []) or [])
            merged.update(part)

        merged["notes"] = notes
        return merged

    update = await live_context_node(state)

    if state.get("recommendation") is not None:
        update["refresh_cycles"] = state.get("refresh_cycles", 0) + 1

    return update


async def advisor_node(state: ScoutState) -> dict:
    return await cricket_advisor_node(state)


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------


def route_from_advisor(state: ScoutState) -> str:
    """
    Answer, or go back for fresher data.

    A refresh is only worth it when three things hold: the advisor said the
    context was stale, the budget allows it, and there is somewhere to get
    fresher data from. The third is easy to forget -- with every HTML source
    refusing an identified crawler and no search key, a refresh would scrape
    nothing and return, having spent the budget to learn that.
    """
    recommendation = state.get("recommendation")
    if recommendation is None:
        return "done"

    stale = any(
        "days old" in note or "No research recorded" in note
        for note in (recommendation.notes or [])
    )
    if not stale:
        return "done"

    if not may_refresh(state, max_cycles=get_settings().SCOUT_MAX_REFRESH_CYCLES):
        return "done"

    return "refresh"


def route_from_researcher(state: ScoutState) -> str:
    """Back to the advisor if this was an advise turn; otherwise finish."""
    return "advise" if state.get("intent") == "advise" else "done"


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
    graph.add_edge("supervisor", "researcher")
    graph.add_conditional_edges(
        "advisor", route_from_advisor,
        {"refresh": "researcher", "done": END},
    )
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

    final: ScoutState = await app.ainvoke(
        payload.model_dump(), {"configurable": {"thread_id": thread_id}}
    )

    return output_from(final, time.perf_counter() - started)


def output_from(final: ScoutState, elapsed_seconds: float) -> ScoutOutput:
    """
    The final state, as the thing a caller gets back.

    Extracted from `run` because there are now two ways to drive the graph --
    `ainvoke` above and `astream` in the streaming route -- and both have to
    produce an identical ScoutOutput. Two hand-written copies of this mapping
    would drift the first time a field is added, and the drift would show up as
    a field that is present over one transport and missing over the other.
    """
    return ScoutOutput(
        intent=final.get("intent") or "advise",
        recommendation=final.get("recommendation"),
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
