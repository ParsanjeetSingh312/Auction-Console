from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # --- Paths ---
    PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
    EXCEL_FILE_PATH: str = str(Path(__file__).resolve().parent.parent.parent / "IPL AUCTION DATA.xlsx")
    SQLITE_DB_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "database" / "ipl_auction.db")
    CHROMA_DB_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "database" / "chroma_db")
    
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

    # Whether the Data Researcher also routes its extraction reasoning to
    # Hermes. Off by default: this hop would sit inside a loop that runs once
    # per scraped source, so the cost is paid per page rather than per query.
    SCOUT_RESEARCHER_USES_HERMES: bool = False

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

@lru_cache()
def get_settings() -> Settings:
    return Settings()
