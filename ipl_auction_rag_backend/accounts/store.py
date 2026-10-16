"""
store.py
Accounts and their login sessions, in SQLite.

Their own file, `accounts.db`, beside the player database (SQLITE_DB_PATH's
folder) unless ACCOUNTS_DB_PATH says otherwise. Beside it because on Railway
that folder is the persistent volume, so accounts survive a deploy; a file of
its own because the player database can be rebuilt by an ingest, and accounts
must never go with it.

Roles, and what each may do in Live Bidding (enforced in auction/room.py):

    auctioneer   create auction rooms, and run the ones it created
    delegate     take a franchise seat in a room and bid
    member       the free tier: the rest of the site, no seat in a room

A session is a random token in an httpOnly cookie; only its SHA-256 is stored,
so the table cannot be replayed if it leaks.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal

from config.settings import get_settings

Role = Literal["auctioneer", "delegate", "member"]
ROLES: tuple[Role, ...] = ("auctioneer", "delegate", "member")

SESSION_SECONDS = 30 * 24 * 3600

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS accounts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK (role IN ('auctioneer', 'delegate', 'member')),
        password_hash TEXT    NOT NULL,
        created_at    REAL    NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS account_sessions (
        token_hash TEXT    PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at REAL    NOT NULL,
        expires_at REAL    NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_id)",
)


def admin_emails() -> set[str]:
    """The administrators, by email (ADMIN_EMAILS in config/settings.py)."""
    return {e.strip().lower() for e in get_settings().ADMIN_EMAILS.split(",") if e.strip()}


@dataclass(frozen=True)
class Account:
    id: int
    email: str
    name: str
    role: Role
    created_at: float

    @property
    def admin(self) -> bool:
        """
        An administrator: full access, on top of whatever the role allows.
        Read from the environment every time, so it is granted and revoked
        there and never stored with the account.
        """
        return self.email in admin_emails()

    def public(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "admin": self.admin,
            "created_at": self.created_at,
        }


class EmailTaken(Exception):
    pass


def db_path() -> str:
    explicit = os.getenv("ACCOUNTS_DB_PATH")
    if explicit:
        return explicit
    return str(Path(get_settings().SQLITE_DB_PATH).parent / "accounts.db")


_ready_for: str | None = None


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    global _ready_for
    path = db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        if _ready_for != path:
            for statement in SCHEMA:
                conn.execute(statement)
            _ready_for = path
        yield conn
        conn.commit()
    finally:
        conn.close()


def _account(row: sqlite3.Row | None) -> Account | None:
    if row is None:
        return None
    return Account(row["id"], row["email"], row["name"], row["role"], row["created_at"])


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ------------------------------------------------------------- accounts --


def create_account(email: str, name: str, role: Role, password_hash: str) -> Account:
    with _connect() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO accounts (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (email, name, role, password_hash, time.time()),
            )
        except sqlite3.IntegrityError as exc:
            raise EmailTaken(email) from exc
        row = conn.execute("SELECT * FROM accounts WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _account(row)  # type: ignore[return-value]


def account_with_password(email: str) -> tuple[Account, str] | None:
    """The account for `email` and its stored password hash, for a login."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
    if row is None:
        return None
    return _account(row), row["password_hash"]  # type: ignore[return-value]


def update_email(account_id: int, email: str) -> Account:
    with _connect() as conn:
        try:
            conn.execute("UPDATE accounts SET email = ? WHERE id = ?", (email, account_id))
        except sqlite3.IntegrityError as exc:
            raise EmailTaken(email) from exc
        row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    return _account(row)  # type: ignore[return-value]


def update_password(account_id: int, password_hash: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE accounts SET password_hash = ? WHERE id = ?", (password_hash, account_id))


def password_hash_of(account_id: int) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT password_hash FROM accounts WHERE id = ?", (account_id,)).fetchone()
    return row["password_hash"] if row else None


# ------------------------------------------------------------- sessions --


def open_session(account_id: int) -> str:
    """A new session for the account. Returns the token for the cookie."""
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _connect() as conn:
        # Expired sessions are swept here, on the way in, rather than by a job.
        conn.execute("DELETE FROM account_sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_hash_token(token), account_id, now, now + SESSION_SECONDS),
        )
    return token


def account_for_session(token: str | None) -> Account | None:
    """The account a session token belongs to, or None if it is unknown or expired."""
    if not token or len(token) > 200:
        return None
    with _connect() as conn:
        row = conn.execute(
            "SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.account_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (_hash_token(token), time.time()),
        ).fetchone()
    return _account(row)


def close_other_sessions(account_id: int, keep_token: str | None) -> None:
    """Sign the account out everywhere but the session `keep_token` belongs to."""
    keep = _hash_token(keep_token) if keep_token else ""
    with _connect() as conn:
        conn.execute(
            "DELETE FROM account_sessions WHERE account_id = ? AND token_hash != ?",
            (account_id, keep),
        )


def close_session(token: str | None) -> None:
    if not token:
        return
    with _connect() as conn:
        conn.execute("DELETE FROM account_sessions WHERE token_hash = ?", (_hash_token(token),))
