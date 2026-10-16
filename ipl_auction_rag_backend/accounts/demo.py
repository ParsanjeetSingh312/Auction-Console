"""
demo.py
Demo accounts, for trying Live Bidding from several logins.

Made at startup when DEMO_ACCOUNTS_PASSWORD is set (config/settings.py), all
with that password, on the reserved demo.auctoniq.test domain so they can never
collide with a real address. Re-running is safe: an account that exists keeps
its id and has its password brought in line with the setting, so changing the
setting changes every demo password, and unsetting it leaves them as they were.

Two auctioneers, so one can be seen failing to take the other's chair; twelve
delegates, one for every seat in a room; one free-tier member.
"""
from __future__ import annotations

import logging
import sqlite3

from accounts import store
from accounts.passwords import hash_password

logger = logging.getLogger("accounts.demo")

DOMAIN = "demo.auctoniq.test"

DEMO_ACCOUNTS: list[tuple[str, str, store.Role]] = [
    (f"auctioneer1@{DOMAIN}", "Demo Auctioneer One", "auctioneer"),
    (f"auctioneer2@{DOMAIN}", "Demo Auctioneer Two", "auctioneer"),
    *[(f"delegate{i}@{DOMAIN}", f"Demo Delegate {i}", "delegate") for i in range(1, 13)],
    (f"member@{DOMAIN}", "Demo Member", "member"),
]


def ensure_admin_accounts(password: str) -> int:
    """
    Create an account for every ADMIN_EMAILS address that has none, with
    `password` as its first password. Existing accounts are left exactly as
    they are. Returns how many were created.
    """
    if not password:
        return 0
    password_hash = hash_password(password)
    created = 0
    for email in sorted(store.admin_emails()):
        if store.account_with_password(email) is not None:
            continue
        name = email.split("@", 1)[0].replace(".", " ").replace("_", " ").strip().title() or "Administrator"
        try:
            store.create_account(email, name, "auctioneer", password_hash)
            created += 1
        except store.EmailTaken:
            pass  # made by another start in the meantime
    if created:
        logger.info("Created %d administrator account(s) from ADMIN_EMAILS", created)
    return created


def ensure_demo_accounts(password: str) -> int:
    """Create or refresh every demo account with `password`. Returns how many."""
    password_hash = hash_password(password)
    with store._connect() as conn:  # one transaction for the set
        for email, name, role in DEMO_ACCOUNTS:
            try:
                conn.execute(
                    "INSERT INTO accounts (email, name, role, password_hash, created_at) "
                    "VALUES (?, ?, ?, ?, strftime('%s','now'))",
                    (email, name, role, password_hash),
                )
            except sqlite3.IntegrityError:
                conn.execute(
                    "UPDATE accounts SET name = ?, role = ?, password_hash = ? WHERE email = ?",
                    (name, role, password_hash, email),
                )
    logger.info("Demo accounts ready: %d on %s", len(DEMO_ACCOUNTS), DOMAIN)
    return len(DEMO_ACCOUNTS)
