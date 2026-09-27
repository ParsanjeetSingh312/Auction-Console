from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # --- Paths ---
    PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
    EXCEL_FILE_PATH: str = str(Path(__file__).resolve().parent.parent.parent / "IPL AUCTION DATA.xlsx")
    SQLITE_DB_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "database" / "ipl_auction.db")
    CHROMA_DB_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "database" / "chroma_db")

    # --- Supabase / PostgreSQL ---
    #
    # DATABASE_URL is the ONLY switch. Empty -- the default, and the state of
    # every developer machine -- means the players table is read from SQLite at
    # SQLITE_DB_PATH, exactly as it always has been. Set, it means Supabase.
    #
    # Expressed once, as the `use_postgres` property below, so that no call site
    # re-derives the rule. That is what keeps the change at each call site down
    # to which manager it asks for, rather than a rewrite of its queries.
    #
    # Note what this does NOT switch. SQLite still backs Chroma's store and
    # SCOUT's langgraph checkpointer, neither of which Supabase replaces, and
    # both of which live under SQLITE_DB_PATH's directory. Postgres here means
    # the players table and nothing else.
    #
    # Must be the SESSION POOLER string. Supabase's direct connection
    # (db.<ref>.supabase.co:5432) is IPv6-only, and on an IPv4-only network it
    # does not refuse -- it HANGS, until whatever timeout is shortest gives up.
    # `database_url_problem` below catches that before it costs an afternoon.
    DATABASE_URL: str = ""

    # The REST/realtime side of the same project. Not used for the player table
    # -- that goes over Postgres through DATABASE_URL -- and declared because
    # render.yaml sets them and pydantic's `extra: 'ignore'` would otherwise
    # swallow them silently, leaving no way to tell a typo from an omission.
    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""

    # Connection pool bounds, used only when use_postgres is true.
    #
    # Sized for ONE uvicorn worker, which is a hard constraint rather than a
    # choice: the auction room is in-process state, so this service scales up
    # and never out (see start.sh). Four connections comfortably covers the
    # console's hydration, a RAG query and an auction lot at the same time,
    # while staying far below Supabase's per-project ceiling -- which the
    # pooler shares across every client, including a psql window left open.
    #
    # min_size 1 keeps a single connection warm so the first query after an
    # idle spell does not pay the TCP-plus-TLS handshake.
    DB_POOL_MIN_SIZE: int = 1
    DB_POOL_MAX_SIZE: int = 4

    # --- Keep-alive ---
    #
    # OFF by default, and that is the intended state in production too, because
    # UptimeRobot does this job from outside. Two pingers on the same endpoint is
    # not twice as safe, it is just twice the log noise, and an external monitor
    # is strictly better at it for two reasons:
    #
    #   1. It keeps working when the thing you want to detect has happened. A
    #      self-ping cannot report that the process is down, because the process
    #      doing the reporting is the one that died.
    #   2. It tests the whole path a real visitor takes -- DNS, TLS, Render's
    #      proxy, then the app -- where a self-ping from inside the container
    #      can pass while the service is unreachable from the internet.
    #
    # So this loop is a fallback, kept for a deployment with no external monitor
    # attached. Set KEEP_ALIVE_ENABLED=true and it runs; leave it and it logs
    # that it is disabled and returns.
    #
    # What it was written for: Render idles a FREE web service after roughly
    # fifteen minutes without an inbound request, and waking it costs a cold
    # start -- which here means reloading ~2.4 GB of Hugging Face weights, so the
    # first visitor after an idle spell waits a long time. On a PAID plan the
    # service never idles and none of this applies.
    KEEP_ALIVE_ENABLED: bool = False

    # Where to ping. Empty means "use RENDER_EXTERNAL_URL", which Render injects
    # automatically with this service's own public address -- so normally this
    # stays empty even when the loop is enabled. Set it to point somewhere else.
    KEEP_ALIVE_URL: str = ""

    # 300 seconds, comfortably inside Render's idle window and with room for one
    # request to fail without the gap growing past it.
    KEEP_ALIVE_INTERVAL: float = 300.0

    # --- Embedding Model (runs locally on CPU) ---
    EMBEDDING_MODEL_NAME: str = "BAAI/bge-small-en-v1.5"
    
    # --- Reranker Model (runs locally on CPU) ---
    RERANKER_MODEL_NAME: str = "BAAI/bge-reranker-large"
    
    # --- LLM provider ---
    # "auto" picks whichever key is present, preferring Gemini when both are.
    # Set to "gemini", "groq" or "anthropic" to pin it.
    #
    # "auto" is a ladder, not a single pick: Anthropic, then Gemini, then Groq,
    # trying the next rung when one fails mid-request. Claude leads because it
    # is the deliberate, paid choice a user makes by adding that key; with no
    # Anthropic key the ladder simply starts at Gemini, which is why this file
    # needs no edit on the day one is added.
    #
    # Naming a provider explicitly PINS it and disables the ladder -- an
    # operator who said "groq" gets Groq or nothing, rather than silently
    # having their traffic served by a vendor they did not name.
    LLM_PROVIDER: str = "auto"

    # --- Anthropic (Claude) ---
    # SCOUT's engine. One model covers planning, extraction and advice: the
    # per-task split below exists so Groq usage can be spread across separate
    # free-tier accounts, and Anthropic has no equivalent to spread.
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-sonnet-5"

    # --- Hermes (remote, OpenAI-compatible) ---
    # A Hermes deployment reached over the OpenAI chat-completions shape, used
    # as SCOUT's reasoning engine.
    #
    # Deliberately NOT a rung of the `auto` ladder above. SCOUT asks for Hermes
    # by name, so nothing that already works -- the console's search, its chat,
    # the Scout panel in /data -- can be silently rerouted onto a host this
    # project does not own and cannot restart.
    #
    # Blank means "not configured", and the advisor uses the local ladder
    # instead. That is the honest default: an address with nothing behind it
    # buys a refused connection and a warning on every single query, which
    # reads as broken rather than as off.
    HERMES_API_BASE_URL: str = ""

    # Hermes is open source and the usual ways of serving it -- Ollama,
    # llama.cpp, an unauthenticated vLLM -- want no key at all. Blank omits the
    # Authorization header entirely rather than sending a bare "Bearer ", which
    # some servers reject outright instead of ignoring.
    HERMES_API_KEY: str = ""

    # Two models, because the two nodes do different work: pulling fields out of
    # a scraped page is a small-model job, reasoning about a squad under a purse
    # constraint is not.
    #
    # These must match what the server answers to, which is rarely what the
    # model is called in prose. Ollama tags look like `hermes3:70b`; a vLLM
    # deployment usually wants the full repository id. Ask the server rather
    # than guessing:  GET {HERMES_API_BASE_URL}/models
    HERMES_RESEARCHER_MODEL: str = "hermes3:8b"
    HERMES_ADVISOR_MODEL: str = "hermes3:70b"

    # Ceiling for one Hermes call. This is a network hop to a host that may be
    # asleep, and the auction opens a lot for seven seconds -- so the advisor
    # passes a shorter deadline than this when a lot is actually live, and this
    # value only applies to auction prep, where a considered answer is worth
    # waiting for. Past either deadline the local ladder answers instead.
    HERMES_TIMEOUT: float = 20.0

    # Whether the Data Researcher runs its live pass as a Hermes sub-agent --
    # Hermes driving the search tool itself rather than us searching and asking
    # it to summarise. Requires HERMES_API_BASE_URL and langchain-openai.
    #
    # This setting was declared for a year and read by nothing. It is live now,
    # and it is the switch that turns the sub-agent on.
    SCOUT_RESEARCHER_USES_HERMES: bool = False

    # Whether the Cricket Advisor prefers Hermes over the Groq/Gemini ladder.
    # Off, and deliberately separate from the researcher's switch above.
    #
    # The two agents want different models and the difference is not a
    # preference. The advisor must return a JSON object satisfying
    # AdvisorRecommendation's schema; HERMES_ADVISOR_MODEL names hermes3:70b
    # for that reason, and a local Ollama serving hermes3:8b is not that model.
    # Before this flag existed the advisor preferred Hermes the moment a base
    # URL was set for ANY reason -- so configuring the researcher silently
    # pointed the advisor at a model that is not installed, costing a 404 and a
    # fallback on every question.
    SCOUT_ADVISOR_USES_HERMES: bool = False

    # --- Google Gemini ---
    # A single model serves routing, text-to-SQL and synthesis; 2.5 Flash is
    # fast and cheap enough that splitting them buys nothing.
    GEMINI_API_KEY: str = ""
    # Benchmarked 2026-09-19, 5 calls each on an identical prompt:
    #
    #     gemini-2.5-flash        min 1.8s   median 2.0s   max  2.2s   0/5 failed
    #     gemini-3.5-flash        min 6.1s   median 7.7s   max  8.5s   2/5 failed
    #     gemini-3.5-flash-lite   min 1.9s   median 2.2s   max  3.1s   0/5 failed
    #
    # 3.5-flash is newer and worse here: nearly 4x the latency and a failure
    # rate that drops answers to the deterministic analyst without the user
    # asking for it. A search makes up to three model calls, so the median
    # difference is 6 seconds against 23. The 3.x tier also returned 503 on
    # 3.6, 3.7 and 3.8 the same day, which points at capacity rather than at
    # anything this code does.
    #
    # Revisit when the 3.x tier settles. Take more than two samples next time:
    # two calls said 4.6s, five said 7.7s with 40% failures.
    GEMINI_MODEL: str = "gemini-2.5-flash"

    # Routing is a three-way classification, not a reasoning task, and the lite
    # model answers it in about a quarter of the time (measured: 1.2s against
    # 4.6s). Since every query routes before it does anything else, that gap
    # comes off the front of every request. Groq has split its models per task
    # since the start, for the same reason; Gemini only became worth splitting
    # when the spread grew this wide.
    GEMINI_ROUTER_MODEL: str = "gemini-3.5-flash-lite"

    # --- LLM Models & Dedicated API Keys ---
    # Master Groq key (used as default for any unset model keys)
    GROQ_API_KEY: str = ""
    
    # Model-specific API keys (optional: enter individually or leave blank to inherit GROQ_API_KEY)
    TEXT_TO_SQL_API_KEY: str = ""       # Dedicated key for Qwen / SQL model
    RAG_SYNTHESIS_API_KEY: str = ""     # Dedicated key for Llama RAG synthesis
    QUERY_ROUTER_API_KEY: str = ""      # Dedicated key for query routing
    HUGGINGFACE_API_KEY: str = ""       # Optional Hugging Face Hub token
    
    # Model Names
    #
    # The three llama-* names that were here are GONE: Groq retired the Llama
    # family, and every call returned 404 "does not exist or you do not have
    # access to it" -- which surfaced as a working fallback ladder producing
    # rule-based answers anyway.
    #
    # Benchmarked 2026-09-19, 5 calls each on an identical prompt:
    #
    #     qwen/qwen3.8-27b       median 0.48s   0/5 failed   clean SQL
    #     openai/gpt-oss-120b    median 1.03s   0/5 failed   clean SQL
    #     groq/compound-mini     median 1.41s   0/5 failed   clean SQL
    #     openai/gpt-oss-20b     median 0.96s   3/5 FAILED   SQL call failed
    #
    # Routing is a classification, so it takes the fastest clean model.
    # Text-to-SQL and synthesis take the larger one: a wrong query and a
    # badly written answer both cost more than half a second.
    #
    # Check these against `GET https://api.groq.com/openai/v1/models` rather
    # than assuming -- the catalogue above replaced the previous one entirely.
    RAG_LLM_MODEL: str = "openai/gpt-oss-120b"      # For RAG synthesis
    # SQL runs on qwen, not on the larger gpt-oss. gpt-oss-120b is a reasoning
    # model and those tokens come out of max_tokens: measured at the 300 that
    # text_to_sql actually asks for, it spent 248 on reasoning and truncated the
    # statement mid-expression -- `AND bat_avg IS;` -- which SQLite rejects and
    # the chain then blamed on the model with "Generated SQL failed".
    #
    # `reasoning_effort="low"` fixes it for gpt-oss and BREAKS qwen, which does
    # not reason by default and starts doing so when asked to do it a little.
    # The parameter means opposite things to the two families, so the models are
    # chosen to suit the budget instead of the budget being patched per family.
    #
    # qwen on the real text_to_sql path: 5/5 valid statements, 0.5-1.7s each.
    SQL_LLM_MODEL: str = "qwen/qwen3.8-27b"        # For Text-to-SQL
    ROUTER_LLM_MODEL: str = "qwen/qwen3.8-27b"     # For intent classification
    
    # Local Inference Option (Ollama)
    #
    # Declared before this phase and read by nothing -- no module imports
    # either name. Left in place rather than deleted, because removing a
    # setting someone may have filled in is a worse surprise than an unused
    # one. To actually reach a local server, point HERMES_API_BASE_URL at it:
    # Ollama serves the OpenAI shape at http://localhost:11434/v1, which is the
    # same protocol the Hermes transport speaks.
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    USE_OLLAMA: bool = False
    
    # --- API Config ---
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8001
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:8000,http://localhost:8001"

    # --- Auctioneer authentication ---
    # The password that gates the auctioneer's chair. Only that one seat is
    # protected: franchises and spectators still join freely, exactly as before.
    #
    # Empty means the chair is LOCKED, not open -- the room refuses every
    # auctioneer login until this is set. That is the secure default: an auction
    # nobody can start yet is a smaller problem than one any stranger on the
    # network can seize, and the refusal says exactly what to set.
    #
    # Verified server-side and compared in constant time. It is never sent to a
    # client, never written to a log, and never appears in a broadcast.
    AUCTIONEER_PASSWORD: str = ""

    # Admin key for the destructive and expensive endpoints: POST /api/v1/ingest
    # (rebuilds the whole player pool) and POST /api/v1/scout/research (spends a
    # scrape/embed budget). Sent as the `X-Admin-Key` header and compared in
    # constant time.
    #
    # Empty leaves those endpoints OPEN but logs a warning on every use, so local
    # development keeps working unchanged. SET THIS BEFORE DEPLOYING -- an
    # unauthenticated ingest lets anyone who can reach the API wipe and rebuild
    # the pool.
    ADMIN_API_KEY: str = ""
    
    # --- Retrieval Config ---
    VECTOR_SEARCH_TOP_K: int = 20
    RERANK_TOP_K: int = 5
    
    # ==========================================================================
    # SCOUT orchestrator
    #
    # Everything below was added by the SCOUT phase. None of it is read by the
    # existing RAG chain, the auction room or the API, so an unset value here
    # costs SCOUT a capability and costs the rest of the backend nothing.
    # ==========================================================================

    # --- Sources ---
    # The Data Researcher reads only what this file lists. Nothing is hardcoded
    # in the scraper, so changing what SCOUT looks at is a config edit rather
    # than a code change.
    SCOUT_SOURCES_PATH: str = str(Path(__file__).resolve().parent / "sources.yaml")

    # --- Web acquisition ---
    # Headless by default; set false to watch a scrape run, which is the only
    # practical way to debug a selector that has silently stopped matching.
    PLAYWRIGHT_HEADLESS: bool = True

    # Per-page ceiling in seconds. A source slower than this is recorded as a
    # failure and handed to the search fallback rather than held open, so one
    # unresponsive site cannot stall the graph.
    SCOUT_SCRAPE_TIMEOUT: float = 20.0

    # Politeness gap between two requests to the same host. sources.yaml may
    # raise this per source; it may not lower it.
    SCOUT_REQUEST_DELAY: float = 2.0

    # Sent on every request. Identifying the crawler honestly is what lets an
    # operator rate-limit or block it deliberately rather than by guesswork.
    SCOUT_USER_AGENT: str = "AuctiqScout/1.0 (+auction research bot)"

    # Skip paths a source's robots.txt disallows. This is a decision about
    # someone else's server, so it is a setting rather than an assumption.
    SCOUT_RESPECT_ROBOTS: bool = True

    # --- Search fallback ---
    # Reached when a scrape times out or meets an anti-bot challenge, which the
    # scraper reports rather than tries to defeat. Unset means the fallback
    # declares itself unavailable, exactly as a missing LLM key degrades the RAG
    # chain instead of failing it.
    TAVILY_API_KEY: str = ""
    SCOUT_SEARCH_MAX_RESULTS: int = 5

    # Domains the Researcher searches FIRST and ranks ABOVE everything else.
    # Comma-separated; blank disables the priority pass.
    #
    # espncricinfo is the authoritative source for exactly the figures the
    # spreadsheet cannot hold -- current-season runs, recent matches, squad
    # movements. Measured 2026-09-25 on "Shubman Gill form": unrestricted
    # search returned a Threads post and a Yardbarker aggregation; restricted
    # to this domain it returned the canonical player page, "led Gujarat
    # Titans to a fourth-place finish and scored 650 runs".
    #
    # **This is a search restriction, not a crawl.** `config/sources.yaml`
    # records espncricinfo answering an identified crawler with HTTP 403, and
    # that answer is respected -- nothing here fetches the site directly. The
    # search API has licensed access we do not, which is precisely the reason
    # that file gives for search being the primary path for prose.
    SCOUT_PRIORITY_DOMAINS: str = "espncricinfo.com"

    # The allowlist for EVERY search angle, priority or not. Comma-separated;
    # blank searches the open web.
    #
    # Restricting the domain is what "only cricket news" actually requires --
    # putting the word "cricket" in the query is a hint a search engine may
    # ignore, and on 2026-09-25 the injury angle ignored it and returned a
    # Golden State Warriors injury report. A domain allowlist is not a hint.
    #
    # It also removes the class of result that was poisoning the digest before
    # any model saw it: auction-software advertising, reddit threads and a
    # coaching institute's contact page, all of which ranked for cricket
    # phrasing on the open web and none of which can rank here.
    SCOUT_CRICKET_DOMAINS: str = (
        "espncricinfo.com,cricbuzz.com,icc-cricket.com,wisden.com,"
        "crictracker.com,sportskeeda.com,cricket.com,cricketworld.com,"
        "thecricketer.com,cricketaddictor.com"
    )

    @property
    def priority_domains(self) -> list[str]:
        """The priority list, parsed. Empty when the setting is blank."""
        return [d.strip() for d in (self.SCOUT_PRIORITY_DOMAINS or "").split(",") if d.strip()]

    @property
    def cricket_domains(self) -> list[str]:
        """
        Every domain the Researcher may read, parsed.

        The priority domains are folded in, so naming one there cannot
        accidentally exclude it from the general angles.
        """
        listed = [d.strip() for d in (self.SCOUT_CRICKET_DOMAINS or "").split(",") if d.strip()]
        if not listed:
            return []
        for domain in self.priority_domains:
            if domain not in listed:
                listed.append(domain)
        return listed

    # --- Research store ---
    # Scraped facts live in their own Chroma collection, NOT in `ipl_players`.
    # POST /api/v1/ingest defaults to reset=True, which drops that collection
    # and rebuilds it from the spreadsheet -- so anything the Researcher wrote
    # there would vanish on the next ingest, silently and without error.
    SCOUT_COLLECTION_NAME: str = "scout_research"

    # --- Graph ---
    # Named .db rather than .sqlite so the existing .gitignore rule for
    # data/database/*.db already covers it. Checkpoints are state, not source.
    SCOUT_CHECKPOINT_PATH: str = str(
        Path(__file__).resolve().parent.parent / "data" / "database" / "scout_checkpoints.db"
    )

    # How many times the Advisor may hand a query back to the Researcher for
    # fresh data before answering with what it already has. One, because every
    # cycle is a scrape plus an embed plus an upsert.
    SCOUT_MAX_REFRESH_CYCLES: int = 1

    # Wall clock for that refresh, in seconds. The auction room opens a lot for
    # 7 seconds and closes it 7 seconds after the last bid (OPEN_SECONDS and
    # CLOSE_SECONDS in auction/room.py), so a refresh thorough enough to finish
    # is a refresh that lands after the hammer falls. Past this budget the
    # Advisor answers from what it has and says the data may be stale -- which
    # is the same bargain the RAG chain already makes when a stage degrades.
    SCOUT_CYCLE_TIMEOUT: float = 8.0

    # Wall clock for the Researcher's FAST pass -- the one that runs on every
    # advise turn. Not the same budget as the heavy ingest above: measured
    # 2026-09-25, a Tavily search returns in 2.7s and a full Cricsheet pass
    # takes 17.6s, and only the first of those belongs inside a question asked
    # while a lot is open. The node also never takes more than half of whatever
    # is left of the turn, so this is a ceiling rather than an allocation.
    SCOUT_LIVE_CONTEXT_TIMEOUT: float = 8.0

    # Wall clock for a DELIBERATE research turn -- "refresh the data", or the
    # CLI. Minutes, not seconds, and deliberately far above the advise budget:
    # nobody is waiting on a bid window here, and the work genuinely takes
    # this long. Measured 2026-09-25: the Cricsheet ingest is 17.6s, and one
    # hermes3:8b call on local CPU is 22-37s, so a research turn that also
    # reasons with Hermes needs room the auction path cannot give it.
    #
    # This is what makes SCOUT_RESEARCHER_USES_HERMES mean something. Under the
    # advise budget the sub-agent is always skipped for want of time, so
    # without a generous path the switch would be permanently decorative.
    SCOUT_RESEARCH_BUDGET: float = 300.0

    # Wall clock for the Hermes sub-agent itself, on ANY turn including a live
    # one. When SCOUT_RESEARCHER_USES_HERMES is on, this is added to the advise
    # turn's budget rather than carved out of it -- otherwise the sub-agent is
    # forever skipped for want of the time nobody gave it, which is exactly
    # what happened while SCOUT_LIVE_CONTEXT_TIMEOUT was the only ceiling.
    #
    # A ceiling, not a target, and set from measurement rather than hope.
    # Profiled 2026-09-25 on a local hermes3:8b, one search round and 250
    # tokens out: 63.9 seconds warm, of which 2.5 was the Tavily call and the
    # rest was generation on CPU. A cold pass -- Ollama loading the 8B into
    # RAM -- overran 90 and produced nothing at all, which is the one outcome
    # worse than a slow answer: the budget is spent either way, and a timeout
    # spends it for no context.
    #
    # So the ceiling is generous on purpose. It is not the expected duration;
    # it is the point past which something is wrong.
    #
    # **This does not stall the auction.** The sub-agent is awaited through
    # ChatOpenAI's async client and Tavily's async client, so the event loop
    # running the seven-second bid timers stays free throughout. The blocking
    # hazard documented elsewhere in SCOUT is the SYNCHRONOUS `complete()`
    # path, which this does not use.
    SCOUT_HERMES_AGENT_TIMEOUT: float = 180.0

    model_config = {'env_file': '.env', 'env_file_encoding': 'utf-8', 'extra': 'ignore'}

    @property
    def effective_sql_key(self) -> str:
        """Returns dedicated SQL key or falls back to master key."""
        return self.TEXT_TO_SQL_API_KEY or self.GROQ_API_KEY

    @property
    def effective_rag_key(self) -> str:
        """Returns dedicated RAG key or falls back to master key."""
        return self.RAG_SYNTHESIS_API_KEY or self.GROQ_API_KEY

    @property
    def effective_router_key(self) -> str:
        """Returns dedicated Router key or falls back to master key."""
        return self.QUERY_ROUTER_API_KEY or self.GROQ_API_KEY

    # ------------------------------------------------------------------
    # Which database backs the players table
    # ------------------------------------------------------------------

    @property
    def use_postgres(self) -> bool:
        """
        True when the players table should be read from Supabase.

        The one place this decision is made. Every call site asks this -- or,
        better, asks the factory in db/__init__.py that asks this -- rather than
        testing DATABASE_URL itself, so there is exactly one rule to change and
        no possibility of two modules disagreeing about which database they are
        talking to mid-request.
        """
        return bool(self.DATABASE_URL.strip())

    @property
    def safe_database_target(self) -> str:
        """
        The current database, as a string that is safe to write to a log.

        This exists because api/main.py logs the database at startup, and a
        DATABASE_URL embeds the database password. Logging it raw would print
        live Supabase credentials into Render's log stream, where they are
        retained, searchable, and visible to anyone with dashboard access.

        Returns the SQLite path unchanged when Postgres is off -- a local file
        path is not a secret -- and host/dbname with everything before the @
        removed when it is on.
        """
        if not self.use_postgres:
            return f"sqlite:{self.SQLITE_DB_PATH}"

        url = self.DATABASE_URL.strip()
        # Keep only what is after the credentials. Deliberately string work
        # rather than urlparse: a malformed URL must still redact, and urlparse
        # on a bad string can raise or hand back the whole thing as the path.
        tail = url.rsplit("@", 1)[-1] if "@" in url else url.split("//", 1)[-1]
        return f"postgres:{tail}"

    @property
    def database_url_problem(self) -> str:
        """
        A human-readable reason DATABASE_URL will not work, or "" when it looks
        usable. Never raises, and never blocks startup.

        Deliberately a report rather than a validator. A pydantic validator that
        raised here would take the whole service down over a misconfiguration
        the operator could otherwise fix through a running dashboard -- and this
        codebase's standing rule is that a bad setting costs a capability, not
        the process. config/env_check.py is where this becomes a visible
        Finding at startup.

        The checks mirror db/check_supabase.py by design, not by accident: that
        script imports nothing from this project -- so it can be run before any
        of the backend is ported -- which means the logic cannot be shared
        without defeating its purpose. If one changes, change both.
        """
        url = self.DATABASE_URL.strip()
        if not url:
            return ""  # Not set is not a problem; it means SQLite.

        if not url.startswith("postgresql://"):
            return (
                "does not begin postgresql:// -- Supabase gives this string "
                "under Connect, and the psql form (postgres://) is not what "
                "psycopg expects"
            )
        if "[YOUR-PASSWORD]" in url or "<password>" in url.lower():
            return "still contains the password placeholder from Supabase's UI"
        if ".supabase.co:5432" in url and "pooler" not in url:
            return (
                "is the DIRECT connection string, which is IPv6-only and will "
                "HANG rather than fail on an IPv4 network -- copy the 'Session "
                "pooler' string instead (its host contains pooler.supabase.com)"
            )
        if ":6543" in url:
            # The nastiest of the three, because it half works.
            #
            # Port 6543 is Supabase's TRANSACTION pooler. It hands out a
            # different backend connection per transaction, so nothing that
            # lives in a session survives -- including server-side PREPARED
            # STATEMENTS, which psycopg3 starts using automatically once it has
            # seen the same query five times (prepare_threshold=5).
            #
            # So the first handful of queries succeed and then the same query
            # starts failing, which reads as an intermittent database fault
            # rather than a configuration mistake. Session mode (5432) keeps one
            # backend per connection and supports them.
            return (
                "is the TRANSACTION pooler (port 6543), which does not support "
                "the prepared statements psycopg starts using after a query "
                "repeats -- queries would succeed a few times and then fail. "
                "Use the SESSION pooler instead (same host, port 5432)"
            )
        return ""

@lru_cache()
def get_settings() -> Settings:
    return Settings()
