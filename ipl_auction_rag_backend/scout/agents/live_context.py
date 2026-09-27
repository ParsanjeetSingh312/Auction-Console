"""
live_context.py
The Data Researcher's fast path: what the web says about this question, now.

**Why this exists next to `data_researcher.py` rather than inside it.** That
module is an ingest: it pulls a Cricsheet archive, aggregates a few hundred
matches and writes rows to the pool. Measured on 2026-09-25 that is 17.6
seconds for 101 player updates, and it is worth every one of them -- once a
day, on a deliberate call. It is not worth them on a question asked while a lot
is open for seven seconds. So the researcher now has two speeds, and this is
the fast one: one search, one summary, nothing written to the pool.

**The output is prose, not rows, and that is the point.** Ball-by-ball
arithmetic cannot tell you that a player landed yesterday with a hamstring
strain. A search API can, because it has licensed access to material three of
our four configured sources refuse to serve an identified crawler at all
(`config/sources.yaml` records the 403s). That text has no schema worth
imposing, so it travels to the advisor as the paragraph it already is.

**Everything here is bounded twice.** Once by `asyncio.wait_for` around the
whole pass, and once inside the agent loop by a recursion limit. A researcher
node that cannot finish is the failure this module was written to prevent: it
leaves the pipeline showing a node that started and never stopped, which reads
to a user as the product being broken rather than as the web being slow.

**Every model call goes through a thread.** `llm_provider.complete` posts with
synchronous httpx, and `cricket_advisor.py` already carries the measurement of
what that costs when it is awaited directly on the loop: 46.7 seconds of a
stalled event loop, on the same loop that runs the auction's bid timers. This
module follows the rule that file established rather than rediscovering it.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field

from config.settings import get_settings
from scout.tools.search_engine import search_available, web_search

logger = logging.getLogger(__name__)

#: How many search results are worth reading. Above roughly five the marginal
#: result is another rewrite of the same wire story, and every one of them is
#: prompt tokens the advisor pays for.
MAX_RESULTS = 5

#: Characters of each search result kept for the digest. A Tavily `content`
#: field runs to a couple of thousand; the first few hundred carry the fact and
#: the rest carries the site's boilerplate.
SNIPPET_CHARS = 420

#: Ceiling on the assembled context. The advisor's prompt already carries
#: twelve candidate rows and a JSON schema, and a context block that dwarfs
#: them buries the pool data the recommendation is supposed to come from.
CONTEXT_CHARS = 2600

#: Seconds the sub-agent needs before it is worth starting at all.
#:
#: Measured 2026-09-25 against the configured endpoint -- hermes3:8b on a local
#: Ollama, CPU -- one full pass took **116 seconds**: search, read two angles
#: of results, generate. That is not a budget overrun, it is a different order
#: of magnitude from the 8 seconds an advise turn can spare, and starting it
#: anyway would mean every live question paying its whole research budget to
#: produce a timeout and no context.
#:
#: So the rung is skipped rather than attempted when the turn cannot afford
#: it, and the fast path below answers in about 3 seconds instead. A
#: deliberate ingest (`POST /scout/research`) or an explicit generous
#: `budget_seconds` clears this bar and gets the sub-agent. A hosted Hermes,
#: or a GPU, would clear it on ordinary turns too.
HERMES_AGENT_MIN_BUDGET = 25.0

#: Ceiling on what the sub-agent may generate. Unset, a local model will happily
#: spend a minute on a closing paragraph nobody reads. 250 is roughly six
#: findings, which is what the brief asks for.
HERMES_AGENT_MAX_TOKENS = 320

#: Characters of each search result shown to the SUB-AGENT, as opposed to the
#: digest. Smaller, because the model has to read every one of them before it
#: can write a word, and prompt processing on CPU is a real cost: two angles at
#: the digest's 420 characters is roughly 4k of reading per round.
AGENT_SNIPPET_CHARS = 220

#: Turns of the tool loop the Hermes sub-agent may take.
#:
#: Four, which is one search round and an answer. Measured 2026-09-25: at a
#: limit of eight the model searched three times and the pass took 170
#: seconds, most of it re-reading results it already had. Cutting the limit is
#: the single largest speed lever here, because every extra round pays the
#: generation cost again on CPU.
AGENT_RECURSION_LIMIT = 4

#: Low, because this agent reports rather than writes. It is summarising
#: sources into a paragraph another model will act on, so an invented detail
#: here becomes a confident claim in the advice the auctioneer reads.
RESEARCHER_TEMPERATURE = 0.3

#: How far back the news angle looks. Long enough to cover a tournament's worth
#: of injury reports, short enough that last season's form is not presented as
#: this season's.
NEWS_WINDOW_DAYS = 60

#: The researcher's brief.
#:
#: Rewritten 2026-09-25 after watching hermes3:8b answer the first version with
#: "it seems that Virat Kohli and Rinku Singh could be good options ... keep in
#: mind that player performance can change over time". That is advice, hedged,
#: and the previous prompt had already said "do not recommend anyone" in those
#: words. A prohibition alone does not work: told only what not to write, a
#: model writes the most familiar thing instead, which for a cricket question
#: is a recommendation.
#:
#: So this version gives it a shape to fill rather than a rule to obey -- one
#: line per player, each anchored to a name and a concrete fact -- and names
#: the reason, which is that something downstream is going to act on this. A
#: model that knows it is the evidence and not the verdict stops writing
#: verdicts.
_SYSTEM = (
    "You are a cricket data researcher for an IPL auction. You do not give "
    "advice and you do not pick players: another agent does that, using what "
    "you write. Your job is evidence.\n\n"
    "Report ONLY what the sources actually say. Write at most six lines. "
    "Every line must name a specific player and state one concrete fact about "
    "them from the sources -- a number, an injury, a return date, a change of "
    "team, a run of scores. Prefer facts that would change a bid: fitness, "
    "availability, recent form, and role.\n\n"
    # A format to copy, not just rules to follow. Added 2026-09-25 after the
    # model spent its entire 250-token budget on "Shubman Gill had a good
    # performance in the last IPL season. Here are some stats from IPL 2026:"
    # and was cut off before writing a single fact. Small models open with a
    # preamble by default; the cheapest way to stop one is to show the shape
    # of a reply that has no room for it.
    "Start immediately with the first finding. Write NO introduction, no "
    "greeting, no 'here are the stats', and no closing sentence. Use exactly "
    "this shape, one finding per line:\n"
    "Shubman Gill - scored 104 off 52 against RR in Qualifier 2, IPL 2026.\n"
    "Rinku Singh - hit a half-century against Gujarat Titans in his first "
    "game of the season.\n\n"
    "Never write a recommendation, a ranking of your own, or a caveat about "
    "form changing over time. Never state a fact the sources do not contain. "
    "If a source is an advertisement, a forum post or a generic explainer with "
    "no player facts in it, ignore it entirely. If none of the sources contain "
    "a usable player fact, reply with exactly: NO USABLE FINDINGS."
)


@dataclass
class LiveContext:
    """What one fast pass found, and how it found it."""

    #: The paragraph handed to the advisor. None when nothing usable came back,
    #: which is a normal outcome and not an error.
    text: str | None = None
    notes: list[str] = field(default_factory=list)
    #: Which rung answered: "hermes_agent", "hermes", "digest", or "none".
    #: Reported for the same reason `engine_used` is -- a summary written by a
    #: model and a summary assembled by string join are different artefacts and
    #: should not be presented as one.
    engine: str = "none"
    results: int = 0


async def search_angles(question: str) -> tuple[list, list[str]]:
    """
    Three searches, concurrently, because they answer different questions.

    **A user's question is a poor search query on its own.** Measured
    2026-09-25 against "who should I bid on for a death-overs finisher?": sent
    raw, Tavily returned auction-software advertising, a reddit thread and a
    coaching institute's SEO page. The same question prefixed with "IPL 2026"
    returned a 17-20 over leaderboard and per-team death-bowling rankings. The
    prefix is doing the work a search engine cannot do for us -- it says which
    sport, which league and which season, none of which the question states.

    **The angles do not subsume each other.** The priority angle asks the
    authoritative domains (SCOUT_PRIORITY_DOMAINS, espncricinfo by default)
    and is the one that returns canonical current-season figures. The general
    angle finds leaderboards and analysis the restricted one misses.
    `topic="news"` inside a 60-day window finds the events -- a confirmed
    hamstring, a player back from injury -- which is the half the pool
    spreadsheet structurally cannot hold.

    Run with `gather`, so three searches cost what one does: roughly 2.7
    seconds either way. Priority results are added first and therefore lead
    the digest, which matters because the digest is truncated.

    Deduplicated by title, because a wire story reprinted by four sites is one
    fact, and paying prompt tokens for it four times crowds out the pool rows
    the recommendation has to come from.
    """
    asked = " ".join((question or "").split())[:200]
    settings = get_settings()
    priority = settings.priority_domains
    # Every angle is confined to cricket domains. See SCOUT_CRICKET_DOMAINS
    # for why this is a domain restriction rather than the word "cricket" in
    # the query: a search engine may ignore a hint, and did.
    cricket = settings.cricket_domains or None

    searches = [
        # The priority angle. Same query as the general one, restricted to the
        # authoritative domains, and placed first below so its results survive
        # the CONTEXT_CHARS cut that trims the tail of the digest.
        web_search(
            f"IPL 2026 {asked}",
            max_results=MAX_RESULTS,
            include_domains=priority,
        )
        if priority
        else None,
        web_search(f"IPL 2026 {asked}", max_results=MAX_RESULTS,
                   include_domains=cricket),
        web_search(
            f"IPL 2026 {asked} player injury fitness availability",
            max_results=MAX_RESULTS,
            topic="news",
            days=NEWS_WINDOW_DAYS,
            include_domains=cricket,
        ),
    ]
    results = await asyncio.gather(
        *[c for c in searches if c is not None], return_exceptions=True
    )

    refs: list = []
    notes: list[str] = []
    seen: set[str] = set()

    for result in results:
        if isinstance(result, BaseException):
            # One angle failing is a thinner answer, not a failed turn.
            logger.warning("search angle failed: %s", result)
            notes.append(f"One search angle failed ({type(result).__name__}).")
            continue
        found, found_notes = result
        notes.extend(found_notes)
        for ref in found:
            key = " ".join((ref.player_name or "").split()).lower()[:80]
            if key and key in seen:
                continue
            seen.add(key)
            refs.append(ref)

    return refs, notes


#: Fragments that mean a snippet is chrome rather than content. Matched case
#: insensitively against the text, which is scraped page body and arrives
#: carrying whatever the site wraps its article in. Observed in live results:
#: a coaching institute's contact number and a director's message came back as
#: the top hit for "death-overs finisher", and went into the advisor's prompt
#: as though they were cricket.
_BOILERPLATE = (
    "contact-us", "contact us", "director's message", "privacy policy",
    "terms of service", "subscribe", "cookie", "sign up", "all rights reserved",
    "advertisement", "download the app",
)

#: Markdown a scraper leaves behind. The advisor's prompt is plain text and a
#: stray "##" spends a token saying nothing.
_MARKUP = re.compile(r"[#*_`>\[\]]+")


def _clean(text: str) -> str:
    """
    One snippet, reduced to prose.

    Collapses whitespace, strips scraper markup, and drops the sentences that
    are the site rather than the story. Conservative on purpose: it removes
    clauses it recognises and keeps everything else, because a filter that
    guesses will eventually throw away the injury report.
    """
    flat = " ".join(_MARKUP.sub(" ", text or "").split())
    kept = [
        part.strip()
        for part in flat.split(". ")
        if part.strip() and not any(bad in part.lower() for bad in _BOILERPLATE)
    ]
    cleaned = ". ".join(kept)

    # A scraped page's navigation survives everything above: it has no
    # boilerplate phrase and no markup, just short tokens. Observed on
    # espncricinfo's own series-stats page, which came back as "PAK-W SL-W
    # Flag SL-W null BAN-W Flag BAN-W IND-W ..." -- a team-selector widget,
    # read as cricket by anything that only checks for keywords.
    #
    # Real prose about a player runs to a sentence. Chrome does not, so the
    # test is whether enough of the text is word-shaped: fewer than eight
    # words of three letters or more and there is nothing here to report.
    words = [w for w in cleaned.split() if len(w) >= 3 and any(c.isalpha() for c in w)]
    return cleaned if len(words) >= 8 else ""


def _digest(question: str, refs) -> str:
    """
    The search results as a readable block, with no model involved.

    The bottom rung, and the one that runs today: with `HERMES_API_BASE_URL`
    blank there is nothing to summarise with, and a question answered from five
    labelled snippets is strictly better than one answered from none. It reads
    plainly as what it is -- excerpts, attributed -- so nobody mistakes it for
    an analysis.
    """
    lines = [f"Live web findings for: {question}", ""]
    kept = 0
    for ref in refs:
        title = _clean(ref.player_name or "")[:110]
        body = _clean(ref.text or "")[:SNIPPET_CHARS]
        # A result whose body was entirely boilerplate is not a thin result,
        # it is not a result. Passing it on would spend the advisor's prompt
        # on a cookie banner.
        if not body:
            continue
        kept += 1
        lines.append(f"{kept}. {title} - {body}")
    if kept == 0:
        return ""
    return "\n".join(lines)[:CONTEXT_CHARS]


async def _summarise_with_hermes(question: str, digest: str, timeout: float) -> str:
    """
    One Hermes call to compress the digest. No tools, no loop.

    The middle rung: used when Hermes is configured but the sub-agent path is
    unavailable. `complete` is synchronous, so it runs in a thread -- see the
    module docstring.
    """
    from rag import llm_provider

    def _call() -> str:
        return llm_provider.complete(
            system=_SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": f"QUESTION: {question}\n\nSOURCES:\n{digest}",
                }
            ],
            task="research",
            prefer="hermes",
            temperature=RESEARCHER_TEMPERATURE,
            max_tokens=400,
            timeout=timeout,
        )

    return (await asyncio.to_thread(_call)).strip()


async def _run_hermes_agent(question: str, timeout: float) -> tuple[str, list[str]]:
    """
    Hermes and the search tool as a managed sub-agent, via `create_react_agent`.

    **Why a sub-agent rather than another node.** A tool loop is a loop: the
    model asks for a search, reads it, and may ask again. Modelling that as
    edges in the main graph would put an unbounded cycle next to the one
    bounded cycle SCOUT already has, and the whole turn's budget would be the
    only thing stopping it. `create_react_agent` owns that loop, keeps its
    messages in its own state, and hands back a finished answer -- so the main
    graph sees one node that returns, which is exactly what it needs to see.

    **The tool is our own `web_search`, not langchain-community's Tavily
    wrapper.** That function is already the measured, working client -- it
    sends the key in both the header and the body because Tavily moved between
    the two, and it returns notes instead of raising. Wrapping a second client
    around the same API would mean two code paths to the same vendor and only
    one of them tested.

    Raises on any failure. The caller catches and drops to a lower rung: this
    path is an upgrade, and an upgrade that fails must not take the turn with
    it.
    """
    from langchain_core.tools import tool
    from langgraph.prebuilt import create_react_agent

    # Imported separately and last: this is the one piece that is not already
    # a dependency, so its absence gets its own, nameable error.
    from langchain_openai import ChatOpenAI

    settings = get_settings()
    base = (settings.HERMES_API_BASE_URL or "").strip().rstrip("/")
    notes: list[str] = []
    #: How many times the model actually searched. Checked after the run; see
    #: the grounding guard below for why this is not merely diagnostic.
    searches = 0

    @tool
    async def search_cricket_web(
        query: str = "",
        player: str = "",
        players: str = "",
        name: str = "",
        event: str = "",
        player_type: str = "",
        role: str = "",
        topic: str = "",
        year: str | int | None = None,
        season: str | int | None = None,
    ) -> str:
        """
        Search the web for recent IPL player form, injuries and availability.

        Pass the full search phrase as `query`, for example
        "IPL 2026 death overs finisher form".
        """
        # **Every parameter is optional, and that is load-bearing.** Measured
        # 2026-09-25 against hermes3:8b: asked to research death-overs
        # finishers it called this tool three times out of three and never
        # once sent `query`. It sent {"year": 2026, "event": "IPL auction",
        # "player_type": "death-overs finishers"}, then {"year": 2026} twice --
        # argument names it invented.
        #
        # With `query` required, each of those is a schema violation, the tool
        # never runs, and the model answers from its weights instead. That is
        # precisely the hallucinated Bumrah figures the grounding guard below
        # was added to catch. An 8b model will not be argued into a schema, so
        # the schema accommodates it: the names it actually reaches for are
        # accepted, and the phrase is assembled from whatever arrives.
        #
        # The fallback to the question itself is the floor. However odd the
        # arguments, a real search happens, so the answer is grounded in
        # something fetched rather than something remembered.
        nonlocal searches
        searches += 1

        # **The question always goes in, and the model's arguments only add to
        # it.** They never replace it, and this is the whole lesson of the
        # Shubman Gill failure on 2026-09-25.
        #
        # Asked "Shubman Gill stats last season", hermes3:8b called this tool
        # with {"player": "Shubman Gill", "topic": "stats", "year": "2021"}.
        # `player` was not a parameter, so it was dropped; the builder then
        # assembled "2021 stats" from what remained and searched for that. The
        # name -- the only word that mattered -- was gone, the results were
        # generic season pages, and the model, having learned nothing, wrote
        # 2021 KKR figures from memory.
        #
        # The old fallback did not save it: `" ".join(parts) or question` only
        # fires when parts is EMPTY, and "2021 stats" is not empty. A partial
        # query is more dangerous than no query, because it silently succeeds.
        #
        # `year` and `season` are accepted and then ignored on purpose. The
        # model invents them -- "last season" became 2021 -- and a wrong year
        # in a search phrase is worse than no year, while `search_angles`
        # already anchors every query to the current season.
        entities = [
            str(p).strip()
            for p in (player, players, name, event, player_type, role)
            if p and str(p).strip()
        ]
        # `query` only when the model wrote a real phrase rather than echoing
        # a single word already covered by the question.
        if query and len(str(query).split()) > 1:
            entities.append(str(query).strip())

        seen_terms: list[str] = []
        for term in entities:
            if term.lower() not in question.lower() and term not in seen_terms:
                seen_terms.append(term)

        phrase = " ".join([question, *seen_terms]).strip() or question

        # The same two angles the direct path uses, so the sub-agent and the
        # fallback below are looking at the same web rather than at two
        # different ones -- otherwise "it was better before Hermes" becomes
        # impossible to attribute.
        refs, tool_notes = await search_angles(phrase)
        notes.extend(tool_notes)
        if not refs:
            return "No results."
        return "\n".join(
            f"- {' '.join((r.player_name or '').split())[:90]}: "
            f"{_clean(r.text or '')[:AGENT_SNIPPET_CHARS]}"
            for r in refs[:MAX_RESULTS]
        )

    model = ChatOpenAI(
        base_url=base,
        # A local Ollama needs no key and rejects a bare "Bearer "; the SDK
        # insists on a non-empty string, so an explicit placeholder is sent
        # when there is genuinely nothing to send.
        api_key=(settings.HERMES_API_KEY or "").strip() or "ollama",
        model=settings.HERMES_RESEARCHER_MODEL,
        temperature=RESEARCHER_TEMPERATURE,
        timeout=timeout,
        max_tokens=HERMES_AGENT_MAX_TOKENS,
        # No retries. A retry inside a node that is already the slowest thing
        # in the turn spends the budget twice to fail twice.
        max_retries=0,
    )

    # The researcher's brief plus the one instruction it does not contain:
    # that there is a tool, and that it must be used. `_SYSTEM` is shared with
    # the no-tool summarise rung, where an order to search would be nonsense.
    #
    # Stated as the first thing in the prompt and in the imperative, because
    # the first version said only "report what the sources say" and left the
    # model to infer that fetching them was its job. It did not infer it.
    agent = create_react_agent(
        model,
        [search_cricket_web],
        prompt=(
            "ALWAYS call the search_cricket_web tool FIRST, before you write "
            "anything at all. Pass the full search phrase as `query`. You have "
            "no current knowledge of your own: anything you write that did not "
            "come back from that tool is a fabrication. Never answer from "
            "memory.\n\n" + _SYSTEM
        ),
    )
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": question}]},
        {"recursion_limit": AGENT_RECURSION_LIMIT},
    )

    messages = result.get("messages") or []
    text = ""
    for message in reversed(messages):
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            text = content.strip()
            break
    if not text:
        raise RuntimeError("the sub-agent returned no text")

    # **The grounding guard, and it is not paranoia.** Observed 2026-09-25 on
    # this exact configuration: asked to research death-overs finishers,
    # hermes3:8b replied "Sure, I can help with that" and then produced
    # "Jasprit Bumrah ... 89 wickets in 105 innings at an economy rate of
    # 7.54" -- specific, plausible, formatted as findings, and never searched
    # for. The figures came out of the model's weights, not off the web.
    #
    # An 8b model is not reliable at deciding to call a tool, and the failure
    # is silent: the answer looks MORE authoritative than the honest digest it
    # would otherwise have produced, and it feeds an advisor that quotes its
    # sources. So an answer produced without a single search is refused here,
    # and the caller falls to the grounded path below. Research that did not
    # look anything up is not research.
    if searches == 0:
        raise RuntimeError("the sub-agent answered without searching")

    text = _strip_preamble(text)

    notes.append(f"Hermes sub-agent searched {searches} time(s).")
    return text[:CONTEXT_CHARS], notes


def _strip_preamble(text: str) -> str:
    """
    A model's findings, with the scaffolding it insists on removed.

    **Prompting did not achieve this and was not going to.** The brief tells
    the model to start with the first finding, forbids an introduction in
    those words, and shows two correctly-formatted example lines. hermes3:8b
    still opened with "Shubman Gill had a good performance in the last season
    of IPL 2026. Here are some highlights from his stats:" -- once while being
    cut off mid-answer by the token cap, and again after the format example
    was added.

    That is a habit of small instruction-tuned models, not a misunderstanding,
    so it is removed here instead. Prompt for what a model can reliably do;
    enforce in code what it cannot. The cost of being wrong is one dropped
    line, and a line ending in a colon carries no fact by construction.
    """
    lines = [ln.strip() for ln in (text or "").splitlines()]
    out: list[str] = []

    for line in lines:
        if not line:
            continue
        # An intro announcing the list that follows. Always ends in a colon
        # and never carries a figure, so it is safe to drop while nothing has
        # been kept yet -- afterwards a colon is likely part of a real finding.
        if not out and line.endswith(":"):
            continue
        # "1. ", "2) ", "- " -- numbering the brief did not ask for.
        line = re.sub(r"^(?:\d+[.)]\s*|[-*]\s+)", "", line)
        if line:
            out.append(line)

    return "\n".join(out).strip() or (text or "").strip()


async def gather(question: str, *, timeout: float) -> LiveContext:
    """
    One fast research pass for one question.

    The ladder, best first: the Hermes sub-agent, then a single Hermes summary,
    then the raw digest. Each rung is tried only if the one above it is
    unavailable or failed, and every fall is recorded in `notes` -- the same
    bargain the RAG chain already makes, so a degraded answer arrives looking
    degraded rather than confident.

    Never raises. A researcher that throws takes down a turn the advisor could
    have answered without it.
    """
    from rag import llm_provider

    started = time.perf_counter()
    out = LiveContext()

    if not search_available():
        out.notes.append(
            "Live research skipped: TAVILY_API_KEY is not set, so the advisor "
            "is answering from the pool alone."
        )
        return out

    # --- top rung: Hermes drives the search itself --------------------------
    use_hermes = (
        get_settings().SCOUT_RESEARCHER_USES_HERMES and llm_provider.hermes_configured()
    )
    if use_hermes and timeout < HERMES_AGENT_MIN_BUDGET:
        out.notes.append(
            f"Hermes sub-agent skipped: it needs about "
            f"{HERMES_AGENT_MIN_BUDGET:.0f}s and this turn has {timeout:.0f}s. "
            "Searching directly instead."
        )
        use_hermes = False

    if use_hermes:
        try:
            text, tool_notes = await _run_hermes_agent(question, timeout)
            out.text, out.engine = text, "hermes_agent"
            out.notes.extend(tool_notes)
            out.notes.append(
                "Live research by the Hermes sub-agent "
                f"({get_settings().HERMES_RESEARCHER_MODEL}) in "
                f"{time.perf_counter() - started:.1f}s."
            )
            return out
        except ImportError:
            out.notes.append(
                "Hermes is configured but the sub-agent needs langchain-openai, "
                "which is not installed; searching directly instead."
            )
        except Exception as exc:  # noqa: BLE001 - any failure drops a rung
            logger.warning("Hermes sub-agent failed: %s", exc)
            out.notes.append(
                f"The Hermes sub-agent failed ({type(exc).__name__}); "
                "searching directly instead."
            )

    # --- the search itself --------------------------------------------------
    refs, notes = await search_angles(question)
    out.notes.extend(notes)
    out.results = len(refs)
    if not refs:
        out.notes.append("Live search returned nothing for this question.")
        return out

    digest = _digest(question, refs)
    if not digest:
        out.notes.append(
            "Live search returned results but none carried a usable player "
            "fact; answering from the pool."
        )
        return out
    out.text, out.engine = digest, "digest"

    # --- middle rung: one Hermes call to compress it ------------------------
    if use_hermes:
        left = timeout - (time.perf_counter() - started)
        if left > 2.0:
            try:
                summary = await _summarise_with_hermes(question, digest, left)
                if summary:
                    out.text, out.engine = summary[:CONTEXT_CHARS], "hermes"
            except Exception as exc:  # noqa: BLE001
                logger.warning("Hermes summary failed: %s", exc)
                out.notes.append(
                    f"Hermes could not summarise the results ({type(exc).__name__}); "
                    "passing the excerpts through as they are."
                )

    how = "summarised by Hermes" if out.engine == "hermes" else "passed through as excerpts"
    out.notes.append(
        f"Live research: {len(refs)} web result(s) in "
        f"{time.perf_counter() - started:.1f}s ({how})."
    )
    return out


async def live_context_node(state, *, budget_override: float | None = None) -> dict:
    """
    The researcher's advise-turn behaviour, as a LangGraph node.

    **It does not touch `refresh_cycles`.** That counter bounds the advisor's
    cyclic edge -- "how many times has the advisor sent this turn back for
    fresher data" -- and this node now runs once on every advise turn as the
    normal path, before the advisor has said anything at all. Counting that
    first, mandatory pass as a refresh would spend the whole allowance
    (SCOUT_MAX_REFRESH_CYCLES is 1) before the cycle it guards could ever be
    taken. `workflow.researcher_node` increments it instead, because only the
    graph knows whether it reached this node from START or from the advisor.
    """
    from rag.llm_provider import hermes_configured
    from scout.graph.state import seconds_left

    settings = get_settings()

    if budget_override is not None:
        # A deliberate research turn, which is the only kind with room for the
        # Hermes sub-agent. The caller has already decided how long it may
        # take, so the halving rule below -- which exists to leave the advisor
        # its share -- does not apply: on a research turn there is no advisor
        # after this node.
        budget = max(1.0, budget_override)
    elif settings.SCOUT_RESEARCHER_USES_HERMES and hermes_configured():
        # Hermes is switched on, so the node is given what Hermes needs rather
        # than what is left over. The halving rule below is deliberately NOT
        # applied here: half of an advise turn is about eight seconds, the
        # sub-agent needs thirty, and the arithmetic that produced that eight
        # is what kept it permanently skipped.
        #
        # `supervisor_node` has already widened the turn's deadline by this
        # same amount, so this is spending budget that was allocated for it,
        # not borrowing the advisor's.
        budget = settings.SCOUT_HERMES_AGENT_TIMEOUT
    else:
        left = seconds_left(state)
        # Never take more than half of what is left. The advisor still has to
        # retrieve, reason and be parsed after this, and a researcher that
        # spends the whole budget produces a turn where the only thing that
        # finished was the research.
        budget = settings.SCOUT_LIVE_CONTEXT_TIMEOUT
        if left != float("inf"):
            budget = min(budget, max(1.0, left / 2))

    try:
        found = await asyncio.wait_for(
            gather(state.get("question", ""), timeout=budget), timeout=budget
        )
    except asyncio.TimeoutError:
        return {
            "notes": [
                f"Live research stopped after {budget:.0f}s to keep the turn "
                "inside its budget; answering from the pool."
            ],
        }

    return {"research_context": found.text, "notes": found.notes}
