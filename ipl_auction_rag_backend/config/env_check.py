"""
env_check.py
Startup validation for the Scout Agent's environment.

Two jobs, and the second is the important one:

1. Report exactly which settings are present, missing, or malformed.
2. Decide which of those problems are *blocking*.

Almost none of them are. The agent is designed to degrade rather than fail: no
Groq key means no LLM synthesis, not a dead service. So this module classifies
findings by severity and lets the application start regardless, printing a
report the operator can act on. It raises nothing and exits nothing when
imported - only `main()` sets an exit code, so the same logic can back both a
CLI preflight check and the FastAPI lifespan.

Run it standalone:

    cd ipl_auction_rag_backend
    python -m config.env_check
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable

from config.settings import Settings, get_settings


class Severity(str, Enum):
    """How much a finding matters."""

    OK = "OK"
    #: The agent runs, but a capability is switched off.
    DEGRADED = "DEGRADED"
    #: Something is set but wrong — more likely to confuse than an empty value.
    INVALID = "INVALID"
    #: The agent cannot serve its core purpose.
    BLOCKING = "BLOCKING"


@dataclass
class Finding:
    """One variable's verdict."""

    name: str
    severity: Severity
    message: str
    #: What the operator should do. Empty when nothing needs doing.
    remedy: str = ""

    @property
    def is_problem(self) -> bool:
        return self.severity is not Severity.OK


@dataclass
class EnvReport:
    """The full verdict, plus the capability flags derived from it."""

    findings: list[Finding] = field(default_factory=list)
    #: True when an LLM can actually be called.
    llm_ready: bool = False
    #: True when the player table is readable.
    sqlite_ready: bool = False
    #: True when the vector store is present.
    chroma_ready: bool = False
    #: Rows in the player table, when it could be read.
    player_count: int | None = None
    #: Embeddings in the vector store, when it could be read.
    vector_count: int | None = None

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.severity is Severity.BLOCKING]

    @property
    def problems(self) -> list[Finding]:
        return [f for f in self.findings if f.is_problem]

    @property
    def can_start(self) -> bool:
        return not self.blocking

    def render(self) -> str:
        """A fixed-width report, sized to the longest variable name."""
        if not self.findings:
            return "No checks ran."

        width = max(len(f.name) for f in self.findings)
        lines: list[str] = []
        for finding in self.findings:
            lines.append(
                f"  {finding.severity.value:<9} {finding.name:<{width}}  {finding.message}"
            )
            if finding.remedy:
                lines.append(f"  {'':<9} {'':<{width}}  -> {finding.remedy}")
        return "\n".join(lines)

    def summary(self) -> str:
        """One line naming the capabilities that are actually available."""
        modes = [
            f"LLM synthesis: {'on' if self.llm_ready else 'OFF (deterministic analyst)'}",
            f"SQL: {'on' if self.sqlite_ready else 'OFF'}",
            f"Vector retrieval: {'on' if self.chroma_ready else 'OFF (keyword fallback)'}",
        ]
        return " | ".join(modes)


# ---------------------------------------------------------------------------
# Key formats
# ---------------------------------------------------------------------------

#: Groq issues keys prefixed `gsk_`. Checking the prefix catches the common
#: mistake of pasting an OpenAI or Anthropic key into GROQ_API_KEY, which would
#: otherwise surface much later as an opaque 401 mid-query.
GROQ_KEY_PREFIX = "gsk_"
GROQ_KEY_MIN_LENGTH = 20

#: Google AI Studio keys are 39 characters beginning `AIza`. Same reasoning:
#: catching the wrong-provider paste here beats an opaque 403 mid-query.
GEMINI_KEY_PREFIX = "AIza"
GEMINI_KEY_MIN_LENGTH = 30

#: Anthropic keys begin `sk-ant-`. Worth checking most of all, because this is
#: the only paid provider: a malformed key here fails the request *and* leaves
#: the operator assuming they are being billed for answers they never got.
ANTHROPIC_KEY_PREFIX = "sk-ant-"
ANTHROPIC_KEY_MIN_LENGTH = 20

#: Values that mean "unset" despite being non-empty. A placeholder left in the
#: .env is worse than a blank: the code would try it and fail at request time.
PLACEHOLDERS = {
    "",
    "none",
    "null",
    "todo",
    "changeme",
    "your_key_here",
    "your-key-here",
    "xxx",
    "xxxx",
    "<your_groq_api_key>",
    "<your_gemini_api_key>",
    "sk-...",
    "gsk_...",
    "aiza...",
    "sk-ant-...",
    "<your_anthropic_api_key>",
    "sk-ant-your-key-here",
}


def classify_gemini_key(value: str, label: str) -> Finding:
    """Judge a Google AI Studio key."""
    raw = (value or "").strip()

    if raw.lower() in PLACEHOLDERS:
        return Finding(label, Severity.OK, "not set")

    if not raw.startswith(GEMINI_KEY_PREFIX):
        return Finding(
            label,
            Severity.INVALID,
            f"set, but does not start with '{GEMINI_KEY_PREFIX}' - this does not "
            "look like a Google AI Studio key",
            "Get one from https://aistudio.google.com/apikey - they begin 'AIza'.",
        )

    if len(raw) < GEMINI_KEY_MIN_LENGTH:
        return Finding(
            label,
            Severity.INVALID,
            f"set, but only {len(raw)} characters - too short to be a Gemini key",
            "Check the value was pasted in full.",
        )

    return Finding(label, Severity.OK, f"set ({raw[:8]}..., {len(raw)} chars)")


def classify_anthropic_key(value: str, label: str) -> Finding:
    """Judge an Anthropic key."""
    raw = (value or "").strip()

    if raw.lower() in PLACEHOLDERS:
        return Finding(label, Severity.OK, "not set")

    if not raw.startswith(ANTHROPIC_KEY_PREFIX):
        return Finding(
            label,
            Severity.INVALID,
            f"set, but does not start with '{ANTHROPIC_KEY_PREFIX}' - this does "
            "not look like an Anthropic key",
            "Get one from https://console.anthropic.com/ - they begin 'sk-ant-'. "
            "Note a Claude Pro subscription does not include API access; the "
            "Console bills separately.",
        )

    if len(raw) < ANTHROPIC_KEY_MIN_LENGTH:
        return Finding(
            label,
            Severity.INVALID,
            f"set, but only {len(raw)} characters - too short to be an "
            "Anthropic key",
            "Check the value was pasted in full.",
        )

    return Finding(label, Severity.OK, f"set ({raw[:10]}..., {len(raw)} chars)")


def classify_key(
    value: str, label: str, *, optional: bool, when_absent: str = "not set"
) -> Finding:
    """
    Judge one API key.

    A missing optional key is normal and reported as OK; a missing required key
    is DEGRADED rather than BLOCKING, because the agent has a no-LLM path. A key
    that is present but obviously wrong is INVALID - the loudest non-fatal
    verdict, since a bad key produces confusing runtime errors that look like
    bugs in the agent.
    """
    raw = (value or "").strip()

    if raw.lower() in PLACEHOLDERS:
        if optional:
            return Finding(label, Severity.OK, when_absent)
        return Finding(
            label,
            Severity.DEGRADED,
            "not set - LLM synthesis, routing and text-to-SQL are disabled",
            "Add a key from https://console.groq.com/keys to "
            "ipl_auction_rag_backend/.env, then restart.",
        )

    if not raw.startswith(GROQ_KEY_PREFIX):
        return Finding(
            label,
            Severity.INVALID,
            f"set, but does not start with '{GROQ_KEY_PREFIX}' - this does not "
            "look like a Groq key",
            "Groq keys begin with 'gsk_'. A key for another provider will be "
            "rejected at request time.",
        )

    if len(raw) < GROQ_KEY_MIN_LENGTH:
        return Finding(
            label,
            Severity.INVALID,
            f"set, but only {len(raw)} characters - too short to be a Groq key",
            "Check the value was pasted in full.",
        )

    # The key is well-formed. Whether Groq accepts it is only knowable by
    # calling out, which startup deliberately does not do.
    return Finding(label, Severity.OK, f"set ({raw[:8]}..., {len(raw)} chars)")


def _check_path(
    label: str,
    raw: str,
    *,
    kind: str,
    severity_if_absent: Severity,
    remedy: str,
    extra: Callable[[Path], Finding | None] | None = None,
) -> Finding:
    """Check that a configured path exists and is the right kind of thing."""
    path = Path(raw)
    exists = path.is_dir() if kind == "directory" else path.is_file()

    if not exists:
        return Finding(label, severity_if_absent, f"{kind} not found at {path}", remedy)

    if extra is not None:
        found = extra(path)
        if found is not None:
            return found

    return Finding(label, Severity.OK, str(path))


#: Counts recovered during the last check, so callers do not have to reopen the
#: databases (or, worse, construct a ChromaManager and load an embedding model)
#: merely to report how many rows exist.
_COUNTS: dict[str, int | None] = {"players": None, "vectors": None}


def _count_players(db_path: Path) -> Finding | None:
    """Confirm the player table is readable and populated."""
    import sqlite3

    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            count = conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    except Exception as exc:  # noqa: BLE001 - any failure here means "unusable"
        return Finding(
            "SQLITE_DB_PATH",
            Severity.BLOCKING,
            f"present but unreadable: {exc}",
            "Re-run ingestion: POST /api/v1/ingest, or "
            "`python -m ingestion.data_loader`.",
        )

    if count == 0:
        return Finding(
            "SQLITE_DB_PATH",
            Severity.BLOCKING,
            "player table is empty",
            "Re-run ingestion: POST /api/v1/ingest.",
        )

    _COUNTS["players"] = count
    return Finding("SQLITE_DB_PATH", Severity.OK, f"{count} players")


def _count_vectors(chroma_dir: Path) -> Finding | None:
    """Count embeddings without loading Chroma, which would load a model."""
    import sqlite3

    store = chroma_dir / "chroma.sqlite3"
    if not store.is_file():
        return Finding(
            "CHROMA_DB_PATH",
            Severity.DEGRADED,
            "no vector store - semantic retrieval falls back to keyword search",
            "Re-run ingestion: POST /api/v1/ingest.",
        )

    try:
        with sqlite3.connect(f"file:{store}?mode=ro", uri=True) as conn:
            count = conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
    except Exception:  # noqa: BLE001
        return Finding(
            "CHROMA_DB_PATH",
            Severity.DEGRADED,
            "vector store unreadable - falling back to keyword search",
            "Re-run ingestion: POST /api/v1/ingest.",
        )

    if count == 0:
        return Finding(
            "CHROMA_DB_PATH",
            Severity.DEGRADED,
            "vector store is empty - falling back to keyword search",
            "Re-run ingestion: POST /api/v1/ingest.",
        )

    _COUNTS["vectors"] = count
    return Finding("CHROMA_DB_PATH", Severity.OK, f"{count} embeddings")


def check_environment(settings: Settings | None = None) -> EnvReport:
    """
    Inspect the environment and return a report. Never raises.

    Callers decide what to do with the verdict; this only describes it.
    """
    settings = settings or get_settings()
    _COUNTS["players"] = None
    _COUNTS["vectors"] = None
    report = EnvReport()

    # --- .env file itself -------------------------------------------------
    env_path = Path(settings.PROJECT_ROOT) / ".env"
    if env_path.is_file():
        report.findings.append(Finding(".env", Severity.OK, str(env_path)))
    else:
        report.findings.append(
            Finding(
                ".env",
                Severity.DEGRADED,
                f"no .env at {env_path} - using defaults and process environment",
                "Copy .env.example to .env to configure the agent.",
            )
        )

    # --- API keys ---------------------------------------------------------
    report.findings.append(
        classify_anthropic_key(settings.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY")
    )

    gemini = classify_gemini_key(settings.GEMINI_API_KEY, "GEMINI_API_KEY")
    report.findings.append(gemini)

    # Both provider keys are reported as optional, because either one alone is
    # enough. The single actionable line is LLM_PROVIDER below — flagging each
    # key as missing would present one choice as two problems.
    report.findings.append(
        classify_key(settings.GROQ_API_KEY, "GROQ_API_KEY", optional=True)
    )

    for name, value in (
        ("TEXT_TO_SQL_API_KEY", settings.TEXT_TO_SQL_API_KEY),
        ("RAG_SYNTHESIS_API_KEY", settings.RAG_SYNTHESIS_API_KEY),
        ("QUERY_ROUTER_API_KEY", settings.QUERY_ROUTER_API_KEY),
    ):
        report.findings.append(
            classify_key(
                value, name, optional=True, when_absent="not set (inherits GROQ_API_KEY)"
            )
        )

    # Ask the provider module itself which one would serve a request, so the
    # report can never disagree with what the pipeline actually does.
    from rag.llm_provider import active_provider, describe

    provider = active_provider()
    report.llm_ready = provider != "none"
    report.findings.append(
        Finding(
            "LLM_PROVIDER",
            Severity.OK if report.llm_ready else Severity.DEGRADED,
            describe(),
            ""
            if report.llm_ready
            else "Set GEMINI_API_KEY (https://aistudio.google.com/apikey), "
            "GROQ_API_KEY, or ANTHROPIC_API_KEY in .env to enable written "
            "analysis. Any one is enough; with several, they form a fallback "
            "ladder rather than a choice.",
        )
    )

    # --- Model names ------------------------------------------------------
    for name, value in (
        ("GEMINI_MODEL", settings.GEMINI_MODEL),
        ("GEMINI_ROUTER_MODEL", settings.GEMINI_ROUTER_MODEL),
        ("ANTHROPIC_MODEL", settings.ANTHROPIC_MODEL),
        ("RAG_LLM_MODEL", settings.RAG_LLM_MODEL),
        ("SQL_LLM_MODEL", settings.SQL_LLM_MODEL),
        ("ROUTER_LLM_MODEL", settings.ROUTER_LLM_MODEL),
        ("EMBEDDING_MODEL_NAME", settings.EMBEDDING_MODEL_NAME),
        ("RERANKER_MODEL_NAME", settings.RERANKER_MODEL_NAME),
    ):
        if not (value or "").strip():
            report.findings.append(
                Finding(name, Severity.INVALID, "empty", "Set a model identifier.")
            )
        else:
            report.findings.append(Finding(name, Severity.OK, value))

    # --- Data stores ------------------------------------------------------
    sqlite_finding = _check_path(
        "SQLITE_DB_PATH",
        settings.SQLITE_DB_PATH,
        kind="file",
        severity_if_absent=Severity.BLOCKING,
        remedy="Run ingestion: POST /api/v1/ingest, or "
        "`python -m ingestion.data_loader`.",
        extra=_count_players,
    )
    report.findings.append(sqlite_finding)
    report.sqlite_ready = sqlite_finding.severity is Severity.OK

    chroma_finding = _check_path(
        "CHROMA_DB_PATH",
        settings.CHROMA_DB_PATH,
        kind="directory",
        severity_if_absent=Severity.DEGRADED,
        remedy="Run ingestion to build the vector store.",
        extra=_count_vectors,
    )
    report.findings.append(chroma_finding)
    report.chroma_ready = chroma_finding.severity is Severity.OK
    report.player_count = _COUNTS["players"]
    report.vector_count = _COUNTS["vectors"]

    # --- Numeric config ---------------------------------------------------
    if settings.RERANK_TOP_K > settings.VECTOR_SEARCH_TOP_K:
        report.findings.append(
            Finding(
                "RERANK_TOP_K",
                Severity.INVALID,
                f"{settings.RERANK_TOP_K} exceeds VECTOR_SEARCH_TOP_K "
                f"({settings.VECTOR_SEARCH_TOP_K}) - the reranker cannot return "
                "more candidates than it was given",
                "Set RERANK_TOP_K <= VECTOR_SEARCH_TOP_K.",
            )
        )
    else:
        report.findings.append(
            Finding(
                "RERANK_TOP_K",
                Severity.OK,
                f"{settings.RERANK_TOP_K} of {settings.VECTOR_SEARCH_TOP_K} candidates",
            )
        )

    if not (1 <= settings.API_PORT <= 65535):
        report.findings.append(
            Finding(
                "API_PORT",
                Severity.INVALID,
                f"{settings.API_PORT} is not a valid port",
                "Use 1-65535.",
            )
        )

    # --- CORS -------------------------------------------------------------
    origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
    if not origins:
        report.findings.append(
            Finding(
                "CORS_ORIGINS",
                Severity.DEGRADED,
                "empty - only same-origin requests will work",
                "List the frontend origins, comma-separated.",
            )
        )
    else:
        report.findings.append(
            Finding("CORS_ORIGINS", Severity.OK, f"{len(origins)} origin(s)")
        )

    return report


def log_report(report: EnvReport, logger) -> None:
    """Write the report through a logger, at a level matching its worst finding."""
    logger.info("Environment check")
    for line in report.render().splitlines():
        logger.info(line)
    logger.info("Capabilities: %s", report.summary())

    if report.blocking:
        for finding in report.blocking:
            logger.error("BLOCKING: %s - %s", finding.name, finding.message)
            if finding.remedy:
                logger.error("          %s", finding.remedy)
    elif report.problems:
        logger.warning(
            "%d setting(s) need attention; the agent is running in a reduced mode.",
            len(report.problems),
        )


def main() -> int:
    """Standalone preflight. Exit code 1 only when something is genuinely blocking."""
    # The report uses em dashes and arrows; a Windows console defaults to cp1252
    # and would render them as mojibake.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    # Read the .env from the package root regardless of where this is invoked.
    os.chdir(Path(__file__).resolve().parent.parent)
    report = check_environment()

    print("Scout Agent - environment check")
    print(report.render())
    print()
    print(report.summary())
    print()

    if report.blocking:
        print(f"{len(report.blocking)} blocking problem(s). The agent cannot serve players.")
        return 1

    if report.problems:
        print(
            f"{len(report.problems)} setting(s) need attention. "
            "The agent will start in a reduced mode."
        )
    else:
        print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
