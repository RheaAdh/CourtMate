import os
import unittest

os.environ["COURTMATE_DATASTORE"] = "memory"
os.environ["COURTMATE_AUTH_REQUIRED"] = "false"
os.environ["GEMINI_API_KEY"] = ""

from fastapi.testclient import TestClient

from backend.main import app


class ApiFlowTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_search_returns_existing_dupr_compatible_group(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find a casual intermediate game near Whitefield this Sunday morning", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["action"], "join_existing")
        self.assertEqual(payload["recommendations"][0]["session"]["id"], "s1")

    def test_no_match_proposes_group_and_join_request_is_explicit(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find an advanced game near Indiranagar this Sunday evening", "player_id": "p1"})
        self.assertEqual(response.json()["action"], "create_group")
        created = self.client.post("/v1/groups", json={"query": "Find an advanced game near Indiranagar this Sunday evening", "player_id": "p1"})
        self.assertEqual(created.status_code, 200)
        session_id = created.json()["session"]["id"]
        join = self.client.post(f"/v1/sessions/{session_id}/join", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(join.status_code, 200)
        self.assertEqual(join.json()["status"], "pending")


if __name__ == "__main__":
    unittest.main()
