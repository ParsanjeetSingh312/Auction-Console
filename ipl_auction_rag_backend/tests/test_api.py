"""
API-level tests. These run against the real SQLite and ChromaDB stores, so
`python -m ingestion.data_loader` must have been run first.

The LLM calls are not exercised here: with no Groq key configured the RAG
chain falls back to returning raw retrieved context, which is what these
tests assert on.
"""
import pytest
from fastapi.testclient import TestClient

from api.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


class TestHealth:
    def test_reports_ok(self, client):
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_reports_both_stores_populated(self, client):
        body = client.get("/api/v1/health").json()
        assert body["sqlite_players"] == 284
        assert body["chroma_documents"] == 284


class TestListPlayers:
    def test_returns_players(self, client):
        body = client.get("/api/v1/players?limit=5").json()
        assert body["total"] == 284
        assert len(body["players"]) == 5

    def test_role_filter_applies(self, client):
        body = client.get("/api/v1/players?role=Bowler&limit=100").json()
        assert body["total"] == 99
        assert all(p["role"] == "Bowler" for p in body["players"])

    def test_cap_status_filter_applies(self, client):
        body = client.get("/api/v1/players?cap_status=UNCAPPED&limit=100").json()
        assert all(p["cap_status"] == "UNCAPPED" for p in body["players"])

    def test_overseas_filter_applies(self, client):
        body = client.get("/api/v1/players?overseas=true&limit=100").json()
        assert all(p["overseas"] == 1 for p in body["players"])

    def test_pagination_returns_distinct_pages(self, client):
        first = client.get("/api/v1/players?limit=5&offset=0").json()["players"]
        second = client.get("/api/v1/players?limit=5&offset=5").json()["players"]
        assert [p["id"] for p in first] != [p["id"] for p in second]

    def test_bowler_payload_has_bowling_not_batting_stats(self, client):
        body = client.get("/api/v1/players?role=Bowler&limit=20").json()
        # At least some bowlers have a record; none should carry batting stats.
        assert any(p["economy"] is not None for p in body["players"])
        assert all(p["bat_avg"] is None for p in body["players"])

    def test_batter_payload_has_batting_not_bowling_stats(self, client):
        body = client.get("/api/v1/players?role=Batter&limit=20").json()
        assert any(p["bat_sr"] is not None for p in body["players"])
        assert all(p["economy"] is None for p in body["players"])

    def test_limit_bounds_enforced(self, client):
        assert client.get("/api/v1/players?limit=0").status_code == 422
        assert client.get("/api/v1/players?limit=99999").status_code == 422


class TestSearch:
    def test_semantic_query_returns_sources(self, client):
        response = client.post("/api/v1/search", json={
            "query": "explosive power hitter for the death overs",
            "top_k": 3,
        })
        assert response.status_code == 200
        body = response.json()
        assert body["route"] in ("SEMANTIC_VECTOR", "HYBRID", "METRIC_SQL")
        if body["sources"]:
            assert len(body["sources"]) <= 3
            assert all(s["player_name"] for s in body["sources"])

    def test_answer_never_contains_nan(self, client):
        response = client.post("/api/v1/search", json={
            "query": "most economical Indian bowler",
            "top_k": 3,
        })
        assert "nan" not in response.json()["answer"].lower()

    def test_reranker_can_be_disabled(self, client):
        response = client.post("/api/v1/search", json={
            "query": "reliable top order anchor",
            "top_k": 2,
            "use_reranker": False,
        })
        assert response.status_code == 200

    def test_empty_query_rejected(self, client):
        assert client.post("/api/v1/search", json={"query": ""}).status_code == 422

    def test_missing_query_rejected(self, client):
        assert client.post("/api/v1/search", json={}).status_code == 422

    def test_overlong_query_rejected(self, client):
        response = client.post("/api/v1/search", json={"query": "x" * 501})
        assert response.status_code == 422


class TestChat:
    def test_responds_to_a_message(self, client):
        response = client.post("/api/v1/chat", json={
            "query": "Which uncapped keepers are worth a punt?",
            "top_k": 3,
        })
        assert response.status_code == 200
        assert response.json()["answer"]

    def test_accepts_history(self, client):
        response = client.post("/api/v1/chat", json={
            "query": "What about his bowling?",
            "history": [
                {"role": "user", "content": "Tell me about Hardik Pandya"},
                {"role": "assistant", "content": "He is an all-rounder."},
            ],
            "top_k": 2,
        })
        assert response.status_code == 200
