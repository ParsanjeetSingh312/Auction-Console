"""
test_smoke.py
Proof that the harness runs before any attack code leans on it.

Nothing here is an attack. These four tests confirm the two things every later
phase assumes: a fresh room loads the seeded pool (with the base-price floor
applied to the unpriced rows), and the staging app serves that same pool over
HTTP from a disposable database rather than the real one. If the suite is ever
red, run this file first -- a failure here is a harness problem, not a finding.
"""
from __future__ import annotations

from harness.staging import SEEDED_PLAYERS, UNPRICED_PLAYER_IDS


def test_fresh_room_loads_the_seeded_pool(room):
    """The room-level phases get exactly the five seeded players, all available."""
    assert len(room.players) == len(SEEDED_PLAYERS) == 5
    assert all(rec.status == "available" for rec in room.records.values())


def test_base_price_floor_substituted_only_where_missing(room):
    """
    The unpriced rows fall back to BASE_PRICE_FLOOR; the priced ones keep theirs.

    This is the substitution `room.load_players` shares with the console, and the
    reason the seeded pool carries two null-priced players in the first place.
    """
    from auction.room import BASE_PRICE_FLOOR

    for pid in UNPRICED_PLAYER_IDS:
        assert room.players[pid].base == BASE_PRICE_FLOOR
    assert room.players[1].base == 200
    assert room.players[5].base == 100


def test_staging_app_serves_the_seeded_pool(staging_client):
    """The REST/DAST phases see the seeded five, proving the DB redirect took."""
    response = staging_client.get("/api/v1/players")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 5
    names = {p["player_name"] for p in body["players"]}
    assert names == {p["player_name"] for p in SEEDED_PLAYERS}


def test_staging_never_serves_the_real_dataset(staging_client):
    """
    A guard on the guard: the real pool is ~284 players, so a total of five is
    positive evidence the suite is hitting the disposable DB and not production.
    """
    assert staging_client.get("/api/v1/players").json()["total"] < 50
