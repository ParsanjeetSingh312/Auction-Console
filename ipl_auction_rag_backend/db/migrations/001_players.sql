-- ==============================================================================
-- 001_players.sql — the players table, translated from SQLite to PostgreSQL.
--
-- The source of truth for this schema is CREATE_PLAYERS_TABLE in
-- db/sqlite_manager.py. If one changes, both must.
--
-- Run this once in the Supabase SQL editor. It is idempotent: re-running it
-- creates nothing twice and destroys nothing.
--
-- Three translation decisions are load-bearing:
--
--   id        INTEGER PRIMARY KEY AUTOINCREMENT -> GENERATED ALWAYS AS IDENTITY.
--             Safe because ingestion never writes id: data_loader.py lists its
--             insert columns explicitly and id is not among them.
--
--   REAL      -> DOUBLE PRECISION. Postgres has a REAL, but it is single
--             precision; SQLite's REAL is a 64-bit float, so this is the
--             faithful type, not the similarly named one.
--
--   overseas  stays INTEGER, deliberately NOT boolean. Queries written by hand
--             (routes.py, local_analyst.py) and by the LLM (text_to_sql.py) all
--             say `overseas = 1`. SQLite coerces that against a boolean column;
--             Postgres raises. Keeping 0/1 means no call site has to change.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS players (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Core Identity
    player_name        TEXT NOT NULL,
    country            TEXT DEFAULT 'Unknown',
    role               TEXT NOT NULL,
    cap_status         TEXT NOT NULL DEFAULT 'CAPPED',
    overseas           INTEGER NOT NULL DEFAULT 0,
    base_price         DOUBLE PRECISION,
    rating             DOUBLE PRECISION,

    -- Match Stats
    matches            INTEGER,
    total_runs         INTEGER,

    -- Batting Stats (batting-semantics rows: Batter/Wicket Keeper/All-Rounder)
    bat_avg            DOUBLE PRECISION,
    bat_sr             DOUBLE PRECISION,
    boundary_pct_spin  DOUBLE PRECISION,
    boundary_pct_fast  DOUBLE PRECISION,
    sr_vs_spin         DOUBLE PRECISION,
    sr_vs_fast         DOUBLE PRECISION,

    -- Bowling Stats (bowling-semantics rows: Bowler)
    wickets            INTEGER,
    runs_conceded      INTEGER,
    economy            DOUBLE PRECISION,
    bowl_avg           DOUBLE PRECISION,
    bowl_sr            DOUBLE PRECISION,
    econ_vs_lhb        DOUBLE PRECISION,
    econ_vs_rhb        DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_players_role       ON players(role);
CREATE INDEX IF NOT EXISTS idx_players_cap_status ON players(cap_status);
CREATE INDEX IF NOT EXISTS idx_players_overseas   ON players(overseas);
CREATE INDEX IF NOT EXISTS idx_players_name       ON players(player_name);
