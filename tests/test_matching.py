import unittest
from datetime import date, datetime, time, timezone

from backend.gemini import GeminiIntentParser
from backend.matching import search_sessions, suggest_replacements
from backend.models import Player, SearchIntent, Session, Tournament, cmr_from_legacy_rating, normalize_cmr_player, rating_for_sport
from backend.repository import InMemoryRepository
from tests.fixtures import load_repository_fixture
from backend.vector_search import VectorIndexer, VectorRetriever, session_to_document, tournament_to_document


class FakeEmbeddingProvider:
    model = "fake-embedding"
    version = "test"
    dimensions = 2
    available = True

    def embed_document(self, text):
        return [1.0, 0.0] if "pickleball" in text.lower() else [0.0, 1.0]

    def embed_query(self, text):
        return [1.0, 0.0] if "pickleball" in text.lower() else [0.0, 1.0]


class MatchingTests(unittest.TestCase):
    def test_vector_index_retrieves_sanitized_records_with_metadata_filters(self):
        repo = InMemoryRepository()
        load_repository_fixture(repo)
        provider = FakeEmbeddingProvider()
        indexer = VectorIndexer(repo, provider)
        count = indexer.rebuild()
        self.assertGreaterEqual(count, 7)
        document = next(item for item in repo.list_search_documents() if item.source_id == "s1")
        self.assertNotIn("12.9698", document.content)
        results = VectorRetriever(repo, provider).search(
            "Find a relaxed pickleball game nearby",
            SearchIntent(sport="pickleball", area="Whitefield"),
            "session",
        )
        self.assertTrue(results)
        self.assertEqual(results[0].document.source_id, "s1")
        self.assertTrue(all(item.document.source_type == "session" for item in results))

    def test_vector_rebuild_removes_stale_documents(self):
        repo = InMemoryRepository()
        provider = FakeEmbeddingProvider()
        repo.save_search_document(session_to_document(Session(
            id="stale", group_name="Old game", organizer_id="p1", area="Whitefield",
            session_date=date(2026, 9, 1), start_time=time(8), end_time=time(9),
            skill_min=2, skill_max=3, style="casual", capacity=4,
        )))
        load_repository_fixture(repo)
        VectorIndexer(repo, provider).rebuild()
        self.assertNotIn("session__stale", {item.id for item in repo.list_search_documents()})

    def test_tournament_document_uses_supported_tournament_fields(self):
        document = tournament_to_document(Tournament(
            id="tournament-1",
            name="Whitefield Rally Cup",
            sport="pickleball",
            organizer_id="p1",
            area="Whitefield",
            tournament_date=date(2026, 9, 5),
            capacity=8,
            registration_ids=["p1", "p2"],
            created_at=datetime(2026, 8, 30, tzinfo=timezone.utc),
        ))
        self.assertIn("2 registered players", document.content)
        self.assertIn("best of 1", document.content)

    def test_scope_guard_accepts_court_discovery_language(self):
        parser = GeminiIntentParser()
        self.assertTrue(parser.is_in_scope("What courts are nearby?"))
        self.assertTrue(parser.is_in_scope("Find players around me for tennis tomorrow"))
        self.assertTrue(parser.is_in_scope("show groups with people like me"))
        self.assertTrue(parser.is_in_scope("make it more casual", "Find a tennis game near Whitefield this Saturday"))
        self.assertTrue(parser.is_in_scope("this weekend", "Find a pickleball game near Whitefield"))

    def test_scope_guard_rejects_unrelated_questions(self):
        parser = GeminiIntentParser()
        self.assertFalse(parser.is_in_scope("What is the weather near me?"))
        self.assertFalse(parser.is_in_scope("Explain the rules of tennis"))
        self.assertFalse(parser.is_in_scope("What is the capital of France?"))
        self.assertFalse(parser.is_in_scope("What is a pickleball rating?"))
        self.assertFalse(parser.is_in_scope("What is the weather?", "Find a tennis game near Whitefield this Saturday"))
        self.assertTrue(parser.is_in_scope("Show me tennis games near Whitefield"))

    def test_scope_guard_accepts_general_sports_questions(self):
        parser = GeminiIntentParser()
        self.assertTrue(parser.is_general_sports_query("Explain the rules of tennis"))
        self.assertTrue(parser.is_general_sports_query("How can I improve my cricket batting?"))
        self.assertFalse(parser.is_general_sports_query("Find a tennis game near Whitefield"))
        self.assertFalse(parser.is_general_sports_query("What is the weather near me?"))

    def test_performance_guard_does_not_steal_game_discovery_questions(self):
        parser = GeminiIntentParser()
        self.assertFalse(parser.is_performance_query("Find games near me"))
        self.assertTrue(parser.is_performance_query("How is my CMR changing?"))

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
