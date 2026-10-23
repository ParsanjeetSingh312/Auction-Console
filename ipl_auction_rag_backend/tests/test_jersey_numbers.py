"""
Tests for the squad-number sync (ingestion/jersey_numbers.py).

The bug this guards: numbers written straight into one deployment's players
table never reached another, so auctoniq.com showed 5 shirt numbers where the
development machine showed 46. The committed file is the source of truth and
must land in whatever table the backend is pointed at.
"""
from __future__ import annotations

from ingestion import jersey_numbers


class FakeDB:
    def __init__(self, rows):
        self.rows = {r["id"]: dict(r) for r in rows}

    def get_all_players(self, limit=500, offset=0):
        return list(self.rows.values())

    def update_player_column(self, player_id, column, value, *, fill_only=False):
        self.rows[player_id][column] = value
        return 1


def test_file_numbers_reach_the_table(monkeypatch):
    db = FakeDB([
        {"id": 1, "player_name": "Hardik Pandya", "jersey_number": None},
        {"id": 2, "player_name": "Virat Kohli", "jersey_number": 18},
        {"id": 3, "player_name": "Unlisted Player", "jersey_number": None},
    ])
    monkeypatch.setattr("db.get_player_db", lambda: db)
    monkeypatch.setattr(jersey_numbers, "load_numbers", lambda: {"Hardik Pandya": 33, "Virat Kohli": 18})

    assert jersey_numbers.sync_jersey_numbers() == 1, "only the row that differs is written"
    assert db.rows[1]["jersey_number"] == 33
    assert db.rows[2]["jersey_number"] == 18
    assert db.rows[3]["jersey_number"] is None, "a player the file does not name is never given a number"
    assert jersey_numbers.sync_jersey_numbers() == 0, "a second run is a no-op"


def test_committed_file_is_well_formed():
    numbers = jersey_numbers.load_numbers()
    assert len(numbers) >= 46
    assert numbers["Virat Kohli"] == 18 and numbers["Rohit Sharma"] == 45 and numbers["MS Dhoni"] == 7
    assert all(0 <= n <= 999 for n in numbers.values())


def test_a_broken_table_does_not_raise(monkeypatch):
    def boom():
        raise RuntimeError("database unreachable")

    monkeypatch.setattr("db.get_player_db", boom)
    assert jersey_numbers.sync_jersey_numbers() == 0
