import unittest
from datetime import date

from backend.gemini import GeminiIntentParser
from backend.matching import search_sessions, suggest_replacements
from backend.repository import InMemoryRepository


class MatchingTests(unittest.TestCase):
    def test_fallback_parser_extracts_core_search_fields(self):
        intent = GeminiIntentParser().parse("Find a casual intermediate pickleball game near Whitefield this Sunday morning")
        self.assertEqual(intent.sport, "pickleball")
        self.assertEqual(intent.area, "Whitefield")
        self.assertEqual(intent.style, "casual")
        self.assertEqual(intent.date, date(2026, 8, 30))


    def test_search_returns_open_whitefield_session(self):
        repo = InMemoryRepository()
        intent = GeminiIntentParser().parse("Find a casual game near Whitefield this Sunday")
        results = search_sessions(repo.list_sessions(), intent)
        self.assertTrue(results)
        self.assertEqual(results[0].session.id, "s1")

    def test_parser_and_matcher_support_other_court_sports(self):
        repo = InMemoryRepository()
        intent = GeminiIntentParser().parse("Find a casual badminton game near Whitefield this evening")
        self.assertEqual(intent.sport, "badminton")
        results = search_sessions(repo.list_sessions(), intent)
        self.assertTrue(results)
        self.assertTrue(all(result.session.sport == "badminton" for result in results))
        self.assertEqual(results[0].session.id, "s9")


    def test_replacement_excludes_confirmed_players_and_prefers_fit(self):
        repo = InMemoryRepository()
        session = repo.get_session("s1")
        candidates = suggest_replacements(session, repo.list_players())
        self.assertTrue(candidates)
        self.assertTrue(all(candidate.player.id not in session.confirmed_player_ids for candidate in candidates))
        self.assertIn(candidates[0].player.id, {"p4", "p5", "p11", "p14"})
