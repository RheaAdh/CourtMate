from datetime import date, time

from .models import Feedback, Player, Session


class InMemoryRepository:
    """Demo repository; replace with Firestore without changing service contracts."""

    def __init__(self) -> None:
        self.players = {p.id: p for p in self._seed_players()}
        self.sessions = {s.id: s for s in self._seed_sessions()}
        self.feedback: list[Feedback] = []

    @staticmethod
    def _seed_players() -> list[Player]:
        return [
            Player(id="p1", display_name="Ananya", area="Whitefield", dupr_rating=3.2, rating_source="dupr", rating_confidence=.9, style="casual", reliability=.94, friends=["p2"]),
            Player(id="p2", display_name="Kavya", area="Whitefield", dupr_rating=3.4, rating_source="dupr", rating_confidence=.9, style="casual", reliability=.88, friends=["p1"]),
            Player(id="p3", display_name="Rohit", area="Whitefield", dupr_rating=3.1, rating_source="organizer_confirmed", rating_confidence=.7, style="social", reliability=.91),
            Player(id="p4", display_name="Meera", area="Brookefield", dupr_rating=3.5, rating_source="dupr", rating_confidence=.85, style="competitive", reliability=.96),
            Player(id="p5", display_name="Vikram", area="Kadugodi", dupr_rating=None, rating_source="unrated", rating_confidence=.25, style="casual", reliability=.8),
            Player(id="p6", display_name="Sana", area="Whitefield", dupr_rating=3.3, rating_source="synthetic", rating_confidence=.6, style="casual", reliability=.86),
        ]

    @staticmethod
    def _seed_sessions() -> list[Session]:
        return [
            Session(id="s1", group_name="Sunday Rally Crew", organizer_id="p1", area="Whitefield", session_date=date(2026, 8, 30), start_time=time(8), end_time=time(10), skill_min=3.0, skill_max=3.5, style="casual", capacity=8, confirmed_player_ids=["p1", "p2", "p3", "p6"], external_booking_url="https://playo.co/"),
            Session(id="s2", group_name="East Bengaluru Social", organizer_id="p3", area="Brookefield", session_date=date(2026, 8, 30), start_time=time(9), end_time=time(11), skill_min=2.8, skill_max=3.4, style="social", capacity=8, confirmed_player_ids=["p3", "p5"], external_booking_url="https://hudle.in/"),
            Session(id="s3", group_name="Whitefield Competitive Ladder", organizer_id="p4", area="Whitefield", session_date=date(2026, 8, 30), start_time=time(19), end_time=time(21), skill_min=3.4, skill_max=4.0, style="competitive", capacity=8, confirmed_player_ids=["p4"], external_booking_url="https://playo.co/"),
        ]

    def list_sessions(self) -> list[Session]:
        return list(self.sessions.values())

    def get_session(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    def list_players(self) -> list[Player]:
        return list(self.players.values())

    def get_player(self, player_id: str) -> Player | None:
        return self.players.get(player_id)

    def save_feedback(self, feedback: Feedback) -> Feedback:
        self.feedback.append(feedback)
        return feedback
