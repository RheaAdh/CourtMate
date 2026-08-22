import os
import unittest
from datetime import date, time, timedelta

os.environ["COURTMATE_DATASTORE"] = "memory"
os.environ["COURTMATE_AUTH_REQUIRED"] = "false"
os.environ["GEMINI_API_KEY"] = ""

from fastapi.testclient import TestClient

from backend.main import app, repository
from backend.models import Session


class ApiFlowTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_search_returns_existing_dupr_compatible_group(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find a casual intermediate game near Whitefield this Sunday morning", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["action"], "join_existing")
        self.assertEqual(payload["recommendations"][0]["session"]["id"], "s1")

    def test_group_view_returns_public_member_profiles(self):
        response = self.client.get("/v1/sessions/s1/group")
        self.assertEqual(response.status_code, 200)
        members = response.json()["members"]
        self.assertEqual({member["id"] for member in members}, {"p1", "p2", "p3", "p6"})
        self.assertEqual(members[0]["dupr_rating"], 3.2)
        self.assertNotIn("friends", members[0])

    def test_profile_preferences_update_includes_availability(self):
        response = self.client.post(
            "/v1/me/profile",
            json={"area": "Brookefield", "dupr_rating": 3.6, "style": "social", "availability": ["weekend mornings"]},
            headers={"X-CourtMate-Player-ID": "profile-test-player"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["area"], "Brookefield")
        self.assertEqual(payload["availability"], ["weekend mornings"])

    def test_profile_and_search_are_sport_aware(self):
        profile = self.client.post(
            "/v1/me/profile",
            json={"sport": "badminton", "skill_rating": 3.8},
            headers={"X-CourtMate-Player-ID": "sport-profile-player"},
        )
        self.assertEqual(profile.status_code, 200)
        self.assertEqual(profile.json()["sport_ratings"]["badminton"], 3.8)

        search = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find a badminton game near Whitefield this evening", "sport": "badminton"},
            headers={"X-CourtMate-Player-ID": "sport-profile-player"},
        )
        self.assertEqual(search.status_code, 200)
        self.assertTrue(search.json()["recommendations"])
        self.assertTrue(all(item["session"]["sport"] == "badminton" for item in search.json()["recommendations"]))

    def test_expired_session_closes_and_stops_new_changes(self):
        session_id = "expired-session"
        repository.save_session(
            Session(
                id=session_id,
                sport="badminton",
                group_name="Expired Badminton Game",
                organizer_id="p1",
                area="Whitefield",
                session_date=date.today() - timedelta(days=1),
                start_time=time(18),
                end_time=time(20),
                skill_min=3,
                skill_max=4,
                style="casual",
                capacity=4,
                confirmed_player_ids=["p1"],
            )
        )
        join = self.client.post(f"/v1/sessions/{session_id}/join", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(join.status_code, 409)
        self.assertIn("closed", join.json()["detail"])
        self.assertEqual(repository.get_session(session_id).status, "completed")

        history = self.client.get("/v1/me/games", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(history.status_code, 200)
        past_game = next(item for item in history.json()["past_games"] if item["session"]["id"] == session_id)
        self.assertEqual(past_game["group_size"], 1)
        self.assertEqual(past_game["rank"], 1)

        chat = self.client.post(f"/v1/sessions/{session_id}/chat", json={"message": "Can we still join?"}, headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(chat.status_code, 409)

    def test_no_match_proposes_group_and_join_request_is_explicit(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find an advanced game near Indiranagar this Sunday evening", "player_id": "p1"})
        self.assertEqual(response.json()["action"], "create_group")
        created = self.client.post("/v1/groups", json={"query": "Find an advanced game near Indiranagar this Sunday evening", "player_id": "p1"})
        self.assertEqual(created.status_code, 200)
        session_id = created.json()["session"]["id"]
        join = self.client.post(f"/v1/sessions/{session_id}/join", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(join.status_code, 200)
        self.assertEqual(join.json()["status"], "pending")

        organizer_view = self.client.get(f"/v1/me/groups", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(organizer_view.status_code, 200)
        self.assertIn(session_id, {group["id"] for group in organizer_view.json()["groups"]})

        decision = self.client.post(
            f"/v1/sessions/{session_id}/join-requests/{join.json()['id']}/decision",
            json={"status": "approved"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(decision.status_code, 200)
        self.assertEqual(decision.json()["status"], "approved")

        requester_view = self.client.get("/v1/me/requests", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(requester_view.status_code, 200)
        request_views = requester_view.json()["requests"]
        self.assertEqual(request_views[-1]["request"]["status"], "approved")

        games_view = self.client.get("/v1/me/games", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(games_view.status_code, 200)
        self.assertIn(session_id, {game["id"] for game in games_view.json()["games"]})

        chat_post = self.client.post(f"/v1/sessions/{session_id}/chat", json={"message": "Court is booked for 7 PM"}, headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(chat_post.status_code, 200)
        chat_view = self.client.get(f"/v1/sessions/{session_id}/chat", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(chat_view.status_code, 200)
        self.assertEqual(chat_view.json()["posts"][0]["message"], "Court is booked for 7 PM")

        feedback = self.client.post(
            f"/v1/sessions/{session_id}/feedback",
            json={"fun": 5, "fairness": 5, "would_return": True, "ratings": [{"player_id": "p1", "rating": 5, "comment": "Great organizer"}]},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(feedback.status_code, 200)
        leaderboard = self.client.get(f"/v1/sessions/{session_id}/leaderboard", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(leaderboard.status_code, 200)
        p1_entry = next(entry for entry in leaderboard.json()["entries"] if entry["player"]["id"] == "p1")
        self.assertEqual(p1_entry["score"], 5.0)
        self.assertEqual(p1_entry["ratings_count"], 1)

        waitlist = self.client.post("/v1/sessions/s7/join", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertEqual(waitlist.status_code, 200)
        self.assertEqual(waitlist.json()["status"], "waitlisted")
        leave = self.client.post("/v1/sessions/s7/leave", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(leave.status_code, 200)
        self.assertIn("p4", leave.json()["confirmed_player_ids"])
        self.assertNotIn("p4", leave.json()["waitlist_player_ids"])


if __name__ == "__main__":
    unittest.main()
