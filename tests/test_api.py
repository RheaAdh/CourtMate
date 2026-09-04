import io
import os
import unittest
from datetime import date, datetime, time, timedelta
from unittest.mock import MagicMock, patch

os.environ["COURTMATE_DATASTORE"] = "memory"
os.environ["COURTMATE_AUTH_REQUIRED"] = "false"
os.environ["COURTMATE_DEV_PLAYER_ID"] = "p1"
os.environ["GEMINI_API_KEY"] = ""
os.environ["COURTMATE_USE_VERTEX_AI"] = "false"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
os.environ["COURTMATE_USE_GEMINI_INTENT"] = "false"
os.environ["COURTMATE_GROUNDED_RESPONSE_WITH_GEMINI"] = "false"
os.environ["COURTMATE_VECTOR_SEARCH_ENABLED"] = "false"

from fastapi.testclient import TestClient

from backend.main import _clear_read_view_cache, _clear_social_feed_cache, app, intent_parser, local_timezone, repository
from backend.models import AppNotification, CMRHistoryPoint, FollowRecord, Session
from backend.seed_synthetic_firestore import seed
from tests.fixtures import load_repository_fixture


class ApiFlowTests(unittest.TestCase):
    def setUp(self):
        load_repository_fixture(repository)
        _clear_read_view_cache()
        _clear_social_feed_cache()
        self.client = TestClient(app)

    def submit_feedback_for_everyone(self, session_id="s1"):
        session = repository.get_session(session_id)
        for player_id in session.confirmed_player_ids:
            completed = self.client.post(
                f"/v1/sessions/{session_id}/complete",
                headers={"X-CourtMate-Player-ID": player_id},
            )
            self.assertEqual(completed.status_code, 200)
            ratings = [{"player_id": other_id, "rating_10": 7} for other_id in session.confirmed_player_ids if other_id != player_id]
            response = self.client.post(
                f"/v1/sessions/{session_id}/feedback",
                json={"fun": 5, "fairness": 5, "would_return": True, "ratings": ratings},
                headers={"X-CourtMate-Player-ID": player_id},
            )
            self.assertEqual(response.status_code, 200)

    def test_search_returns_existing_dupr_compatible_group(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find a casual intermediate game near Whitefield this Sunday morning"}, headers={"X-CourtMate-Player-ID": "p2"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["action"], "join_existing")
        self.assertEqual(payload["recommendations"][0]["session"]["id"], "s1")
        self.assertIn(payload["retrieval"]["mode"], {"vector", "deterministic_fallback"})

    def test_check_in_tracks_on_time_arrival_once(self):
        now = datetime.now(local_timezone).replace(second=0, microsecond=0)
        session = repository.get_session("s1").model_copy(update={
            "session_date": now.date(),
            "start_time": (now - timedelta(minutes=5)).time(),
            "end_time": (now + timedelta(hours=1)).time(),
            "status": "open",
        })
        repository.save_session(session)

        response = self.client.post("/v1/sessions/s1/check-in", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("p2", response.json()["checked_in_player_ids"])
        player = repository.get_player("p2")
        self.assertEqual(player.on_time_check_in_count, 1)
        self.assertEqual(player.late_check_in_count, 0)

        repeated = self.client.post("/v1/sessions/s1/check-in", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repository.get_player("p2").on_time_check_in_count, 1)

    def test_confirmed_late_withdrawal_updates_reliability_record(self):
        now = datetime.now(local_timezone).replace(second=0, microsecond=0)
        starts_at = now + timedelta(hours=2)
        ends_at = starts_at + timedelta(hours=2)
        # Keep both wall-clock times on the same session date when this test
        # runs late at night; otherwise the API correctly sees the game as over.
        if ends_at.date() != starts_at.date():
            ends_at = starts_at.replace(hour=23, minute=59)
        session = repository.get_session("s1").model_copy(update={
            "session_date": starts_at.date(),
            "start_time": starts_at.time(),
            "end_time": ends_at.time(),
            "status": "open",
        })
        repository.save_session(session)

        response = self.client.post("/v1/sessions/s1/leave", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(response.status_code, 200)
        player = repository.get_player("p2")
        self.assertEqual(player.withdrawal_count, 1)
        self.assertEqual(player.late_withdrawal_count, 1)
        self.assertNotIn("p2", response.json()["confirmed_player_ids"])

    def test_player_density_is_aggregated_and_radius_filtered(self):
        response = self.client.get(
            "/v1/me/player-density",
            params={"sport": "tennis", "latitude": 12.9698, "longitude": 77.7499, "radius_km": 20},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["radius_km"], 20.0)
        self.assertTrue(payload["points"])
        self.assertGreaterEqual(payload["points"][0]["player_count"], 3)
        self.assertIn("cmr_min", payload["points"][0])
        self.assertNotIn("player_ids", payload["points"][0])

    def test_community_map_returns_public_games_clusters_and_no_private_games(self):
        private_game = repository.get_session("s1").model_copy(update={
            "id": "demo-private-map-game",
            "group_name": "Private Apartment Game",
            "visibility": "private",
        })
        repository.save_session(private_game)
        response = self.client.get(
            "/v1/me/community-map",
            params={"sport": "pickleball", "latitude": 12.9698, "longitude": 77.7499, "radius_km": 20, "activity_type": "all"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        game_ids = {game["id"] for game in payload["nearby_games"]}
        self.assertIn("s1", game_ids)
        self.assertNotIn("demo-private-map-game", game_ids)
        self.assertTrue(payload["game_clusters"])
        self.assertTrue(payload["player_density"])
        self.assertNotIn("player_ids", payload["player_density"][0])
        self.assertNotIn("display_name", payload["player_density"][0])

    def test_public_community_map_allows_guest_browsing_without_private_games(self):
        private_game = repository.get_session("s1").model_copy(update={
            "id": "guest-hidden-game",
            "visibility": "private",
        })
        repository.save_session(private_game)

        response = self.client.get(
            "/v1/public/community-map",
            params={"sport": "pickleball", "area": "Whitefield", "radius_km": 20, "activity_type": "games"},
        )
        self.assertEqual(response.status_code, 200)
        game_ids = {game["id"] for game in response.json()["nearby_games"]}
        self.assertIn("s1", game_ids)
        self.assertNotIn("guest-hidden-game", game_ids)

    def test_notifications_clear_resolved_join_and_follow_actions(self):
        join = self.client.post("/v1/sessions/s1/join", headers={"X-CourtMate-Player-ID": "p5"})
        self.assertEqual(join.status_code, 200)
        request_id = join.json()["id"]

        pending_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p1"})
        pending_notification = next(item for item in pending_notifications.json()["notifications"] if item["request_id"] == request_id)
        self.assertEqual(pending_notification["action_status"], "pending")
        self.assertFalse(pending_notification["read"])

        decision = self.client.post(
            f"/v1/sessions/s1/join-requests/{request_id}/decision",
            json={"status": "approved"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(decision.status_code, 200)
        resolved_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertFalse(any(item["request_id"] == request_id for item in resolved_notifications.json()["notifications"]))

        follow = self.client.post("/v1/players/p2/follow", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(follow.status_code, 200)
        follow_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})
        follow_notification = next(item for item in follow_notifications.json()["notifications"] if item["kind"] == "follow" and item["actor_id"] == "p1")
        self.assertEqual(follow_notification["action_status"], "pending")

        accepted = self.client.post(
            f"/v1/me/follow-requests/{follow_notification['id']}",
            json={"status": "approved"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(accepted.status_code, 200)
        resolved_follow_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertFalse(any(item["id"] == follow_notification["id"] for item in resolved_follow_notifications.json()["notifications"]))

    def test_read_notifications_are_cleared_but_pending_actions_remain(self):
        repository.save_notification(AppNotification(
            id="plain-alert",
            player_id="p2",
            title="New game nearby",
            message="A new game matches your preferences.",
            session_id="s1",
            created_at=datetime.now().astimezone(),
        ))
        follow = self.client.post("/v1/players/p2/follow", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(follow.status_code, 200)

        self.client.post("/v1/me/notifications/plain-alert/read", headers={"X-CourtMate-Player-ID": "p2"})
        self.client.post("/v1/me/notifications/follow-p1-p2/read", headers={"X-CourtMate-Player-ID": "p2"})
        visible = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"}).json()["notifications"]

        self.assertFalse(any(item["id"] == "plain-alert" for item in visible))
        self.assertTrue(any(item["id"] == "follow-p1-p2" and item["action_status"] == "pending" for item in visible))

    def test_mutual_connections_join_an_open_game_without_approval(self):
        now = datetime.now(local_timezone)
        repository.save_follow(FollowRecord(id="p1_p5", follower_id="p1", following_id="p5", status="accepted", created_at=now))
        repository.save_follow(FollowRecord(id="p5_p1", follower_id="p5", following_id="p1", status="accepted", created_at=now))

        joined = self.client.post("/v1/sessions/s1/join", headers={"X-CourtMate-Player-ID": "p5"})

        self.assertEqual(joined.status_code, 200)
        self.assertEqual(joined.json()["status"], "approved")
        self.assertIn("p5", repository.get_session("s1").confirmed_player_ids)
        organizer_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p1"}).json()["notifications"]
        self.assertFalse(any(item["kind"] == "join_request" and item["request_id"] == joined.json()["id"] for item in organizer_notifications))

    def test_community_map_visibility_filter_shows_connection_games_without_private_games(self):
        repository.save_follow(FollowRecord(
            id="p1_p2",
            follower_id="p1",
            following_id="p2",
            created_at=datetime.now(local_timezone),
        ))
        connection_game = repository.get_session("s1").model_copy(update={
            "id": "connection-followers-map-game",
            "organizer_id": "p2",
            "visibility": "followers",
        })
        private_connection_game = connection_game.model_copy(update={
            "id": "connection-private-map-game",
            "visibility": "private",
        })
        repository.save_session(connection_game)
        repository.save_session(private_connection_game)
        base_params = {
            "sport": "pickleball",
            "latitude": 12.9698,
            "longitude": 77.7499,
            "radius_km": 20,
            "activity_type": "games",
        }

        public_response = self.client.get(
            "/v1/me/community-map",
            params={**base_params, "visibility_filter": "public"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(public_response.status_code, 200)
        public_ids = {game["id"] for game in public_response.json()["nearby_games"]}
        self.assertIn("s1", public_ids)
        self.assertNotIn("connection-followers-map-game", public_ids)

        friends_response = self.client.get(
            "/v1/me/community-map",
            params={**base_params, "visibility_filter": "friends"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(friends_response.status_code, 200)
        friends_games = {game["id"]: game for game in friends_response.json()["nearby_games"]}
        self.assertIn("connection-followers-map-game", friends_games)
        self.assertTrue(friends_games["connection-followers-map-game"]["is_connection_game"])
        self.assertNotIn("connection-private-map-game", friends_games)

        all_response = self.client.get(
            "/v1/me/community-map",
            params={**base_params, "visibility_filter": "all"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        all_ids = {game["id"] for game in all_response.json()["nearby_games"]}
        self.assertIn("s1", all_ids)
        self.assertIn("connection-followers-map-game", all_ids)
        self.assertNotIn("connection-private-map-game", all_ids)

        guest_response = self.client.get(
            "/v1/public/community-map",
            params={**base_params, "visibility_filter": "friends", "area": "Whitefield"},
        )
        self.assertEqual(guest_response.status_code, 200)
        guest_ids = {game["id"] for game in guest_response.json()["nearby_games"]}
        self.assertIn("s1", guest_ids)
        self.assertNotIn("connection-followers-map-game", guest_ids)

    def test_community_map_filters_games_by_time_and_activity_type(self):
        response = self.client.get(
            "/v1/me/community-map",
            params={"sport": "pickleball", "latitude": 12.9698, "longitude": 77.7499, "radius_km": 20, "time_of_day": "night", "activity_type": "games"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["player_density"], [])
        self.assertEqual(payload["community_activity"], [])
        self.assertEqual(payload["nearby_games"], [])
        self.assertEqual(payload["game_clusters"], [])

    def test_community_map_ignores_games_without_geocodable_coordinates(self):
        session = repository.get_session("s1").model_copy(update={
            "id": "unmapped-map-game",
            "area": "Unknown Locality",
            "latitude": None,
            "longitude": None,
        })
        repository.save_session(session)
        response = self.client.get(
            "/v1/me/community-map",
            params={"sport": "pickleball", "latitude": 12.9698, "longitude": 77.7499, "radius_km": 20},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("unmapped-map-game", {game["id"] for game in response.json()["nearby_games"]})

    def test_explore_keeps_visible_games_that_are_not_a_hard_location_or_cmr_match(self):
        far_game = repository.get_session("s1").model_copy(update={
            "id": "far-game",
            "group_name": "Far Squash Rally",
            "organizer_id": "p2",
            "sport": "squash",
            "area": "Indiranagar",
            "latitude": 12.9784,
            "longitude": 77.6408,
            "skill_min": 4.8,
            "skill_max": 5.0,
            "confirmed_player_ids": ["p2"],
        })
        repository.save_session(far_game)
        response = self.client.get("/v1/me/explore", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(response.status_code, 200)
        games = {item["session"]["id"] for item in response.json()["recommendations"]}
        self.assertIn("far-game", games)

    def test_curated_facilities_filter_by_sport_and_area(self):
        response = self.client.get(
            "/v1/me/venues",
            params={"sport": "badminton", "area": "HSR Layout"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        facilities = response.json()["facilities"]
        self.assertTrue(facilities)
        self.assertEqual(facilities[0]["area"], "HSR Layout")
        self.assertTrue(all(item["sport"] == "badminton" for item in facilities))

    def test_community_leaderboard_hides_under_sampled_circles(self):
        response = self.client.get(
            "/v1/me/community-leaderboard",
            params={"sport": "badminton"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["entries"], [])

    def test_joining_community_is_persistent_and_idempotent(self):
        payload = {"sport": "badminton", "area": "Whitefield"}
        first = self.client.post("/v1/me/communities/join", json=payload, headers={"X-CourtMate-Player-ID": "p1"})
        second = self.client.post("/v1/me/communities/join", json=payload, headers={"X-CourtMate-Player-ID": "p1"})
        listed = self.client.get("/v1/me/communities", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()["memberships"]), 1)
        self.assertEqual(listed.json()["memberships"][0]["community_id"], "community:badminton:whitefield")

    def test_chat_followup_keeps_previous_game_context(self):
        original = "Find a pickleball game near Whitefield this Sunday morning"
        headers = {"X-CourtMate-Player-ID": "p2"}
        first = self.client.post("/v1/sessions/search", json={"query": original}, headers=headers)
        self.assertEqual(first.status_code, 200)

        followup = self.client.post(
            "/v1/sessions/search",
            json={"query": "make it more casual", "context": original},
            headers=headers,
        )
        self.assertEqual(followup.status_code, 200)
        self.assertEqual(followup.json()["scope"], "court_discovery")
        self.assertEqual(followup.json()["intent"]["sport"], "pickleball")
        self.assertEqual(followup.json()["intent"]["area"], "Whitefield")
        self.assertEqual(followup.json()["recommendations"][0]["session"]["id"], "s1")
        self.assertIn("Sunday Rally Crew", followup.json()["message"])

    def test_chat_search_never_recommends_a_game_created_by_the_player(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find a casual intermediate pickleball game near Whitefield this Sunday morning"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(all(item["session"]["organizer_id"] != "p1" for item in response.json()["recommendations"]))

    def test_unrelated_followup_does_not_inherit_game_context(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={
                "query": "What is the weather?",
                "context": "Find a pickleball game near Whitefield this Sunday morning",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["scope"], "out_of_scope")
        self.assertEqual(response.json()["recommendations"], [])

    def test_chat_search_keeps_clock_time_out_of_skill_rating(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find an advanced tennis game near Indiranagar this Saturday at 8 AM"},
        )
        intent = response.json()["intent"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(intent["area"], "Indiranagar")
        this_saturday = date.today() + timedelta(days=(5 - date.today().weekday()) % 7)
        self.assertEqual(intent["date"], str(this_saturday))
        self.assertEqual(intent["skill_min"], 6.0)
        self.assertEqual(intent["skill_max"], 10.0)

    def test_chat_search_uses_profile_area_for_around_me(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Show me games around me this weekend"},
        )
        intent = response.json()["intent"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(intent["area"], "Whitefield")
        self.assertEqual([item["session"]["id"] for item in response.json()["recommendations"]], ["s2"])

    def test_chat_search_keeps_skill_phrase_out_of_locality(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find a tennis game near Whitefield with skill 3.6-4.2 at 7 PM"},
        )
        intent = response.json()["intent"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(intent["area"], "Whitefield")
        self.assertEqual(intent["skill_min"], 3.6)
        self.assertEqual(intent["skill_max"], 4.2)

    def test_nearby_court_query_returns_contextual_suggestions(self):
        response = self.client.post("/v1/sessions/search", json={"query": "What courts are nearby?", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "court_discovery")
        self.assertTrue(payload["recommendations"])
        self.assertIn("pickleball", payload["message"])

    def test_performance_chat_uses_player_history_without_gemini(self):
        response = self.client.post(
            "/v1/me/performance-chat",
            json={"query": "How is my pickleball performance trending?"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["scope"], "performance")
        self.assertIn("CMR", response.json()["answer"])

    def test_performance_quick_prompts_are_grounded_and_never_call_gemini(self):
        self.assertTrue(intent_parser.is_performance_query("What's my current skill level?"))
        self.assertFalse(intent_parser.is_performance_query("Find a badminton game at my skill level"))
        player = repository.get_player("p1")
        history = [
            CMRHistoryPoint(session_id="history-1", session_date=date.today() - timedelta(days=14), group_name="Whitefield Rally", rating=4.80, delta=0.10),
            CMRHistoryPoint(session_id="history-2", session_date=date.today() - timedelta(days=7), group_name="Brookefield Doubles", rating=5.00, delta=0.20),
            CMRHistoryPoint(session_id="history-3", session_date=date.today(), group_name="Sunday Smash", rating=5.15, delta=0.15),
        ]
        repository.save_player(player.model_copy(update={
            "cmr_scale": 10,
            "cmr_ratings": {"badminton": 5.15, "pickleball": 4.20},
            "cmr_game_counts": {"badminton": 3, "pickleball": 2},
            "cmr_history": {"badminton": history},
        }))
        fake_client = MagicMock()
        fake_client.models.generate_content.return_value.text = "requirement: Explain when"

        scenarios = {
            "How is my CMR changing?": ("4.80 to 5.15", "up 0.35"),
            "Tell me my CMR progression": ("Badminton: 4.80 to 5.15", "Pickleball: 4.20 to 4.20"),
            "What should I improve?": ("result data", "shot-level data"),
            "Summarise my recent games": ("Sunday Smash", "Brookefield Doubles"),
            "Analyze my existing Badminton CMR and game history. What should I work on next?": ("Badminton", "5.15"),
            "How am I doing?": ("Badminton", "5.15"),
            "What's my current skill level?": ("Strong intermediate", "Badminton", "5.15"),
            "What is my Pickleball skill level?": ("Intermediate", "Pickleball", "4.20"),
            "What is my reliability?": ("94%", "confirmed show-ups"),
            "What is my weakest sport?": ("Pickleball", "4.20"),
        }
        with patch.object(intent_parser, "_client", fake_client):
            for query, expected_fragments in scenarios.items():
                with self.subTest(query=query):
                    response = self.client.post(
                        "/v1/me/performance-chat",
                        json={"query": query},
                        headers={"X-CourtMate-Player-ID": "p1"},
                    )
                    self.assertEqual(response.status_code, 200)
                    answer = response.json()["answer"]
                    for fragment in expected_fragments:
                        self.assertIn(fragment, answer)
                    self.assertNotIn("requirement:", answer.lower())
                    self.assertNotEqual(answer, "[]")

        fake_client.models.generate_content.assert_not_called()

    def test_performance_chat_explains_when_history_is_insufficient(self):
        player = repository.get_player("p1")
        repository.save_player(player.model_copy(update={
            "cmr_scale": 10,
            "cmr_ratings": {"pickleball": 4.70},
            "cmr_game_counts": {"pickleball": 1},
            "cmr_history": {"pickleball": [CMRHistoryPoint(session_id="history-1", session_date=date.today(), group_name="First Rally", rating=4.70, delta=0.0)]},
        }))
        response = self.client.post(
            "/v1/me/performance-chat",
            json={"query": "What should I improve?"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("too little evidence", response.json()["answer"])
        self.assertIn("2 more rated games", response.json()["answer"])

    def test_performance_chat_rejects_malformed_gemini_wearable_answer(self):
        player = repository.get_player("p1").model_copy(update={
            "cmr_scale": 10,
            "cmr_ratings": {"pickleball": 4.90},
            "cmr_game_counts": {"pickleball": 4},
        })
        fake_client = MagicMock()
        fake_client.models.generate_content.return_value.text = "[]"
        with patch.object(intent_parser, "_client", fake_client):
            answer = intent_parser.discuss_performance(
                "Compare my wearable heart rate with my form",
                player,
                {},
                [{"sport": "pickleball", "analysis": {"average_heart_rate_bpm": 142}}],
            )
        self.assertIn("4.90", answer)
        self.assertNotEqual(answer, "[]")

    def test_performance_chat_keeps_unrelated_questions_out_of_scope(self):
        response = self.client.post(
            "/v1/me/performance-chat",
            json={"query": "What is the weather today?"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["scope"], "out_of_scope")
        self.assertIn("racket-sport history", response.json()["answer"])

    def test_group_chat_logs_scores_without_replacing_feedback_driven_cmr(self):
        session = repository.get_session("s1")
        session.status = "awaiting_feedback"
        repository.save_session(session)

        result = self.client.post(
            "/v1/sessions/s1/chat",
            json={
                "message": "Ananya and Kavya beat Rohit and Sana 11-8",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(result.status_code, 200)
        self.assertIn("Ananya", result.json()["message"])
        self.assertIn("Rohit", result.json()["message"])
        self.assertEqual(result.json()["result_status"], "pending_confirmation")
        post_id = result.json()["id"]

        for player_id in ("p2", "p3", "p6"):
            confirmation = self.client.post(
                f"/v1/sessions/s1/chat/{post_id}/decision",
                json={"agree": True},
                headers={"X-CourtMate-Player-ID": player_id},
            )
            self.assertEqual(confirmation.status_code, 200)
        self.assertEqual(confirmation.json()["result_status"], "confirmed")

        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertIsNone(profile.json()["cmr_ratings"].get("pickleball"))

    def test_group_chat_continues_after_the_game_is_completed(self):
        session = repository.get_session("s1").model_copy(update={"status": "completed"})
        repository.save_session(session)

        response = self.client.post(
            "/v1/sessions/s1/chat",
            json={"message": "Great game, same time next week?"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["post_type"], "message")

    def test_group_chat_preserves_client_message_id_and_retries_idempotently(self):
        request = {
            "message": "Court 2 is booked",
            "client_message_id": "client-12345678-abcd-4321-abcd-123456789abc",
        }
        first = self.client.post(
            "/v1/sessions/s1/chat",
            json=request,
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        retry = self.client.post(
            "/v1/sessions/s1/chat",
            json=request,
            headers={"X-CourtMate-Player-ID": "p1"},
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["id"], request["client_message_id"])
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["id"], request["client_message_id"])
        self.assertEqual(
            len([post for post in repository.list_chat_posts("s1") if post.id == request["client_message_id"]]),
            1,
        )

    def test_casual_game_result_is_saved_but_does_not_change_cmr(self):
        session = repository.get_session("s1").model_copy(update={"status": "completed", "rating_mode": "casual"})
        repository.save_session(session)

        result = self.client.post(
            "/v1/sessions/s1/chat",
            json={"message": "Ananya and Kavya beat Rohit and Sana 11-8"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(result.status_code, 200)
        post_id = result.json()["id"]
        for player_id in ("p2", "p3", "p6"):
            confirmation = self.client.post(
                f"/v1/sessions/s1/chat/{post_id}/decision",
                json={"agree": True},
                headers={"X-CourtMate-Player-ID": player_id},
            )
            self.assertEqual(confirmation.status_code, 200)
        self.assertEqual(confirmation.json()["result_status"], "confirmed")

        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertNotIn("pickleball", profile.json()["cmr_ratings"])

    def test_competitive_result_requires_a_non_zero_final_score(self):
        session = repository.get_session("s1").model_copy(update={"status": "completed", "rating_mode": "competitive"})
        repository.save_session(session)

        result = self.client.post(
            "/v1/sessions/s1/chat",
            json={
                "post_type": "match_result",
                "teams": [
                    {"name": "Pair A", "player_ids": ["p1", "p2"], "score": 0},
                    {"name": "Pair B", "player_ids": ["p3", "p6"], "score": 0},
                ],
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(result.status_code, 422)
        self.assertIn("valid final score", result.json()["detail"])

    def test_time_window_poll_finalizes_one_hour_slot_and_posts_booking_prompt(self):
        game_date = str(date.today() + timedelta(days=3))
        created = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a casual pickleball game near Whitefield",
                "group_name": "Flexible Evening Rally",
                "sport": "pickleball",
                "area": "Whitefield",
                "session_date": game_date,
                "time_window_start": "18:00",
                "time_window_end": "20:00",
                "duration_minutes": 60,
                "skill_min": 3.8,
                "skill_max": 4.2,
                "style": "casual",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        session_id = created.json()["session"]["id"]
        self.assertFalse(created.json()["session"]["time_finalized"])
        self.assertEqual(created.json()["session"]["start_time"], "18:00:00")
        self.assertEqual(created.json()["session"]["end_time"], "19:00:00")

        early_poll = self.client.post(f"/v1/sessions/{session_id}/time-poll", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(early_poll.status_code, 409)

        join = self.client.post(f"/v1/sessions/{session_id}/join", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(join.status_code, 200)
        approved = self.client.post(
            f"/v1/sessions/{session_id}/join-requests/{join.json()['id']}/decision",
            json={"status": "approved"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(approved.status_code, 200)

        poll = self.client.post(f"/v1/sessions/{session_id}/time-poll", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(poll.status_code, 200)
        poll_payload = poll.json()
        self.assertEqual(poll_payload["post_type"], "time_poll")
        self.assertEqual(poll_payload["player_id"], "p2")
        self.assertEqual([option["id"] for option in poll_payload["poll_options"]], ["1800", "1830", "1900"])
        poll_id = poll_payload["id"]

        first_vote = self.client.post(
            f"/v1/sessions/{session_id}/chat/{poll_id}/vote",
            json={"option_id": "1830"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(first_vote.status_code, 200)
        self.assertEqual(first_vote.json()["poll_status"], "open")
        final_vote = self.client.post(
            f"/v1/sessions/{session_id}/chat/{poll_id}/vote",
            json={"option_id": "1830"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(final_vote.status_code, 200)
        self.assertEqual(final_vote.json()["poll_status"], "resolved")

        finalized = repository.get_session(session_id)
        self.assertTrue(finalized.time_finalized)
        self.assertEqual(finalized.start_time, time(18, 30))
        self.assertEqual(finalized.end_time, time(19, 30))
        booking_posts = [post for post in repository.list_chat_posts(session_id) if "Please book the court" in post.message]
        self.assertEqual(len(booking_posts), 1)

        retry = self.client.post(
            f"/v1/sessions/{session_id}/chat/{poll_id}/vote",
            json={"option_id": "1900"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["poll_winner_id"], "1830")
        self.assertEqual(len([post for post in repository.list_chat_posts(session_id) if "Please book the court" in post.message]), 1)

    def test_time_window_must_fit_game_duration(self):
        response = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a casual tennis game near Whitefield",
                "sport": "tennis",
                "area": "Whitefield",
                "session_date": str(date.today() + timedelta(days=2)),
                "time_window_start": "18:00",
                "time_window_end": "18:30",
                "duration_minutes": 60,
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 422)

    def test_unrelated_chat_query_is_redirected_without_results(self):
        response = self.client.post("/v1/sessions/search", json={"query": "What is the weather near me?", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "out_of_scope")
        self.assertEqual(payload["recommendations"], [])
        self.assertIsNone(payload["group_proposal"])
        self.assertIn("find racket-sport", payload["message"])

    def test_general_question_is_redirected_without_random_session_results(self):
        response = self.client.post("/v1/sessions/search", json={"query": "What is the capital of France?", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "out_of_scope")
        self.assertEqual(payload["recommendations"], [])
        self.assertIsNone(payload["group_proposal"])

    def test_general_sports_question_returns_an_answer_without_game_results(self):
        response = self.client.post("/v1/sessions/search", json={"query": "What are the rules of tennis?", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "sports_general")
        self.assertEqual(payload["recommendations"], [])
        self.assertIn("racket", payload["message"])

    def test_venue_information_question_uses_general_assistant(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Tell me about pickleball venues near me", "player_id": "p1"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "sports_general")
        self.assertEqual(payload["recommendations"], [])
        self.assertIn("live availability", payload["message"])

    def test_where_to_play_question_uses_general_assistant(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Where can I play pickleball near me?", "player_id": "p1"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "sports_general")
        self.assertEqual(payload["recommendations"], [])
        self.assertIn("live availability", payload["message"])

    def test_court_information_question_uses_general_assistant(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Tell me about courts in Whitefield", "player_id": "p1"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "sports_general")
        self.assertEqual(payload["recommendations"], [])
        self.assertIn("Whitefield", payload["message"])

    def test_generic_padel_question_uses_general_assistant(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Tell me more about padel", "player_id": "p1"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "sports_general")
        self.assertEqual(payload["recommendations"], [])
        self.assertIn("doubles racket sport", payload["message"])

    def test_generic_court_question_is_not_routed_to_game_search(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "How do I book a tennis court?", "player_id": "p1"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "sports_general")
        self.assertEqual(payload["recommendations"], [])
        self.assertIn("book a tennis court", payload["message"].lower())

    def test_social_feed_supports_individual_game_posts_likes_comments_and_shares(self):
        self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.submit_feedback_for_everyone()
        created = self.client.post(
            "/v1/social/posts",
            json={
                "caption": "Great Sunday rally with a really fun group.",
                "sport": "pickleball",
                "session_id": "s1",
                "media_urls": ["https://storage.googleapis.com/example/one.jpg", "https://storage.googleapis.com/example/two.jpg"],
                "media_type": "image",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        post_id = created.json()["id"]
        self.assertEqual(created.json()["session_name"], "Sunday Rally Crew")
        self.assertEqual(created.json()["media_urls"], ["https://storage.googleapis.com/example/one.jpg", "https://storage.googleapis.com/example/two.jpg"])

        feed = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.status_code, 200)
        self.assertTrue(any(post["id"] == post_id for post in feed.json()["posts"]))

        liked = self.client.post(f"/v1/social/posts/{post_id}/like", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertTrue(liked.json()["liked_by_me"])
        self.assertEqual(liked.json()["like_count"], 1)

        comment = self.client.post(
            f"/v1/social/posts/{post_id}/comments",
            json={"message": "That game was a blast."},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(comment.status_code, 200)
        self.assertEqual(comment.json()["player_display_name"], "Kavya")

        shared = self.client.post(f"/v1/social/posts/{post_id}/share", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(shared.json()["share_count"], 1)
        comments = self.client.get(f"/v1/social/posts/{post_id}/comments", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(len(comments.json()["comments"]), 1)

    def test_confirmed_player_can_post_without_completing_a_game(self):
        created = self.client.post(
            "/v1/social/posts",
            json={"caption": "Sharing a quick in-game update.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )

        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["player_id"], "p2")
        self.assertEqual(created.json()["session_id"], "s1")

    def test_confirmed_player_can_publish_a_photo_without_a_caption(self):
        created = self.client.post(
            "/v1/social/posts",
            json={
                "sport": "pickleball",
                "session_id": "s1",
                "media_urls": ["https://storage.googleapis.com/example/game-photo.jpg"],
                "media_type": "image",
            },
            headers={"X-CourtMate-Player-ID": "p2"},
        )

        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["caption"], "Shared a CourtMate game moment.")
        self.assertEqual(created.json()["media_urls"], ["https://storage.googleapis.com/example/game-photo.jpg"])

    def test_only_the_post_owner_can_delete_a_social_post(self):
        created = self.client.post(
            "/v1/social/posts",
            json={"caption": "A post I may remove.", "sport": "pickleball"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        post_id = created.json()["id"]

        forbidden = self.client.delete(f"/v1/social/posts/{post_id}", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(forbidden.status_code, 404)
        self.assertIsNotNone(repository.get_social_post(post_id))

        deleted = self.client.delete(f"/v1/social/posts/{post_id}", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json(), {"deleted": True})
        self.assertIsNone(repository.get_social_post(post_id))

    def test_social_post_server_error_keeps_cors_headers(self):
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(repository, "save_social_post", side_effect=RuntimeError("storage unavailable")):
            response = client.post(
                "/v1/social/posts",
                json={"caption": "CORS error handling check", "sport": "pickleball"},
                headers={"Origin": "http://localhost:3000"},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers["access-control-allow-origin"], "http://localhost:3000")

    def test_social_post_rejects_oversized_inline_media_before_writing(self):
        oversized_photo = "data:image/webp;base64," + ("a" * (121 * 1024))
        response = self.client.post(
            "/v1/social/posts",
            json={
                "caption": "This photo should be rejected before Firestore sees it.",
                "sport": "pickleball",
                "session_id": "s1",
                "media_urls": [oversized_photo],
                "media_type": "image",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("too large", response.json()["detail"].lower())

    def test_social_post_clamps_legacy_cmr_before_building_the_feed_card(self):
        self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.submit_feedback_for_everyone()
        player = repository.get_player("p1")
        repository.save_player(player.model_copy(update={"cmr_ratings": {"pickleball": 100}, "cmr_scale": 10}))

        response = self.client.post(
            "/v1/social/posts",
            json={"caption": "A post with an older rating record.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(all(entry["cmr_rating"] is None or entry["cmr_rating"] <= 10 for entry in response.json()["session_leaderboard"]))

    def test_personal_rally_contains_only_the_players_own_posts(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(completed.status_code, 200)
        self.submit_feedback_for_everyone()
        created = self.client.post(
            "/v1/social/posts",
            json={"caption": "My own view of a great rally.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(created.status_code, 200)

        feed = self.client.get("/v1/social/feed?feed=personal", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.status_code, 200)
        posts = feed.json()["posts"]
        self.assertEqual([post["id"] for post in posts], [created.json()["id"]])
        self.assertTrue(all(post["player_id"] == "p2" and post["activity_type"] == "post" for post in posts))

    def test_following_feed_excludes_my_own_posts(self):
        self.client.post(
            "/v1/social/posts",
            json={"caption": "My own post", "sport": "pickleball"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        other_post = self.client.post(
            "/v1/social/posts",
            json={"caption": "A followed player's post", "sport": "pickleball"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        repository.save_follow(FollowRecord(
            id="p1_p2_accepted",
            follower_id="p1",
            following_id="p2",
            status="accepted",
            created_at=datetime.now(local_timezone),
        ))

        feed = self.client.get("/v1/social/feed?feed=following", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(feed.status_code, 200)
        self.assertEqual([post["id"] for post in feed.json()["posts"]], [other_post.json()["id"]])

    def test_completed_game_is_not_posted_until_a_player_chooses_to_share(self):
        repository.save_session(
            Session(
                id="elapsed-rally",
                sport="tennis",
                group_name="Elapsed Tennis Rally",
                organizer_id="p1",
                area="Whitefield",
                session_date=date.today() - timedelta(days=1),
                start_time=time(8),
                end_time=time(10),
                skill_min=3.0,
                skill_max=4.0,
                style="casual",
                capacity=4,
                confirmed_player_ids=["p1", "p2"],
            )
        )

        self.client.post("/v1/sessions/elapsed-rally/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.submit_feedback_for_everyone("elapsed-rally")

        feed = self.client.get("/v1/social/feed?feed=personal", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.status_code, 200)
        self.assertEqual(feed.json()["posts"], [])
        self.assertFalse(repository.get_session("elapsed-rally").social_activity_published)

    def test_individual_game_post_supports_likes_comments_and_shares(self):
        retired = self.client.post("/v1/sessions/s1/social-activity", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(retired.status_code, 410)

        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(completed.status_code, 200)
        self.submit_feedback_for_everyone()
        created = self.client.post(
            "/v1/social/posts",
            json={"caption": "A tough but satisfying game.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        post_id = created.json()["id"]
        comment = self.client.post(
            f"/v1/social/posts/{post_id}/comments",
            json={"message": "Great rally."},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(comment.status_code, 200)

        liked = self.client.post(f"/v1/social/posts/{post_id}/like", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(liked.status_code, 200)
        self.assertTrue(liked.json()["liked_by_me"])
        self.assertEqual(liked.json()["like_count"], 1)
        self.assertEqual(liked.json()["comment_count"], 1)

        shared = self.client.post(f"/v1/social/posts/{post_id}/share", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(shared.status_code, 200)
        self.assertEqual(shared.json()["share_count"], 1)

    def test_completed_game_never_auto_publishes_and_each_player_controls_their_post(self):
        session = repository.get_session("s1")
        session.social_activity_published = False
        repository.save_session(session)
        before = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertFalse(any(post["id"] == "session-activity-s1" for post in before.json()["posts"]))

        completed = self.client.post(
            "/v1/sessions/s1/complete",
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertFalse(completed.json()["social_activity_published"])
        self.submit_feedback_for_everyone()

        feed = self.client.get("/v1/social/feed?feed=personal", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.json()["posts"], [])
        first_post = self.client.post(
            "/v1/social/posts",
            json={"caption": "My version of the rally.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(first_post.status_code, 200)
        second_post = self.client.post(
            "/v1/social/posts",
            json={"caption": "A different memory from the same game.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(second_post.status_code, 200)
        personal = self.client.get("/v1/social/feed?feed=personal", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual([post["id"] for post in personal.json()["posts"]], [second_post.json()["id"]])

    def test_marking_a_game_done_only_opens_feedback_for_that_player(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "open")
        self.assertEqual(completed.json()["completed_player_ids"], ["p2"])
        self.assertEqual(repository.get_session("s1").status, "open")

        repeated_request = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(repeated_request.status_code, 200)
        self.assertEqual(repeated_request.json()["completed_player_ids"], ["p2"])
        completer_activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p2"}).json()
        self.assertIn("s1", {item["id"] for item in completer_activity["awaiting_feedback"]})
        other_activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"}).json()
        self.assertIn("s1", {item["id"] for item in other_activity["games"]})

    def test_submitted_feedback_is_removed_from_that_players_awaiting_list(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(completed.status_code, 200)

        before = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertIn("s1", [session["id"] for session in before.json()["awaiting_feedback"]])

        submitted = self.client.post(
            "/v1/sessions/s1/feedback",
            json={"fun": 5, "fairness": 5, "would_return": True, "ratings": [
                {"player_id": "p1", "rating_10": 8},
                {"player_id": "p3", "rating_10": 7},
                {"player_id": "p6", "rating_10": 6},
            ]},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(submitted.status_code, 200)

        after = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertNotIn("s1", [session["id"] for session in after.json()["awaiting_feedback"]])

    def test_feedback_requires_a_game_to_be_marked_done(self):
        response = self.client.post(
            "/v1/sessions/s1/feedback",
            json={"fun": 5, "fairness": 5, "would_return": True, "ratings": [{"player_id": "p1", "rating_10": 8}, {"player_id": "p3", "rating_10": 7}, {"player_id": "p6", "rating_10": 6}]},
            headers={"X-CourtMate-Player-ID": "p2"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("marked done", response.json()["detail"])

    def test_feedback_builds_sport_specific_cmr(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(completed.status_code, 200)

        feedback = self.client.post(
            "/v1/sessions/s1/feedback",
            json={
                "fun": 5,
                "fairness": 5,
                "would_return": True,
                "session_note": "Good rallies and an evenly matched session.",
                "ratings": [
                    {"player_id": "p1", "rating_10": 10},
                    {"player_id": "p3", "rating_10": 7},
                    {"player_id": "p6", "rating_10": 4},
                ],
            },
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(feedback.status_code, 200)
        self.assertEqual(feedback.json()["ratings"][0]["rating_10"], 10)
        self.assertEqual(feedback.json()["session_note"], "Good rallies and an evenly matched session.")
        self.submit_feedback_for_everyone()

        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertIn("pickleball", profile.json()["cmr_ratings"])
        self.assertEqual(profile.json()["cmr_game_counts"]["pickleball"], 1)
        self.assertGreater(profile.json()["cmr_confidence"]["pickleball"], 0)

    def test_feedback_resubmission_replaces_the_cmr_input(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(completed.status_code, 200)
        first = self.client.post(
            "/v1/sessions/s1/feedback",
            json={
                "fun": 5,
                "fairness": 5,
                "would_return": True,
                "ratings": [
                    {"player_id": "p1", "rating_10": 10},
                    {"player_id": "p3", "rating_10": 7},
                    {"player_id": "p6", "rating_10": 5},
                ],
            },
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(first.status_code, 200)
        replacement = self.client.post(
            "/v1/sessions/s1/feedback",
            json={
                "fun": 4,
                "fairness": 4,
                "would_return": True,
                "ratings": [
                    {"player_id": "p1", "rating_10": 1},
                    {"player_id": "p3", "rating_10": 7},
                    {"player_id": "p6", "rating_10": 5},
                ],
            },
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(replacement.status_code, 200)
        self.assertEqual(len(repository.list_feedback("s1")), 1)
        self.submit_feedback_for_everyone()

        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertIn("pickleball", profile.json()["cmr_ratings"])
        self.assertEqual(profile.json()["cmr_game_counts"]["pickleball"], 1)

    def test_private_feedback_requires_one_rating_for_each_other_player(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(completed.status_code, 200)
        incomplete = self.client.post(
            "/v1/sessions/s1/feedback",
            json={
                "fun": 5,
                "fairness": 5,
                "would_return": True,
                "ratings": [{"player_id": "p1", "rating_10": 8}],
            },
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(incomplete.status_code, 422)
        self.assertIn("every other confirmed player", incomplete.json()["detail"])

    def test_social_feed_reuses_a_short_lived_player_scoped_cache(self):
        from unittest.mock import patch

        with patch.object(repository, "list_sessions", wraps=repository.list_sessions) as list_sessions:
            first = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
            second = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(list_sessions.call_count, 1)

    def test_social_post_cannot_tag_a_game_the_player_did_not_play(self):
        response = self.client.post(
            "/v1/social/posts",
            json={"caption": "Posting someone else's game", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p5"},
        )
        self.assertEqual(response.status_code, 403)

    def test_social_media_requires_a_game_the_player_can_access(self):
        response = self.client.post(
            "/v1/social/posts",
            json={"caption": "Unattached photo", "sport": "pickleball", "media_url": "https://storage.googleapis.com/example/photo.jpg", "media_type": "image"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 422)

    def test_exact_search_filters_requested_game_style(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find a social game near Whitefield", "mode": "exact"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual({item["session"]["id"] for item in response.json()["recommendations"]}, {"s2"})

    def test_game_creation_notifies_compatible_nearby_players(self):
        response = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a casual pickleball game near Whitefield",
                "area": "Whitefield",
                "session_date": str(date.today() + timedelta(days=2)),
                "start_time": "19:00",
                "end_time": "21:00",
                "skill_min": 3.8,
                "skill_max": 4.2,
                "style": "casual",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        session_id = response.json()["session"]["id"]

        notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(notifications.status_code, 200)
        item = next(item for item in notifications.json()["notifications"] if item["session_id"] == session_id)
        self.assertFalse(item["read"])

        read = self.client.post(f"/v1/me/notifications/{item['id']}/read", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(read.status_code, 200)
        self.assertTrue(read.json()["read"])

    def test_upcoming_game_reminder_reaches_confirmed_players_once(self):
        upcoming_start = datetime.now() + timedelta(minutes=30)
        session = Session(
            id="reminder-session",
            group_name="Reminder Rally",
            organizer_id="p1",
            area="Whitefield",
            session_date=upcoming_start.date(),
            start_time=upcoming_start.time().replace(second=0, microsecond=0),
            end_time=(upcoming_start + timedelta(minutes=90)).time().replace(second=0, microsecond=0),
            skill_min=1.0,
            skill_max=8.0,
            style="casual",
            capacity=2,
            confirmed_player_ids=["p1", "p2"],
            status="full",
            sport="tennis",
        )
        repository.save_session(session)

        for player_id in session.confirmed_player_ids:
            response = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": player_id})
            self.assertEqual(response.status_code, 200)
            reminders = [item for item in response.json()["notifications"] if item["kind"] == "game_reminder"]
            self.assertEqual(len(reminders), 1)
            self.assertEqual(reminders[0]["session_id"], session.id)
            self.assertIn("book the court", reminders[0]["message"].lower())

            repeated = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": player_id})
            repeated_reminders = [item for item in repeated.json()["notifications"] if item["kind"] == "game_reminder"]
            self.assertEqual(len(repeated_reminders), 1)

    def test_group_view_returns_public_member_profiles(self):
        response = self.client.get("/v1/sessions/s1/group")
        self.assertEqual(response.status_code, 200)
        members = response.json()["members"]
        self.assertEqual({member["id"] for member in members}, {"p1", "p2", "p3", "p6"})
        self.assertEqual(members[0]["dupr_rating"], 3.2)
        self.assertNotIn("friends", members[0])

    def test_players_can_view_profiles_and_follow_each_other(self):
        profile = self.client.get("/v1/players/p2", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(profile.status_code, 200)
        self.assertFalse(profile.json()["is_following"])
        self.assertEqual(profile.json()["followers_count"], 0)

        followed = self.client.post("/v1/players/p2/follow", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(followed.status_code, 200)
        self.assertFalse(followed.json()["is_following"])
        self.assertTrue(followed.json()["follow_request_pending"])
        self.assertEqual(followed.json()["followers_count"], 0)
        follow_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})
        follow_notification = next(item for item in follow_notifications.json()["notifications"] if item["kind"] == "follow" and item["actor_id"] == "p1")
        self.assertFalse(follow_notification["read"])
        accepted = self.client.post(f"/v1/me/follow-requests/{follow_notification['id']}", json={"status": "approved"}, headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(accepted.status_code, 200)
        accepted_profile = self.client.get("/v1/players/p2", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertTrue(accepted_profile.json()["is_following"])

        following = self.client.get("/v1/me/following", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(following.status_code, 200)
        self.assertEqual([item["id"] for item in following.json()["profiles"]], ["p2"])

        self.client.post("/v1/players/p1/follow", headers={"X-CourtMate-Player-ID": "p2"})
        as_target = self.client.get("/v1/players/p1", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(as_target.status_code, 200)
        p1_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p1"}).json()["notifications"]
        reciprocal_notification = next(item for item in p1_notifications if item["kind"] == "follow" and item["actor_id"] == "p2")
        self.client.post(f"/v1/me/follow-requests/{reciprocal_notification['id']}", json={"status": "approved"}, headers={"X-CourtMate-Player-ID": "p1"})
        as_target = self.client.get("/v1/players/p1", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertTrue(as_target.json()["follows_you"])

        unfollowed = self.client.post("/v1/players/p2/unfollow", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(unfollowed.status_code, 200)
        self.assertFalse(unfollowed.json()["is_following"])
        self.assertEqual(unfollowed.json()["followers_count"], 0)

    def test_notification_poll_repairs_a_missing_follow_notification(self):
        repository.save_follow(FollowRecord(
            id="p1_p2",
            follower_id="p1",
            following_id="p2",
            status="pending",
            created_at=datetime.now(),
        ))

        response = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})

        self.assertEqual(response.status_code, 200)
        notifications = response.json()["notifications"]
        self.assertTrue(any(item["id"] == "follow-p1-p2" and not item["read"] for item in notifications))

    def test_follow_notification_failure_does_not_leave_a_stuck_request(self):
        with patch.object(repository, "save_notification", side_effect=RuntimeError("write failed")):
            response = self.client.post("/v1/players/p2/follow", headers={"X-CourtMate-Player-ID": "p1"})

        self.assertEqual(response.status_code, 503)
        self.assertFalse(repository.is_follow_request_pending("p1", "p2"))

    def test_circle_leaderboard_supports_connection_locality_and_bengaluru_scopes(self):
        repository.save_follow(FollowRecord(id="p1_p4", follower_id="p1", following_id="p4", status="accepted", created_at=datetime.now()))
        repository.save_follow(FollowRecord(id="p2_p1", follower_id="p2", following_id="p1", status="accepted", created_at=datetime.now()))
        private_player = repository.get_player("p3")
        repository.save_player(private_player.model_copy(update={"is_profile_private": True}))

        circle = self.client.get("/v1/me/circle-leaderboard?scope=circle&sport=pickleball", headers={"X-CourtMate-Player-ID": "p1"})
        locality = self.client.get("/v1/me/circle-leaderboard?scope=locality&sport=pickleball", headers={"X-CourtMate-Player-ID": "p1"})
        city = self.client.get("/v1/me/circle-leaderboard?scope=bengaluru&sport=pickleball", headers={"X-CourtMate-Player-ID": "p1"})

        self.assertEqual(circle.status_code, 200)
        self.assertEqual({entry["player"]["id"] for entry in circle.json()["entries"]}, {"p1", "p2", "p4"})
        self.assertTrue(all(entry["player"]["area"] == "Whitefield" for entry in locality.json()["entries"]))
        self.assertNotIn("p3", {entry["player"]["id"] for entry in locality.json()["entries"]})
        self.assertIn("p4", {entry["player"]["id"] for entry in city.json()["entries"]})
        self.assertNotIn("p3", {entry["player"]["id"] for entry in city.json()["entries"]})

    def test_circle_leaderboard_filters_cmr_history_by_period(self):
        today = date.today()
        p1 = repository.get_player("p1")
        p2 = repository.get_player("p2")
        repository.save_player(p1.model_copy(update={"cmr_history": {"pickleball": [
            CMRHistoryPoint(session_id="recent-1", session_date=today, group_name="Recent rally", rating=6.2),
        ]}}))
        repository.save_player(p2.model_copy(update={"cmr_history": {"pickleball": [
            CMRHistoryPoint(session_id="old-1", session_date=today - timedelta(days=40), group_name="Old rally", rating=7.8),
        ]}}))

        response = self.client.get(
            "/v1/me/circle-leaderboard?scope=bengaluru&sport=pickleball&period=30_days",
            headers={"X-CourtMate-Player-ID": "p1"},
        )

        self.assertEqual(response.status_code, 200)
        entries = response.json()["entries"]
        self.assertEqual([entry["player"]["id"] for entry in entries], ["p1"])
        self.assertEqual(entries[0]["score"], 6.2)
        self.assertEqual(entries[0]["ratings_count"], 1)

    def test_circle_leaderboard_ranks_completed_sessions_across_sports(self):
        today = date.today()
        for session_id, sport, played_on, player_ids in [
            ("activity-1", "pickleball", today - timedelta(days=2), ["p1", "p2"]),
            ("activity-2", "badminton", today - timedelta(days=10), ["p1"]),
            ("activity-old", "tennis", today - timedelta(days=45), ["p2"]),
        ]:
            repository.save_session(Session(
                id=session_id,
                sport=sport,
                group_name=f"{sport.title()} session",
                organizer_id=player_ids[0],
                area="Whitefield",
                session_date=played_on,
                start_time=time(18),
                end_time=time(20),
                skill_min=3.0,
                skill_max=4.0,
                style="casual",
                capacity=8,
                confirmed_player_ids=player_ids,
                status="completed",
            ))

        response = self.client.get(
            "/v1/me/circle-leaderboard?scope=bengaluru&metric=sessions&period=30_days",
            headers={"X-CourtMate-Player-ID": "p1"},
        )

        self.assertEqual(response.status_code, 200)
        entries = response.json()["entries"]
        self.assertEqual([entry["player"]["id"] for entry in entries[:2]], ["p1", "p2"])
        self.assertEqual([entry["score"] for entry in entries[:2]], [2.0, 1.0])

        badminton = self.client.get(
            "/v1/me/circle-leaderboard?scope=bengaluru&metric=sessions&session_sport=badminton&period=30_days",
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(badminton.status_code, 200)
        self.assertEqual([entry["player"]["id"] for entry in badminton.json()["entries"]], ["p1"])
        self.assertEqual(badminton.json()["entries"][0]["score"], 1.0)

    def test_public_profile_exposes_recent_games_and_activity_heatmap(self):
        played_on = date.today() - timedelta(days=3)
        repository.save_session(
            Session(
                id="profile-activity-game",
                sport="pickleball",
                group_name="Wednesday Rally",
                organizer_id="p1",
                area="Whitefield",
                session_date=played_on,
                start_time=time(19),
                end_time=time(21),
                skill_min=3.0,
                skill_max=3.6,
                style="casual",
                capacity=8,
                confirmed_player_ids=["p2"],
                status="completed",
            )
        )
        response = self.client.get("/v1/players/p2", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["recent_games"][0]["group_name"], "Wednesday Rally")
        self.assertEqual(payload["activity_by_date"][played_on.isoformat()], 1)

    def test_public_profile_exposes_all_completed_game_sessions(self):
        for index in range(8):
            repository.save_session(
                Session(
                    id=f"profile-history-{index}",
                    sport="badminton",
                    group_name=f"Community Rally {index}",
                    organizer_id="p1",
                    area="Whitefield",
                    session_date=date.today() - timedelta(days=index + 1),
                    start_time=time(19),
                    end_time=time(21),
                    skill_min=3.0,
                    skill_max=6.0,
                    style="casual",
                    capacity=8,
                    confirmed_player_ids=["p2"],
                    status="completed",
                )
            )

        response = self.client.get("/v1/players/p2", headers={"X-CourtMate-Player-ID": "p1"})
        history_ids = {game["id"] for game in response.json()["recent_games"]}

        self.assertEqual(response.status_code, 200)
        self.assertTrue({f"profile-history-{index}" for index in range(8)}.issubset(history_ids))

    def test_public_profile_calculates_active_weekly_streak_from_completed_games(self):
        current_week = date.today() - timedelta(days=date.today().weekday())
        for index in range(3):
            repository.save_session(
                Session(
                    id=f"weekly-streak-{index}",
                    sport="pickleball",
                    group_name=f"Weekly Rally {index}",
                    organizer_id="p1",
                    area="Whitefield",
                    session_date=current_week - timedelta(days=index * 7),
                    start_time=time(19),
                    end_time=time(21),
                    skill_min=3.0,
                    skill_max=3.6,
                    style="casual",
                    capacity=8,
                    confirmed_player_ids=["p2"],
                    status="completed",
                )
            )

        response = self.client.get("/v1/players/p2", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["weekly_streak"], 3)
        self.assertTrue(response.json()["weekly_streak_active"])

    def test_profile_image_url_is_persisted_and_exposed_publicly(self):
        image_url = "https://firebasestorage.googleapis.com/v0/b/mttn-portal.firebasestorage.app/o/profile-images%2Fp2%2Fphoto.jpg?alt=media&token=test"
        response = self.client.post(
            "/v1/me/profile-image",
            json={"profile_image_url": image_url},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["profile_image_url"], image_url)

        public_profile = self.client.get("/v1/players/p2", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(public_profile.status_code, 200)
        self.assertEqual(public_profile.json()["profile_image_url"], image_url)

        rejected = self.client.post(
            "/v1/me/profile-image",
            json={"profile_image_url": "https://example.com/profile.jpg"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(rejected.status_code, 422)

        removed = self.client.post(
            "/v1/me/profile-image",
            json={"profile_image_url": None},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(removed.status_code, 200)
        self.assertIsNone(removed.json()["profile_image_url"])

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

    def test_activity_proof_requires_cloud_storage_and_gemini(self):
        repository.save_session(
            Session(
                id="activity-proof-game",
                sport="pickleball",
                group_name="Tracker Test Rally",
                organizer_id="p1",
                area="Whitefield",
                session_date=date.today(),
                start_time=time(8),
                end_time=time(10),
                skill_min=3.0,
                skill_max=3.6,
                style="casual",
                capacity=8,
                confirmed_player_ids=["p1"],
                status="completed",
            )
        )
        external = self.client.post(
            "/v1/sessions/activity-proof-game/activity-proof/analyze",
            json={"image_url": "https://example.com/tracker.jpg"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(external.status_code, 422)

        storage_url = "https://firebasestorage.googleapis.com/v0/b/mttn-portal.firebasestorage.app/o/activity-proofs%2Fp1%2Factivity-proof-game%2Ftracker.jpg?alt=media&token=test"
        not_configured = self.client.post(
            "/v1/sessions/activity-proof-game/activity-proof/analyze",
            json={"image_url": storage_url},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(not_configured.status_code, 503)

    def test_profile_stores_skill_level_without_a_numeric_rating(self):
        response = self.client.post(
            "/v1/me/profile",
            json={"sport": "pickleball", "skill_level": "beginner"},
            headers={"X-CourtMate-Player-ID": "level-profile-player"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["skill_levels"]["pickleball"], "beginner")
        self.assertEqual(payload["self_assessed_levels"]["pickleball"], 2)
        self.assertEqual(payload["cmr_ratings"]["pickleball"], 2.0)
        self.assertNotIn("skill_rating", payload)

    def test_profile_stores_confirmed_ten_point_starting_level(self):
        response = self.client.post(
            "/v1/me/profile",
            json={"sport": "tennis", "primary_sport": "tennis", "self_assessed_level": 6},
            headers={"X-CourtMate-Player-ID": "ten-point-profile-player"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["primary_sport"], "tennis")
        self.assertEqual(payload["self_assessed_levels"]["tennis"], 6)
        self.assertEqual(payload["cmr_starting_ratings"]["tennis"], 6.0)
        self.assertEqual(payload["cmr_ratings"]["tennis"], 6.0)
        self.assertEqual(payload["cmr_scale"], 10)

    def test_profile_and_search_are_sport_aware(self):
        profile = self.client.post(
            "/v1/me/profile",
            json={"sport": "badminton", "skill_rating": 3.8},
            headers={"X-CourtMate-Player-ID": "sport-profile-player"},
        )
        self.assertEqual(profile.status_code, 200)
        self.assertEqual(profile.json()["sport_ratings"]["badminton"], 3.8)
        self.assertEqual(profile.json()["cmr_ratings"]["badminton"], 4.6)

        search = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find a badminton game near Whitefield this evening", "sport": "badminton"},
            headers={"X-CourtMate-Player-ID": "sport-profile-player"},
        )
        self.assertEqual(search.status_code, 200)
        self.assertTrue(search.json()["recommendations"])
        self.assertTrue(all(item["session"]["sport"] == "badminton" for item in search.json()["recommendations"]))

    def test_incoming_requests_aggregate_for_group_organizer(self):
        join = self.client.post("/v1/sessions/s1/join", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertEqual(join.status_code, 200)
        incoming = self.client.get("/v1/me/incoming-requests", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(incoming.status_code, 200)
        request_views = incoming.json()["requests"]
        self.assertTrue(any(item["request"]["id"] == join.json()["id"] and item["session"]["id"] == "s1" for item in request_views))

    def test_activity_snapshot_populates_every_games_tab_and_updates_after_join(self):
        initial = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertEqual(initial.status_code, 200)
        self.assertIn("X-Response-Time-Ms", initial.headers)
        self.assertEqual(set(initial.json()), {"requests", "incoming_requests", "groups", "games", "awaiting_feedback", "past_games"})

        join = self.client.post("/v1/sessions/s1/join", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertEqual(join.status_code, 200)

        requester_activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertTrue(any(item["request"]["id"] == join.json()["id"] for item in requester_activity.json()["requests"]))
        organizer_activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertTrue(any(item["request"]["id"] == join.json()["id"] for item in organizer_activity.json()["incoming_requests"]))

    def test_showcase_seed_supports_primary_demo_journeys(self):
        summary = seed(store=repository)
        _clear_read_view_cache()
        _clear_social_feed_cache()
        headers = {"X-CourtMate-Player-ID": "showcase-visitor"}

        self.assertGreaterEqual(summary["players"], 30)
        self.assertGreaterEqual(summary["sessions"], 30)
        self.assertLessEqual(summary["sessions"], 100)
        self.assertGreaterEqual(summary["social_posts"], 6)
        self.assertTrue(all(not player.profile_image_url for player in repository.list_players() if player.id.startswith("demo-")))

        profile = self.client.get("/v1/me", headers=headers)
        explore = self.client.get("/v1/me/explore", headers=headers)
        feed = self.client.get("/v1/social/feed", headers=headers)
        recommended = self.client.get("/v1/players/recommended", headers=headers)
        leaderboard = self.client.get(
            "/v1/me/circle-leaderboard?scope=bengaluru&sport=badminton",
            headers=headers,
        )

        self.assertEqual(profile.status_code, 200)
        self.assertEqual(explore.status_code, 200)
        self.assertEqual(feed.status_code, 200)
        self.assertEqual(recommended.status_code, 200)
        self.assertEqual(leaderboard.status_code, 200)
        self.assertTrue(explore.json()["recommendations"])
        self.assertGreaterEqual(len(feed.json()["posts"]), 6)
        self.assertTrue(recommended.json()["profiles"])
        self.assertTrue(leaderboard.json()["entries"])

        session = next(
            item["session"]
            for item in explore.json()["recommendations"]
            if item["session"]["status"] == "open"
        )
        join = self.client.post(f"/v1/sessions/{session['id']}/join", headers=headers)
        self.assertEqual(join.status_code, 200)
        self.assertEqual(join.json()["status"], "pending")
        activity = self.client.get("/v1/me/activity", headers=headers)
        self.assertTrue(any(item["request"]["id"] == join.json()["id"] for item in activity.json()["requests"]))

    def test_join_accepts_browser_post_without_a_json_body(self):
        join = self.client.post(
            "/v1/sessions/s1/join",
            content=b"",
            headers={"X-CourtMate-Player-ID": "p4", "Content-Type": "application/json"},
        )

        self.assertEqual(join.status_code, 200)
        self.assertEqual(join.json()["status"], "pending")
        self.assertTrue(any(
            request.id == join.json()["id"]
            for request in repository.list_join_requests_for_player("p4")
        ))

        repeated = self.client.post(
            "/v1/sessions/s1/join",
            headers={"X-CourtMate-Player-ID": "p4"},
        )
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["id"], join.json()["id"])
        self.assertEqual(len(repository.list_join_requests_for_player("p4")), 1)

    def test_created_group_appears_in_the_organizers_upcoming_activity(self):
        created = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a casual tennis game near Whitefield this weekend",
                "group_name": "Whitefield CMR Rally",
                "sport": "tennis",
                "area": "Whitefield",
                "session_date": str(date.today() + timedelta(days=2)),
                "start_time": "19:00",
                "end_time": "21:00",
                "skill_min": 2.5,
                "skill_max": 5.0,
                "style": "casual",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["session"]["rating_mode"], "casual")
        self.assertIsNotNone(created.json()["session"]["created_at"])

        activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(activity.status_code, 200)
        group_id = created.json()["session"]["id"]
        self.assertTrue(any(group["id"] == group_id for group in activity.json()["groups"]))
        self.assertTrue(any(game["id"] == group_id for game in activity.json()["games"]))

    def test_activity_snapshot_reuses_reads_until_a_successful_write_invalidates_them(self):
        from unittest.mock import patch

        with patch.object(repository, "list_sessions", wraps=repository.list_sessions) as list_sessions:
            first = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})
            first_read_count = list_sessions.call_count
            second = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertGreater(first_read_count, 0)
        self.assertEqual(list_sessions.call_count, first_read_count)

        updated = self.client.post("/v1/me/profile", json={"bio": "Ready for a rally."}, headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(updated.status_code, 200)
        with patch.object(repository, "list_sessions", wraps=repository.list_sessions) as list_sessions:
            refreshed = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(refreshed.status_code, 200)
        self.assertGreater(list_sessions.call_count, 0)

    def test_player_can_withdraw_a_pending_request(self):
        join = self.client.post("/v1/sessions/s1/join", headers={"X-CourtMate-Player-ID": "p5"})
        self.assertEqual(join.status_code, 200)
        self.assertEqual(join.json()["status"], "pending")

        withdrawn = self.client.post(
            f"/v1/me/requests/{join.json()['id']}/withdraw",
            headers={"X-CourtMate-Player-ID": "p5"},
        )
        self.assertEqual(withdrawn.status_code, 200)
        self.assertEqual(withdrawn.json()["status"], "withdrawn")
        self.assertEqual(repository.list_join_requests_for_player("p5")[0].status, "withdrawn")

        pending = self.client.get("/v1/me/requests", headers={"X-CourtMate-Player-ID": "p5"})
        self.assertEqual(pending.status_code, 200)
        self.assertEqual([item for item in pending.json()["requests"] if item["request"]["status"] in {"pending", "waitlisted"}], [])

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
        self.assertEqual(repository.get_session(session_id).status, "awaiting_feedback")

        activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(activity.status_code, 200)
        self.assertIn(session_id, {item["id"] for item in activity.json()["awaiting_feedback"]})

        chat = self.client.post(f"/v1/sessions/{session_id}/chat", json={"message": "Can we still join?"}, headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(chat.status_code, 200)

    def test_no_match_proposes_group_and_join_request_is_explicit(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find an advanced game near Indiranagar this Sunday evening", "player_id": "p1"})
        self.assertEqual(response.json()["action"], "create_group")
        created = self.client.post("/v1/groups", json={"query": "Find an advanced game near Indiranagar this Sunday evening", "player_id": "p1"})
        self.assertEqual(created.status_code, 200)
        session_id = created.json()["session"]["id"]
        join = self.client.post(f"/v1/sessions/{session_id}/join", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(join.status_code, 200)
        self.assertEqual(join.json()["status"], "pending")
        organizer_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p1"})
        request_notification = next(item for item in organizer_notifications.json()["notifications"] if item["kind"] == "join_request")
        self.assertEqual(request_notification["request_id"], join.json()["id"])

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
        requester_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertTrue(any(item["kind"] == "request_update" and item["request_id"] == join.json()["id"] for item in requester_notifications.json()["notifications"]))

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

        complete = self.client.post(f"/v1/sessions/{session_id}/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(complete.status_code, 200)
        self.assertEqual(complete.json()["status"], "open")
        complete = self.client.post(f"/v1/sessions/{session_id}/complete", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(complete.status_code, 200)
        self.assertEqual(complete.json()["status"], "awaiting_feedback")

        feedback = self.client.post(
            f"/v1/sessions/{session_id}/feedback",
            json={
                "fun": 5,
                "fairness": 5,
                "would_return": True,
                "ratings": [{"player_id": "p1", "skill_level": "advanced", "comment": "Great organizer"}],
                "teams": [
                    {"name": "Team 1", "player_ids": ["p1"], "score": 11},
                    {"name": "Team 2", "player_ids": ["p2"], "score": 8},
                ],
            },
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(feedback.status_code, 200)
        self.assertEqual(feedback.json()["teams"][0]["player_ids"], ["p1"])
        self.assertEqual(feedback.json()["teams"][0]["score"], 11)
        final_feedback = self.client.post(
            f"/v1/sessions/{session_id}/feedback",
            json={"fun": 5, "fairness": 5, "would_return": True, "ratings": [{"player_id": "p2", "rating_10": 7}]},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(final_feedback.status_code, 200)
        leaderboard = self.client.get(f"/v1/sessions/{session_id}/leaderboard", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(leaderboard.status_code, 200)
        p1_entry = next(entry for entry in leaderboard.json()["entries"] if entry["player"]["id"] == "p1")
        self.assertGreater(p1_entry["score"], 4.0)
        self.assertEqual(p1_entry["ratings_count"], 1)
        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(profile.status_code, 200)
        history = profile.json()["cmr_history"].get("pickleball", [])
        self.assertTrue(any(point["session_id"] == session_id for point in history))

        waitlist = self.client.post("/v1/sessions/s7/join", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertEqual(waitlist.status_code, 200)
        self.assertEqual(waitlist.json()["status"], "waitlisted")
        group_view = self.client.get("/v1/sessions/s7/group", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(group_view.status_code, 200)
        self.assertEqual([player["id"] for player in group_view.json()["waitlist"]], ["p4"])
        leave = self.client.post("/v1/sessions/s7/leave", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(leave.status_code, 200)
        self.assertIn("p4", leave.json()["confirmed_player_ids"])
        self.assertNotIn("p4", leave.json()["waitlist_player_ids"])

    def test_group_creation_accepts_custom_session_details(self):
        response = self.client.post(
            "/v1/groups",
            json={
                "query": "Find a game near Indiranagar",
                "group_name": "Thursday Indiranagar Rally",
                "sport": "pickleball",
                "area": "Indiranagar",
                "session_date": "2026-09-10",
                "start_time": "20:00",
                "end_time": "22:00",
                "skill_min": 3.2,
                "skill_max": 4.0,
                "style": "competitive",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        session = response.json()["session"]
        self.assertEqual(session["group_name"], "Thursday Indiranagar Rally")
        self.assertEqual(session["area"], "Indiranagar")
        self.assertEqual(session["session_date"], "2026-09-10")
        self.assertEqual(session["start_time"], "20:00:00")
        self.assertEqual(session["end_time"], "22:00:00")
        self.assertEqual(session["skill_min"], 3.2)
        self.assertEqual(session["skill_max"], 4.0)
        self.assertEqual(session["style"], "competitive")
        self.assertTrue(session["time_finalized"])

    def test_solo_flexible_game_can_be_completed_without_a_time_poll(self):
        game_date = str(date.today() + timedelta(days=2))
        created = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a casual tennis game near Whitefield",
                "sport": "tennis",
                "area": "Whitefield",
                "session_date": game_date,
                "time_window_start": "18:00",
                "time_window_end": "20:00",
                "duration_minutes": 60,
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        self.assertFalse(created.json()["session"]["time_finalized"])

        completed = self.client.post(
            f"/v1/sessions/{created.json()['session']['id']}/complete",
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertTrue(completed.json()["time_finalized"])
        self.assertEqual(completed.json()["status"], "awaiting_feedback")

    def test_group_creation_rejects_invalid_schedule(self):
        past_group = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a game near Whitefield",
                "sport": "tennis",
                "area": "Whitefield",
                "session_date": str(date.today() - timedelta(days=1)),
                "start_time": "19:00",
                "end_time": "21:00",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(past_group.status_code, 422)

        invalid_group = self.client.post(
            "/v1/groups",
            json={
                "query": "Create a game near Whitefield",
                "sport": "tennis",
                "area": "Whitefield",
                "session_date": str(date.today() + timedelta(days=1)),
                "start_time": "21:00",
                "end_time": "19:00",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
    def test_circle_query_returns_grounded_circle_summary(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "What pickleball circles are active in Whitefield?", "player_id": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["scope"], "court_discovery")
        self.assertIn("Circle", payload["message"])
        self.assertIn("Whitefield", payload["message"])

    def test_pickleball_kitchen_rule_question(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Explain the kitchen rule in pickleball", "player_id": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["scope"], "sports_general")
        self.assertIn("Kitchen", payload["message"])
        self.assertIn("Non-Volley Zone", payload["message"])

    def test_padel_vs_pickleball_comparison_question(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "What is the difference between padel and pickleball?", "player_id": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["scope"], "sports_general")
        self.assertIn("Padel", payload["message"])
    def test_profile_image_upload_raw_bytes(self):
        # 1x1 transparent PNG
        png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
        response = self.client.post(
            "/v1/me/profile-image/upload",
            content=png_bytes,
            headers={"Content-Type": "image/png", "X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["profile_image_url"].startswith("http") or payload["profile_image_url"].startswith("data:image/"))

    def test_social_media_upload_raw_bytes(self):
        png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
        response = self.client.post(
            "/v1/social/media/upload",
            content=png_bytes,
            headers={"Content-Type": "image/png", "X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("media_url", payload)
        self.assertTrue(payload["media_url"].startswith("http") or payload["media_url"].startswith("data:image/"))

    def test_social_media_upload_compresses_a_large_photo_when_storage_is_unavailable(self):
        from PIL import Image

        image = Image.effect_noise((1200, 1200), 100).convert("RGB")
        image_buffer = io.BytesIO()
        image.save(image_buffer, format="PNG")
        with patch("backend.main._profile_storage_client", side_effect=RuntimeError("storage unavailable")):
            response = self.client.post(
                "/v1/social/media/upload",
                content=image_buffer.getvalue(),
                headers={"Content-Type": "image/png", "X-CourtMate-Player-ID": "p1"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["media_url"].startswith("data:image/webp;base64,"))
        self.assertLessEqual(len(response.json()["media_url"].encode("utf-8")), 120 * 1024)


if __name__ == "__main__":
    unittest.main()
