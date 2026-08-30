import os
import unittest
from datetime import date, time, timedelta

os.environ["COURTMATE_DATASTORE"] = "memory"
os.environ["COURTMATE_AUTH_REQUIRED"] = "false"
os.environ["COURTMATE_DEV_PLAYER_ID"] = "p1"
os.environ["GEMINI_API_KEY"] = ""

from fastapi.testclient import TestClient

from backend.main import _clear_read_view_cache, _clear_social_feed_cache, app, repository
from backend.models import Session
from tests.fixtures import load_repository_fixture


class ApiFlowTests(unittest.TestCase):
    def setUp(self):
        load_repository_fixture(repository)
        _clear_read_view_cache()
        _clear_social_feed_cache()
        self.client = TestClient(app)

    def test_search_returns_existing_dupr_compatible_group(self):
        response = self.client.post("/v1/sessions/search", json={"query": "Find a casual intermediate game near Whitefield this Sunday morning", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["action"], "join_existing")
        self.assertEqual(payload["recommendations"][0]["session"]["id"], "s1")
        self.assertEqual(payload["retrieval"]["mode"], "deterministic_fallback")

    def test_chat_followup_keeps_previous_game_context(self):
        original = "Find a pickleball game near Whitefield this Sunday morning"
        first = self.client.post("/v1/sessions/search", json={"query": original})
        self.assertEqual(first.status_code, 200)

        followup = self.client.post(
            "/v1/sessions/search",
            json={"query": "make it more casual", "context": original},
        )
        self.assertEqual(followup.status_code, 200)
        self.assertEqual(followup.json()["scope"], "court_discovery")
        self.assertEqual(followup.json()["intent"]["sport"], "pickleball")
        self.assertEqual(followup.json()["intent"]["area"], "Whitefield")
        self.assertEqual(followup.json()["recommendations"][0]["session"]["id"], "s1")
        self.assertIn("Sunday Rally Crew", followup.json()["message"])

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
        self.assertEqual(intent["skill_min"], 3.5)
        self.assertEqual(intent["skill_max"], 5.0)

    def test_chat_search_uses_profile_area_for_around_me(self):
        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Show me games around me this weekend"},
        )
        intent = response.json()["intent"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(intent["area"], "Whitefield")
        self.assertEqual([item["session"]["id"] for item in response.json()["recommendations"]], ["s1", "s2"])

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

    def test_performance_chat_keeps_unrelated_questions_out_of_scope(self):
        response = self.client.post(
            "/v1/me/performance-chat",
            json={"query": "What is the weather today?"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["scope"], "out_of_scope")
        self.assertIn("racket-sport history", response.json()["answer"])

    def test_group_chat_can_log_pairs_and_update_relative_cmr(self):
        session = repository.get_session("s1")
        session.status = "completed"
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
        self.assertIsNotNone(profile.json()["cmr_ratings"].get("pickleball"))
        history = profile.json()["cmr_history"]["pickleball"]
        point = next(item for item in history if item["session_id"] == "s1")
        self.assertIsNotNone(point["game_rating"])

    def test_unrelated_chat_query_is_redirected_without_results(self):
        response = self.client.post("/v1/sessions/search", json={"query": "What is the weather near me?", "player_id": "p1"})
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "out_of_scope")
        self.assertEqual(payload["recommendations"], [])
        self.assertIsNone(payload["group_proposal"])
        self.assertIn("find racket-sport", payload["message"])

    def test_chat_search_returns_tournaments_without_creating_a_game(self):
        created = self.client.post(
            "/v1/tournaments",
            json={
                "name": "Whitefield Tennis Ladder",
                "sport": "tennis",
                "area": "Whitefield",
                "tournament_date": str(date.today() + timedelta(days=7)),
                "capacity": 8,
                "format": "round_robin",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)

        response = self.client.post(
            "/v1/sessions/search",
            json={"query": "Find tennis tournaments near Whitefield"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["scope"], "court_discovery")
        self.assertEqual(payload["recommendations"], [])
        self.assertEqual(payload["group_proposal"], None)
        self.assertEqual(payload["tournaments"][0]["name"], "Whitefield Tennis Ladder")

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
        self.assertEqual(payload["tournaments"], [])
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
        self.assertEqual(payload["tournaments"], [])
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

    def test_social_feed_supports_session_posts_likes_comments_and_shares(self):
        created = self.client.post(
            "/v1/social/posts",
            json={"caption": "Great Sunday rally with a really fun group.", "sport": "pickleball", "session_id": "s1"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        post_id = created.json()["id"]
        self.assertEqual(created.json()["session_name"], "Sunday Rally Crew")

        feed = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.status_code, 200)
        self.assertFalse(any(post["id"] == post_id for post in feed.json()["posts"]))

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

    def test_personal_rally_contains_only_the_players_completed_session_cards(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(completed.status_code, 200)

        feed = self.client.get("/v1/social/feed?feed=personal", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.status_code, 200)
        posts = feed.json()["posts"]
        self.assertTrue(any(post["id"] == "session-activity-s1" for post in posts))
        self.assertTrue(all(post["activity_type"] == "session" and post["session_status"] == "completed" for post in posts))
        self.assertTrue(all(any(member["id"] == "p2" for member in post["session_players"]) for post in posts))

    def test_session_activity_supports_likes_comments_and_shares(self):
        incomplete = self.client.post("/v1/sessions/s1/social-activity", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(incomplete.status_code, 409)

        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(completed.status_code, 200)
        feed = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(feed.status_code, 200)
        activity = next(post for post in feed.json()["posts"] if post["id"] == "session-activity-s1")

        post_id = activity["id"]
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

    def test_group_member_can_publish_live_session_that_becomes_final_leaderboard(self):
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
        self.assertTrue(completed.json()["social_activity_published"])

        feed = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
        published = next(post for post in feed.json()["posts"] if post["id"] == "session-activity-s1")
        self.assertEqual(published["activity_type"], "session")
        self.assertEqual(published["session_status"], "completed")

        feedback = self.client.post(
            "/v1/sessions/s1/feedback",
            json={"fun": 5, "fairness": 5, "would_return": True, "player_order": ["p1", "p3", "p6"]},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(feedback.status_code, 200)
        self.assertEqual(feedback.json()["ratings"][0]["player_id"], "p1")
        self.assertEqual(feedback.json()["ratings"][0]["rank_score"], 100.0)
        updated_feed = self.client.get("/v1/social/feed", headers={"X-CourtMate-Player-ID": "p2"})
        updated_mvp = next(post for post in updated_feed.json()["posts"] if post["id"] == "session-activity-s1")["session_leaderboard"][0]
        self.assertGreater(updated_mvp["cmr_delta"], 0)

    def test_any_confirmed_player_can_complete_a_game_and_notifies_the_lineup(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p2"})

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "completed")
        self.assertEqual(repository.get_session("s1").status, "completed")

        for player_id in ("p1", "p3", "p6"):
            notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": player_id}).json()["notifications"]
            notification = next(item for item in notifications if item["kind"] == "game_completed" and item["session_id"] == "s1")
            self.assertEqual(notification["actor_id"], "p2")
            self.assertIn("rate", notification["message"].lower())

        completer_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"}).json()["notifications"]
        self.assertFalse(any(item["kind"] == "game_completed" and item["session_id"] == "s1" for item in completer_notifications))

    def test_feedback_requires_a_completed_game(self):
        response = self.client.post(
            "/v1/sessions/s1/feedback",
            json={"fun": 5, "fairness": 5, "would_return": True, "ratings": [{"player_id": "p1", "rating_10": 8}, {"player_id": "p3", "rating_10": 7}, {"player_id": "p6", "rating_10": 6}]},
            headers={"X-CourtMate-Player-ID": "p2"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("marked complete", response.json()["detail"])

    def test_feedback_accepts_private_player_ratings_on_a_ten_point_scale(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(completed.status_code, 200)

        feedback = self.client.post(
            "/v1/sessions/s1/feedback",
            json={
                "fun": 5,
                "fairness": 5,
                "would_return": True,
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

        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        history_point = next(point for point in profile.json()["cmr_history"]["pickleball"] if point["session_id"] == "s1")
        self.assertEqual(history_point["game_rating"], 100.0)

    def test_feedback_resubmission_replaces_the_previous_cmr_signal(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
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

        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        history_point = next(point for point in profile.json()["cmr_history"]["pickleball"] if point["session_id"] == "s1")
        self.assertEqual(history_point["game_rating"], 0.0)

    def test_private_feedback_requires_one_rating_for_each_other_player(self):
        completed = self.client.post("/v1/sessions/s1/complete", headers={"X-CourtMate-Player-ID": "p1"})
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
                "skill_min": 3.0,
                "skill_max": 3.6,
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
        self.assertTrue(followed.json()["is_following"])
        self.assertEqual(followed.json()["followers_count"], 1)
        follow_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertTrue(any(item["kind"] == "follow" and item["actor_id"] == "p1" for item in follow_notifications.json()["notifications"]))

        following = self.client.get("/v1/me/following", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(following.status_code, 200)
        self.assertEqual([item["id"] for item in following.json()["profiles"]], ["p2"])

        self.client.post("/v1/players/p1/follow", headers={"X-CourtMate-Player-ID": "p2"})
        as_target = self.client.get("/v1/players/p1", headers={"X-CourtMate-Player-ID": "p2"})
        self.assertEqual(as_target.status_code, 200)
        self.assertTrue(as_target.json()["follows_you"])

        unfollowed = self.client.post("/v1/players/p2/unfollow", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(unfollowed.status_code, 200)
        self.assertFalse(unfollowed.json()["is_following"])
        self.assertEqual(unfollowed.json()["followers_count"], 0)

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
        self.assertNotIn("skill_rating", payload)

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
        self.assertEqual(set(initial.json()), {"requests", "incoming_requests", "groups", "games", "past_games"})

        join = self.client.post("/v1/sessions/s1/join", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertEqual(join.status_code, 200)

        requester_activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p4"})
        self.assertTrue(any(item["request"]["id"] == join.json()["id"] for item in requester_activity.json()["requests"]))
        organizer_activity = self.client.get("/v1/me/activity", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertTrue(any(item["request"]["id"] == join.json()["id"] for item in organizer_activity.json()["incoming_requests"]))

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
        self.assertEqual(repository.get_session(session_id).status, "completed")

        history = self.client.get("/v1/me/games", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(history.status_code, 200)
        past_game = next(item for item in history.json()["past_games"] if item["session"]["id"] == session_id)
        self.assertEqual(past_game["group_size"], 1)
        self.assertEqual(past_game["rank"], 1)

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
        self.assertEqual(complete.json()["status"], "completed")

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
        leaderboard = self.client.get(f"/v1/sessions/{session_id}/leaderboard", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(leaderboard.status_code, 200)
        p1_entry = next(entry for entry in leaderboard.json()["entries"] if entry["player"]["id"] == "p1")
        self.assertEqual(p1_entry["score"], 42.32)
        self.assertEqual(p1_entry["ratings_count"], 1)
        profile = self.client.get("/v1/me", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(profile.status_code, 200)
        history = profile.json()["cmr_history"]["pickleball"]
        history_point = next(point for point in history if point["session_id"] == session_id)
        self.assertEqual(history_point["game_rating"], 75.0)
        self.assertEqual(history_point["delta"], 10.89)

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

    def test_tournament_registration_fixtures_scores_and_standings(self):
        created = self.client.post(
            "/v1/tournaments",
            json={
                "name": "Whitefield Racket Rally",
                "sport": "pickleball",
                "area": "Whitefield",
                "venue_name": "East Court",
                "tournament_date": str(date.today() + timedelta(days=7)),
                "capacity": 4,
                "format": "round_robin",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        tournament_id = created.json()["tournament"]["id"]

        for player_id in ("p2", "p3"):
            requested = self.client.post(
                f"/v1/tournaments/{tournament_id}/register",
                headers={"X-CourtMate-Player-ID": player_id},
            )
            self.assertEqual(requested.status_code, 200)
            self.assertEqual(requested.json()["status"], "pending")
            organizer_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": "p1"})
            self.assertEqual(organizer_notifications.status_code, 200)
            self.assertTrue(any(item["kind"] == "tournament_request" and item["tournament_id"] == tournament_id for item in organizer_notifications.json()["notifications"]))
            approved = self.client.post(
                f"/v1/tournaments/{tournament_id}/registrations/{requested.json()['id']}/decision",
                json={"status": "approved"},
                headers={"X-CourtMate-Player-ID": "p1"},
            )
            self.assertEqual(approved.status_code, 200)
            self.assertEqual(approved.json()["status"], "registered")
            player_notifications = self.client.get("/v1/me/notifications", headers={"X-CourtMate-Player-ID": player_id})
            self.assertEqual(player_notifications.status_code, 200)
            self.assertTrue(any(item["kind"] == "tournament_update" and item["tournament_id"] == tournament_id for item in player_notifications.json()["notifications"]))

        fixtures = self.client.post(
            f"/v1/tournaments/{tournament_id}/fixtures",
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(fixtures.status_code, 200)
        fixture_payload = fixtures.json()
        self.assertEqual(fixture_payload["tournament"]["status"], "in_progress")
        self.assertEqual(len(fixture_payload["matches"]), 3)
        pairs = {frozenset((match["player_a_id"], match["player_b_id"])) for match in fixture_payload["matches"]}
        self.assertEqual(pairs, {frozenset(("p1", "p2")), frozenset(("p1", "p3")), frozenset(("p2", "p3"))})

        player_match = next(match for match in fixture_payload["matches"] if {match["player_a_id"], match["player_b_id"]} == {"p2", "p3"})
        submitted = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{player_match['id']}/score",
            json={"score_a": 11, "score_b": 8},
            headers={"X-CourtMate-Player-ID": player_match["player_a_id"]},
        )
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual(submitted.json()["status"], "pending_confirmation")

        confirmed = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{player_match['id']}/score",
            json={"score_a": 11, "score_b": 8},
            headers={"X-CourtMate-Player-ID": player_match["player_b_id"]},
        )
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(confirmed.json()["status"], "completed")

        corrected = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{player_match['id']}/score",
            json={"score_a": 9, "score_b": 11, "confirm": True},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(corrected.status_code, 200)
        self.assertEqual(corrected.json()["status"], "completed")
        self.assertEqual(corrected.json()["score_a"], 9)
        self.assertEqual(corrected.json()["score_b"], 11)

        details = self.client.get(
            f"/v1/tournaments/{tournament_id}",
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(details.status_code, 200)
        standings = details.json()["standings"]
        winner = next(entry for entry in standings if entry["player_id"] == player_match["player_b_id"])
        self.assertEqual(winner["wins"], 1)
        self.assertEqual(winner["table_points"], 3)

    def test_tournament_organizer_can_edit_fixture_pairing(self):
        created = self.client.post(
            "/v1/tournaments",
            json={
                "name": "Local Fixture Test",
                "sport": "badminton",
                "area": "Whitefield",
                "tournament_date": str(date.today() + timedelta(days=7)),
                "capacity": 4,
                "format": "round_robin",
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        tournament_id = created.json()["tournament"]["id"]
        for player_id in ("p2", "p3"):
            requested = self.client.post(f"/v1/tournaments/{tournament_id}/register", headers={"X-CourtMate-Player-ID": player_id})
            self.assertEqual(requested.status_code, 200)
            approved = self.client.post(
                f"/v1/tournaments/{tournament_id}/registrations/{requested.json()['id']}/decision",
                json={"status": "approved"},
                headers={"X-CourtMate-Player-ID": "p1"},
            )
            self.assertEqual(approved.status_code, 200)
            self.assertEqual(approved.json()["status"], "registered")
        fixtures = self.client.post(f"/v1/tournaments/{tournament_id}/fixtures", headers={"X-CourtMate-Player-ID": "p1"})
        match = fixtures.json()["matches"][0]

        denied = self.client.put(
            f"/v1/tournaments/{tournament_id}/matches/{match['id']}",
            json={"round_number": 4, "match_number": 1, "player_a_id": "p1", "player_b_id": "p2"},
            headers={"X-CourtMate-Player-ID": "p2"},
        )
        self.assertEqual(denied.status_code, 403)

        updated = self.client.put(
            f"/v1/tournaments/{tournament_id}/matches/{match['id']}",
            json={"round_number": 4, "match_number": 1, "player_a_id": "p1", "player_b_id": "p2"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["round_number"], 4)
        self.assertEqual(updated.json()["player_a_id"], "p1")
        self.assertEqual(updated.json()["status"], "scheduled")

    def test_knockout_fixture_advances_selected_winners(self):
        created = self.client.post(
            "/v1/tournaments",
            json={
                "name": "Whitefield Knockout Cup",
                "sport": "pickleball",
                "area": "Whitefield",
                "tournament_date": str(date.today() + timedelta(days=7)),
                "capacity": 4,
            },
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(created.status_code, 200)
        tournament_id = created.json()["tournament"]["id"]
        for player_id in ("p2", "p3", "p4"):
            requested = self.client.post(f"/v1/tournaments/{tournament_id}/register", headers={"X-CourtMate-Player-ID": player_id})
            self.assertEqual(requested.status_code, 200)
            approved = self.client.post(
                f"/v1/tournaments/{tournament_id}/registrations/{requested.json()['id']}/decision",
                json={"status": "approved"},
                headers={"X-CourtMate-Player-ID": "p1"},
            )
            self.assertEqual(approved.status_code, 200)

        fixtures = self.client.post(f"/v1/tournaments/{tournament_id}/fixtures", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(fixtures.status_code, 200)
        payload = fixtures.json()
        self.assertEqual(payload["tournament"]["format"], "knockout")
        self.assertEqual(len(payload["matches"]), 3)
        first_round = [match for match in payload["matches"] if match["round_number"] == 1]
        self.assertEqual(len(first_round), 2)
        self.assertTrue(all(match["player_a_id"] and match["player_b_id"] for match in first_round))
        final = next(match for match in payload["matches"] if match["round_number"] == 2)
        self.assertIsNone(final["player_a_id"])
        self.assertIsNone(final["player_b_id"])

        future_round_edit = self.client.put(
            f"/v1/tournaments/{tournament_id}/matches/{final['id']}",
            json={"round_number": 2, "match_number": 1, "player_a_id": "p1", "player_b_id": "p2"},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(future_round_edit.status_code, 409)

        first_winner = first_round[0]["player_a_id"]
        second_winner = first_round[1]["player_b_id"]
        first_result = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{first_round[0]['id']}/winner",
            json={"winner_id": first_winner},
            headers={"X-CourtMate-Player-ID": first_winner},
        )
        self.assertEqual(first_result.status_code, 200)
        locked_winner = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{first_round[0]['id']}/winner",
            json={"winner_id": first_round[0]["player_b_id"]},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(locked_winner.status_code, 409)
        second_result = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{first_round[1]['id']}/winner",
            json={"winner_id": second_winner},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(second_result.status_code, 200)

        advanced = self.client.get(f"/v1/tournaments/{tournament_id}", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(advanced.status_code, 200)
        final = next(match for match in advanced.json()["matches"] if match["round_number"] == 2)
        self.assertEqual({final["player_a_id"], final["player_b_id"]}, {first_winner, second_winner})

        final_result = self.client.post(
            f"/v1/tournaments/{tournament_id}/matches/{final['id']}/winner",
            json={"winner_id": first_winner},
            headers={"X-CourtMate-Player-ID": "p1"},
        )
        self.assertEqual(final_result.status_code, 200)
        self.assertEqual(final_result.json()["winner_id"], first_winner)
        self.assertEqual(final_result.json()["status"], "completed")
        self.assertEqual(final_result.json()["score_a"], None)

        completed = self.client.get(f"/v1/tournaments/{tournament_id}", headers={"X-CourtMate-Player-ID": "p1"})
        self.assertEqual(completed.json()["tournament"]["status"], "completed")
        winner = next(entry for entry in completed.json()["standings"] if entry["player_id"] == first_winner)
        self.assertEqual(winner["wins"], 2)


if __name__ == "__main__":
    unittest.main()
