"""
memory.py
SCOUT's conversation memory: what was asked on a thread, what was answered,
and who it was about.

**Why this is not the LangGraph checkpoint.** The checkpointer saves graph
state, and the supervisor deliberately clears every per-turn field at the start
of each question (see `supervisor_node`) so one answer's notes and filters never
leak into the next. That is right for state and wrong for a conversation: the
one thing a follow-up needs -- the turns before it -- is exactly what gets
cleared. So the conversation lives here, in its own small SQLite file, written
once per finished turn and read once at the start of the next.

**Three things are remembered per thread.**

  turns    the question and the answer as the user saw them, plus the pool
           players the answer was about. Sent back to the model as real
           user/assistant messages, so "and his economy?" arrives with the
           exchange it follows.
  focus    the players the conversation is currently about. This is what lets
           a follow-up with no name in it ("what about his strike rate against
           spin?") be answered about the right player without asking a model
           to guess who "his" is.
  summary  what compaction left of older turns. Compaction keeps the last
           SCOUT_MEMORY_KEEP_TURNS turns word for word and folds the rest into
           a short summary -- written by a model when one answers, built by rule
           when none does -- so a long session costs a bounded number of
           prompt tokens instead of growing without limit.

Compaction runs on its own when a thread passes SCOUT_MEMORY_TOKEN_LIMIT, and on
demand from the drawer's Compact button (POST /scout/thread/{id}/compact).
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from config.settings import get_settings

logger = logging.getLogger(__name__)

#: Characters of an answer kept per remembered turn. The full answer is what
#: the user read; the model only needs enough of it to know what was said.
ANSWER_CHARS = 900

#: Characters of a compacted summary. A summary that grows with the session is
#: not a summary.
SUMMARY_CHARS = 1800

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS scout_threads (
        thread_id        TEXT PRIMARY KEY,
        summary          TEXT NOT NULL DEFAULT '',
        focus_json       TEXT NOT NULL DEFAULT '[]',
        compacted_turns  INTEGER NOT NULL DEFAULT 0,
        compactions      INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS scout_turns (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id     TEXT NOT NULL,
        question      TEXT NOT NULL,
        answer        TEXT NOT NULL,
        players_json  TEXT NOT NULL DEFAULT '[]',
        intent        TEXT,
        compacted     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_scout_turns_thread ON scout_turns(thread_id, id)",
)


def estimate_tokens(text: str) -> int:
    """About four characters a token -- close enough to budget a prompt by."""
    return max(0, (len(text or "") + 3) // 4)


@dataclass
class Turn:
    question: str
    answer: str
    players: list[dict[str, Any]] = field(default_factory=list)
    intent: str | None = None


@dataclass
class Memory:
    """One thread, as the next question needs it."""

    thread_id: str
    summary: str = ""
    turns: list[Turn] = field(default_factory=list)
    #: Pool players the conversation is about, most recent first:
    #: [{"id": 18, "name": "Virat Kohli"}, ...].
    focus: list[dict[str, Any]] = field(default_factory=list)
    compacted_turns: int = 0
    compactions: int = 0

    def is_empty(self) -> bool:
        return not self.turns and not self.summary

    def messages(self) -> list[dict[str, str]]:
        """The remembered turns as OpenAI-shape chat messages, oldest first."""
        out: list[dict[str, str]] = []
        for turn in self.turns:
            out.append({"role": "user", "content": turn.question})
            out.append({"role": "assistant", "content": turn.answer[:ANSWER_CHARS]})
        return out

    def context_block(self) -> str:
        """A plain-text recap for prompts that take one block, not messages."""
        lines: list[str] = []
        if self.summary:
            lines += ["EARLIER IN THIS CONVERSATION (compacted):", self.summary, ""]
        if self.turns:
            lines.append("RECENT TURNS:")
            for turn in self.turns:
                lines.append(f"User: {turn.question}")
                lines.append(f"SCOUT: {' '.join(turn.answer.split())[:ANSWER_CHARS]}")
        if self.focus:
            lines += ["", "PLAYERS IN FOCUS: " + ", ".join(p["name"] for p in self.focus)]
        return "\n".join(lines).strip()

    def tokens(self) -> int:
        return estimate_tokens(self.context_block())

    def usage(self) -> dict[str, Any]:
        """What the drawer's context meter shows."""
        limit = get_settings().SCOUT_MEMORY_TOKEN_LIMIT
        used = self.tokens()
        return {
            "thread_id": self.thread_id,
            "turns": len(self.turns) + self.compacted_turns,
            "live_turns": len(self.turns),
            "compacted_turns": self.compacted_turns,
            "compactions": self.compactions,
            "tokens": used,
            "limit": limit,
            "percent": min(100, round(used / limit * 100)) if limit else 0,
            "has_summary": bool(self.summary),
            "focus": [p["name"] for p in self.focus],
        }


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    path = Path(get_settings().SCOUT_MEMORY_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    for statement in _SCHEMA:
        conn.execute(statement)
    return conn


def _valid_thread(thread_id: str | None) -> str | None:
    """Thread ids come from the browser: short, plain, or not at all."""
    if not thread_id:
        return None
    thread_id = str(thread_id).strip()
    return thread_id if re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", thread_id) else None


def load(thread_id: str | None) -> Memory:
    """The thread's memory. An unknown or missing id is an empty memory."""
    tid = _valid_thread(thread_id)
    if tid is None:
        return Memory(thread_id=thread_id or "")
    with _connect() as conn:
        head = conn.execute("SELECT * FROM scout_threads WHERE thread_id = ?", (tid,)).fetchone()
        rows = conn.execute(
            "SELECT question, answer, players_json, intent FROM scout_turns "
            "WHERE thread_id = ? AND compacted = 0 ORDER BY id",
            (tid,),
        ).fetchall()
    memory = Memory(thread_id=tid)
    if head is not None:
        memory.summary = head["summary"] or ""
        memory.compacted_turns = int(head["compacted_turns"] or 0)
        memory.compactions = int(head["compactions"] or 0)
        try:
            memory.focus = list(json.loads(head["focus_json"] or "[]"))
        except json.JSONDecodeError:
            memory.focus = []
    for row in rows:
        try:
            players = list(json.loads(row["players_json"] or "[]"))
        except json.JSONDecodeError:
            players = []
        memory.turns.append(Turn(row["question"], row["answer"], players, row["intent"]))
    return memory


def remember(
    thread_id: str | None,
    question: str,
    answer: str,
    players: list[dict[str, Any]] | None = None,
    *,
    intent: str | None = None,
) -> Memory | None:
    """
    Record one finished turn, move the focus, and compact if the thread is full.

    The focus moves only when the answer was about named players; a shortlist
    of five strangers does not make "his" mean the fifth of them, so a turn
    with more than three players leaves the focus where it was.
    """
    tid = _valid_thread(thread_id)
    if tid is None or not (question or "").strip() or not (answer or "").strip():
        return None
    players = [
        {"id": int(p["id"]), "name": str(p["name"])}
        for p in (players or [])
        if p.get("id") and p.get("name")
    ]
    now = _now()
    with _connect() as conn:
        head = conn.execute("SELECT focus_json FROM scout_threads WHERE thread_id = ?", (tid,)).fetchone()
        focus = []
        if head is not None:
            try:
                focus = list(json.loads(head["focus_json"] or "[]"))
            except json.JSONDecodeError:
                focus = []
        if players and len(players) <= 3:
            focus = players
        conn.execute(
            "INSERT INTO scout_threads (thread_id, focus_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET "
            "focus_json = excluded.focus_json, updated_at = excluded.updated_at",
            (tid, json.dumps(focus), now, now),
        )
        conn.execute(
            "INSERT INTO scout_turns (thread_id, question, answer, players_json, intent, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (tid, question.strip(), answer.strip(), json.dumps(players), intent, now),
        )

    memory = load(tid)
    if memory.tokens() > get_settings().SCOUT_MEMORY_TOKEN_LIMIT:
        logger.info("thread %s passed the memory limit; compacting", tid)
        memory = compact(tid, use_model=True)
    return memory


def clear(thread_id: str | None) -> bool:
    """Forget a thread entirely. True if there was anything to forget."""
    tid = _valid_thread(thread_id)
    if tid is None:
        return False
    with _connect() as conn:
        gone = conn.execute("DELETE FROM scout_turns WHERE thread_id = ?", (tid,)).rowcount
        gone += conn.execute("DELETE FROM scout_threads WHERE thread_id = ?", (tid,)).rowcount
    return gone > 0


def prune(days: int | None = None) -> int:
    """Delete threads untouched for `days`. Called once at startup."""
    days = get_settings().SCOUT_MEMORY_RETENTION_DAYS if days is None else days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with _connect() as conn:
        stale = [r[0] for r in conn.execute(
            "SELECT thread_id FROM scout_threads WHERE updated_at < ?", (cutoff,)
        ).fetchall()]
        for tid in stale:
            conn.execute("DELETE FROM scout_turns WHERE thread_id = ?", (tid,))
            conn.execute("DELETE FROM scout_threads WHERE thread_id = ?", (tid,))
    return len(stale)


# ---------------------------------------------------------------------------
# Compaction
# ---------------------------------------------------------------------------

_SUMMARY_SYSTEM = (
    "You compress a conversation between a user and SCOUT, an IPL auction "
    "assistant, into notes SCOUT will read before answering the next question. "
    "Keep: which players and franchises were discussed, the figures SCOUT "
    "quoted, filters or budgets the user set, decisions or preferences the user "
    "stated, and any open question. Drop pleasantries and repetition. Write at "
    "most 10 short bullet lines starting with '- '. Never add a fact that is not "
    "in the conversation."
)


def _rule_summary(previous: str, turns: list[Turn]) -> str:
    """A summary built without a model: one line per turn, players named."""
    lines = [ln for ln in (previous or "").splitlines() if ln.strip()]
    for turn in turns:
        about = ", ".join(p["name"] for p in turn.players[:4])
        answer = " ".join(turn.answer.split())
        first = re.split(r"(?<=[.!?])\s", answer, maxsplit=1)[0][:180]
        lines.append(f"- Asked: {turn.question[:140]}" + (f" (about {about})" if about else ""))
        lines.append(f"  SCOUT: {first}")
    text = "\n".join(lines)
    # Oldest lines go first when the summary itself grows too long.
    while len(text) > SUMMARY_CHARS and "\n" in text:
        text = text.split("\n", 1)[1]
    return text


def _model_summary(previous: str, turns: list[Turn]) -> str | None:
    from rag import llm_provider

    if not llm_provider.available():
        return None
    transcript = []
    if previous:
        transcript.append("Earlier notes:\n" + previous)
    for turn in turns:
        transcript.append(f"User: {turn.question}\nSCOUT: {' '.join(turn.answer.split())[:ANSWER_CHARS]}")
    try:
        text = llm_provider.complete(
            _SUMMARY_SYSTEM,
            [{"role": "user", "content": "\n\n".join(transcript)}],
            # Generous: some providers spend part of the allowance thinking,
            # and a summary cut off mid-line loses the line that mattered.
            task="rag", temperature=0.1, max_tokens=1200, timeout=25.0,
        )
    except Exception as exc:  # noqa: BLE001 - the rule summary stands in
        logger.warning("memory compaction by model failed: %s", exc)
        return None
    text = (text or "").strip()
    if len(text) > SUMMARY_CHARS:
        text = text[:SUMMARY_CHARS].rsplit("\n", 1)[0]
    # Drop a last line the provider cut off mid-sentence.
    lines = text.splitlines()
    last = lines[-1].strip() if lines else ""
    if len(lines) > 1 and (last.count("(") > last.count(")") or last.endswith((",", "-", "–", ":"))):
        lines = lines[:-1]
    text = "\n".join(lines).strip()
    return text or None


def compact(thread_id: str | None, *, keep: int | None = None, use_model: bool = True) -> Memory:
    """
    Fold every turn but the last `keep` into the thread's summary.

    The folded turns are marked, not deleted, so the record of what was asked
    survives -- only what goes into the next prompt shrinks.
    """
    tid = _valid_thread(thread_id)
    memory = load(tid)
    if tid is None:
        return memory
    keep = get_settings().SCOUT_MEMORY_KEEP_TURNS if keep is None else max(0, keep)
    fold = memory.turns[: max(0, len(memory.turns) - keep)]
    if not fold:
        return memory

    summary = (_model_summary(memory.summary, fold) if use_model else None) or _rule_summary(
        memory.summary, fold
    )
    with _connect() as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM scout_turns WHERE thread_id = ? AND compacted = 0 ORDER BY id",
            (tid,),
        ).fetchall()][: len(fold)]
        conn.executemany("UPDATE scout_turns SET compacted = 1 WHERE id = ?", [(i,) for i in ids])
        conn.execute(
            "UPDATE scout_threads SET summary = ?, compacted_turns = compacted_turns + ?, "
            "compactions = compactions + 1, updated_at = ? WHERE thread_id = ?",
            (summary, len(fold), _now(), tid),
        )
    return load(tid)


# ---------------------------------------------------------------------------
# Follow-ups
# ---------------------------------------------------------------------------

#: Words that point back at someone already discussed. Matched only when the
#: question names nobody itself -- "compare him with Gill" names Gill and still
#: needs "him", which is why the caller merges rather than replaces.
_ANAPHORA = re.compile(
    r"\b(he|his|him|himself|they|their|them|both|either|this player|that player|"
    r"these players|those players|the same player|same guy|this guy|that guy|"
    r"the first one|the second one|the third one|the last one)\b",
    re.IGNORECASE,
)
_CONTINUATION = re.compile(
    r"^\s*(and|also|what about|how about|compare|vs\.?|versus|more on|tell me more|"
    r"why|is he|was he|does he|did he|can he|will he|has he)\b",
    re.IGNORECASE,
)
_ORDINAL = {"first": 0, "second": 1, "third": 2, "fourth": 3, "fifth": 4, "last": -1}


def points_back(question: str) -> bool:
    """True when the question uses a word that can only mean someone already named."""
    return bool(_ANAPHORA.search(question or ""))


def refers_back(question: str) -> bool:
    """True when the question leans on something said before it."""
    return bool(_ANAPHORA.search(question or "") or _CONTINUATION.search(question or ""))


def followup_players(question: str, memory: Memory) -> list[dict[str, Any]]:
    """
    The remembered players a follow-up is about, or [] when it is not one.

    "The second one" picks from the last answer's player list; any other
    reference means the conversation's current focus.
    """
    if memory.is_empty() or not refers_back(question):
        return []
    ordinal = re.search(r"\bthe (first|second|third|fourth|fifth|last) one\b", question, re.IGNORECASE)
    if ordinal and memory.turns:
        last_players = memory.turns[-1].players
        index = _ORDINAL[ordinal.group(1).lower()]
        if last_players and -len(last_players) <= index < len(last_players):
            return [last_players[index]]
    if memory.focus:
        return list(memory.focus)
    # No focus yet: fall back to the most recent turn that named anyone.
    for turn in reversed(memory.turns):
        if turn.players:
            return turn.players[:3]
    return []


def thread_usage(thread_id: str | None) -> dict[str, Any]:
    return load(thread_id).usage()
