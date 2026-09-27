"""
check_supabase.py
A standalone connectivity check, runnable before any of the backend is ported.

It imports nothing from this project except the .env file, so it can be run the
moment DATABASE_URL is filled in -- while SQLiteManager is still the only
database layer the app has. Its whole job is to answer four questions in the
order they fail:

    1. Is DATABASE_URL set, and does it look like the pooler string rather than
       the IPv6-only direct one?
    2. Can psycopg open a connection at all?
    3. Does the players table exist, with the columns the app expects?
    4. How many rows are in it?

Run:  python -m db.check_supabase
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

EXPECTED_COLUMNS = {
    "id", "player_name", "country", "role", "cap_status", "overseas",
    "base_price", "rating",
    # Added after this script was written. 001_players.sql has carried it since
    # the beginning (both in the CREATE TABLE and as an ADD COLUMN IF NOT EXISTS
    # for tables made before it), so without it here a correct schema was
    # reported as having an "unexpected extra column".
    "jersey_number",
    "matches", "total_runs",
    "bat_avg", "bat_sr", "boundary_pct_spin", "boundary_pct_fast",
    "sr_vs_spin", "sr_vs_fast",
    "wickets", "runs_conceded", "economy",
    "bowl_avg", "bowl_sr", "econ_vs_lhb", "econ_vs_rhb",
}


def _fail(message: str, fix: str) -> None:
    print(f"  FAIL  {message}")
    print(f"        -> {fix}")
    sys.exit(1)


def main() -> None:
    print("Supabase connectivity check")
    print("-" * 60)

    try:
        from dotenv import load_dotenv
    except ImportError:
        _fail("python-dotenv is not installed.",
              "pip install -r requirements.txt")

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")

    # --- 1. The URL ------------------------------------------------------
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        _fail("DATABASE_URL is empty.",
              "Paste the Session pooler string into .env")
    if not url.startswith("postgresql://"):
        _fail(f"DATABASE_URL does not look like a Postgres URL: {url[:30]}...",
              "It should begin postgresql://")
    if ".supabase.co:5432" in url and "pooler" not in url:
        _fail("That is the DIRECT connection string, which is IPv6-only and "
              "will hang on most networks.",
              "In Supabase -> Connect, copy the 'Session pooler' string "
              "instead (host contains 'pooler.supabase.com').")
    if "[YOUR-PASSWORD]" in url or "<password>" in url.lower():
        _fail("The password placeholder is still in the URL.",
              "Replace it with the database password you set when creating "
              "the project.")
    if ":6543" in url:
        # Caught here because the alternative is discovering it in production:
        # the transaction pooler gives a different backend per transaction, so
        # psycopg's server-side prepared statements (used automatically once a
        # query repeats five times) break. Early queries pass, later identical
        # ones fail, and it looks like an intermittent database fault.
        _fail("That is the TRANSACTION pooler (port 6543), which does not "
              "support prepared statements.",
              "Use the Session pooler instead -- same host, port 5432. "
              "psycopg would otherwise succeed a few times and then start "
              "failing on the same query.")
    print(f"  OK    DATABASE_URL looks like a session pooler string")

    # --- 2. The connection -----------------------------------------------
    try:
        import psycopg
    except ImportError:
        # Keep this version in step with requirements.txt. It used to say 3.2.3,
        # from before that pin existed, so following the hint installed a
        # different version from the one the app is built against.
        _fail("psycopg is not installed.",
              'pip install "psycopg[binary,pool]==3.3.6"')

    try:
        conn = psycopg.connect(url, connect_timeout=10)
    except Exception as exc:  # noqa: BLE001 - the message is the whole point
        _fail(f"could not connect: {exc}",
              "Check the password, and that the project is not paused "
              "(Supabase pauses free projects after 7 days idle).")
    print("  OK    connected")

    with conn:
        # --- 3. The table -------------------------------------------------
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'players'"
            )
            found = {row[0] for row in cur.fetchall()}

        if not found:
            _fail("the players table does not exist.",
                  "Run db/migrations/001_players.sql in the Supabase "
                  "SQL editor.")

        missing = EXPECTED_COLUMNS - found
        extra = found - EXPECTED_COLUMNS
        if missing:
            _fail(f"players is missing {len(missing)} column(s): "
                  f"{', '.join(sorted(missing))}",
                  "Re-run db/migrations/001_players.sql -- it was probably "
                  "pasted in part.")
        if extra:
            print(f"  WARN  players has unexpected extra column(s): "
                  f"{', '.join(sorted(extra))}")
        print(f"  OK    players table has all {len(EXPECTED_COLUMNS)} columns")

        # --- 4. The rows ---------------------------------------------------
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM players")
            count = cur.fetchone()[0]

        if count == 0:
            print("  OK    players is empty -- expected at this stage; "
                  "ingestion fills it later")
        else:
            print(f"  OK    players holds {count} rows")

    print("-" * 60)
    print("Ready. Supabase is reachable and the schema is correct.")


if __name__ == "__main__":
    main()
