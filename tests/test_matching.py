import unittest
from datetime import date

from backend.gemini import GeminiIntentParser
from backend.matching import search_sessions, suggest_replacements
from backend.models import Player, cmr_from_legacy_rating, normalize_cmr_player, rating_for_sport
from backend.repository import InMemoryRepository
from tests.fixtures import load_repository_fixture


class MatchingTests(unittest.TestCase):
    def test_scope_guard_accepts_court_discovery_language(self):
        parser = GeminiIntentParser()
        self.assertTrue(parser.is_in_scope("What courts are nearby?"))
        self.assertTrue(parser.is_in_scope("Find players around me for tennis tomorrow"))

    def test_scope_guard_rejects_unrelated_questions(self):
        parser = GeminiIntentParser()
        self.assertFalse(parser.is_in_scope("What is the weather near me?"))
        self.assertFalse(parser.is_in_scope("Explain the rules of tennis"))

    def test_cmr_uses_100_scale_and_preserves_legacy_matching(self):
        player = Player(
            id="cmr-player",
            display_name="CMR Player",
            area="Whitefield",
            cmr_ratings={"pickleball": 50.0},
            cmr_scale=100,
        )
        self.assertEqual(cmr_from_legacy_rating(4.5), 50.0)
        self.assertEqual(rating_for_sport(player, "pickleball"), 4.5)

    def test_old_cmr_values_are_normalized_on_read(self):
        player = Player(
            id="legacy-player",
            display_name="Legacy Player",
            area="Whitefield",
            cmr_ratings={"pickleball": 4.5},
            cmr_scale=8,
        )
        normalized = normalize_cmr_player(player)
        self.assertEqual(normalized.cmr_scale, 100)
        self.assertEqual(normalized.cmr_ratings["pickleball"], 50.0)
        self.assertEqual(rating_for_sport(normalized, "pickleball"), 4.5)

    def test_fallback_parser_extracts_core_search_fields(self):
        intent = GeminiIntentParser().parse("Find a casual intermediate pickleball game near Whitefield this Sunday morning")
        self.assertEqual(intent.sport, "pickleball")
        self.assertEqual(intent.area, "Whitefield")
        self.assertEqual(intent.style, "casual")
        self.assertEqual(intent.date, date(2026, 8, 30))


    def test_search_returns_open_whitefield_session(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        intent = GeminiIntentParser().parse("Find a casual game near Whitefield this Sunday")
        results = search_sessions(repo.list_sessions(), intent)
        self.assertTrue(results)
        self.assertEqual(results[0].session.id, "s1")

    def test_coordinate_radius_filters_out_distant_localities(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        player = repo.get_player("p1")
        player.travel_radius_km = 0.5
        intent = GeminiIntentParser().parse("Find a casual game near Whitefield this Sunday")
        intent = intent.model_copy(update={"latitude": player.latitude, "longitude": player.longitude})
        results = search_sessions(repo.list_sessions(), intent, repo.list_players(), player)
        self.assertTrue(results)
        self.assertTrue(all(result.reasons.distance_km is not None for result in results))
        self.assertNotIn("s2", {result.session.id for result in results})

    def test_profile_skill_level_does_not_filter_search(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        player = repo.get_player("p5")
        player.skill_levels = {"pickleball": "advanced"}
        intent = GeminiIntentParser().parse("Find a casual game near Whitefield this Sunday")
        results = search_sessions(repo.list_sessions(), intent, repo.list_players(), player)
        self.assertIn("s1", {result.session.id for result in results})

    def test_explicit_search_level_filters_without_using_profile_level(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        player = repo.get_player("p5")
        player.skill_levels = {"pickleball": "advanced"}
        intent = GeminiIntentParser().parse("Find a beginner game near Whitefield")
        results = search_sessions(repo.list_sessions(), intent, repo.list_players(), player)
        self.assertIn("s4", {result.session.id for result in results})

    def test_nearby_profile_search_prioritizes_style_and_availability(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        player = repo.get_player("p1")
        player.availability = ["weekend mornings"]
        intent = GeminiIntentParser().parse("Show me nearby pickleball games that match my profile")
        results = search_sessions(repo.list_sessions(), intent, repo.list_players(), player)
        self.assertTrue(results)
        self.assertEqual(results[0].session.id, "s1")

    def test_parser_and_matcher_support_other_court_sports(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        intent = GeminiIntentParser().parse("Find a casual badminton game near Whitefield this evening")
        self.assertEqual(intent.sport, "badminton")
        results = search_sessions(repo.list_sessions(), intent)
        self.assertTrue(results)
        self.assertTrue(all(result.session.sport == "badminton" for result in results))
        self.assertEqual(results[0].session.id, "s9")


    def test_replacement_excludes_confirmed_players_and_prefers_fit(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        session = repo.get_session("s1")
        candidates = suggest_replacements(session, repo.list_players())
        self.assertTrue(candidates)
        self.assertTrue(all(candidate.player.id not in session.confirmed_player_ids for candidate in candidates))
        self.assertIn(candidates[0].player.id, {"p4", "p5", "p11", "p14"})
