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
    Give every ADMIN_EMAILS address an account whose password is `password`:
    created if missing, its password brought in line if not. One password for
    every administrator (ADMIN_PASSWORD). Returns how many accounts it covers.
    """
    if not password:
        return 0
    password_hash = hash_password(password)
    covered = 0
    for email in sorted(store.admin_emails()):
        found = store.account_with_password(email)
        if found is not None:
            store.update_password(found[0].id, password_hash)
        else:
            name = email.split("@", 1)[0].replace(".", " ").replace("_", " ").strip().title() or "Administrator"
            try:
                store.create_account(email, name, "auctioneer", password_hash)
            except store.EmailTaken:
                continue  # made by another start in the meantime
        covered += 1
    if covered:
        logger.info("Administrator accounts ready: %d, sharing ADMIN_PASSWORD", covered)
    return covered


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
    # Passes to try the rooms with at once: A-passes for the auctioneers,
    # D-passes for the delegates and the member (DEMO_PASS_BALANCE).
    from accounts import passes
    from config.settings import get_settings

    target = get_settings().DEMO_PASS_BALANCE
    if target > 0:
        for email, _name, role in DEMO_ACCOUNTS:
            found = store.account_with_password(email)
            if found is not None:
                passes.top_up(found[0].id, "A" if role == "auctioneer" else "D", target)
    logger.info("Demo accounts ready: %d on %s", len(DEMO_ACCOUNTS), DOMAIN)
    return len(DEMO_ACCOUNTS)
