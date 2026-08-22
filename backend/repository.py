import os
from datetime import date, datetime, time
from typing import Protocol

from .models import Feedback, JoinRequest, Player, Session


class Repository(Protocol):
    def list_sessions(self) -> list[Session]: ...
    def get_session(self, session_id: str) -> Session | None: ...
    def list_players(self) -> list[Player]: ...
    def get_player(self, player_id: str) -> Player | None: ...
    def save_player(self, player: Player) -> Player: ...
    def save_feedback(self, feedback: Feedback) -> Feedback: ...
    def save_join_request(self, join_request: JoinRequest) -> JoinRequest: ...
    def list_join_requests(self, session_id: str) -> list[JoinRequest]: ...
    def save_session(self, session: Session) -> Session: ...


class DemoData:
    @staticmethod
    def seed_players() -> list[Player]:
        return [
            Player(id="p1", display_name="Ananya", area="Whitefield", dupr_rating=3.2, rating_source="dupr", rating_confidence=.9, style="casual", reliability=.94, friends=["p2"]),
            Player(id="p2", display_name="Kavya", area="Whitefield", dupr_rating=3.4, rating_source="dupr", rating_confidence=.9, style="casual", reliability=.88, friends=["p1"]),
            Player(id="p3", display_name="Rohit", area="Whitefield", dupr_rating=3.1, rating_source="organizer_confirmed", rating_confidence=.7, style="social", reliability=.91),
            Player(id="p4", display_name="Meera", area="Brookefield", dupr_rating=3.5, rating_source="dupr", rating_confidence=.85, style="competitive", reliability=.96),
            Player(id="p5", display_name="Vikram", area="Kadugodi", dupr_rating=None, rating_source="unrated", rating_confidence=.25, style="casual", reliability=.8),
            Player(id="p6", display_name="Sana", area="Whitefield", dupr_rating=3.3, rating_source="synthetic", rating_confidence=.6, style="casual", reliability=.86),
            Player(id="p7", display_name="Arjun", area="Whitefield", dupr_rating=2.4, rating_source="dupr", rating_confidence=.9, style="social", reliability=.82),
            Player(id="p8", display_name="Nisha", area="Brookefield", dupr_rating=2.6, rating_source="dupr", rating_confidence=.9, style="casual", reliability=.89),
            Player(id="p9", display_name="Dev", area="Whitefield", dupr_rating=3.8, rating_source="dupr", rating_confidence=.92, style="competitive", reliability=.95),
            Player(id="p10", display_name="Ishaan", area="Kadugodi", dupr_rating=4.1, rating_source="dupr", rating_confidence=.92, style="competitive", reliability=.9),
            Player(id="p11", display_name="Pooja", area="Whitefield", dupr_rating=3.0, rating_source="organizer_confirmed", rating_confidence=.75, style="social", reliability=.84),
            Player(id="p12", display_name="Kabir", area="Varthur", dupr_rating=2.1, rating_source="synthetic", rating_confidence=.55, style="casual", reliability=.78),
            Player(id="p13", display_name="Tara", area="Whitefield", dupr_rating=3.6, rating_source="dupr", rating_confidence=.88, style="competitive", reliability=.93),
            Player(id="p14", display_name="Neil", area="Brookefield", dupr_rating=3.4, rating_source="dupr", rating_confidence=.86, style="social", reliability=.87),
        ]

    @staticmethod
    def seed_sessions() -> list[Session]:
        return [
            Session(id="s1", group_name="Sunday Rally Crew", organizer_id="p1", area="Whitefield", session_date=date(2026, 8, 30), start_time=time(8), end_time=time(10), skill_min=3.0, skill_max=3.5, style="casual", capacity=8, confirmed_player_ids=["p1", "p2", "p3", "p6"], external_booking_url="https://playo.co/"),
            Session(id="s2", group_name="East Bengaluru Social", organizer_id="p3", area="Brookefield", session_date=date(2026, 8, 30), start_time=time(9), end_time=time(11), skill_min=2.8, skill_max=3.4, style="social", capacity=8, confirmed_player_ids=["p3", "p5"], external_booking_url="https://hudle.in/"),
            Session(id="s3", group_name="Whitefield Competitive Ladder", organizer_id="p4", area="Whitefield", session_date=date(2026, 8, 30), start_time=time(19), end_time=time(21), skill_min=3.4, skill_max=4.0, style="competitive", capacity=8, confirmed_player_ids=["p4"], external_booking_url="https://playo.co/"),
            Session(id="s4", group_name="Whitefield Beginner Rally", organizer_id="p7", area="Whitefield", session_date=date(2026, 8, 29), start_time=time(8), end_time=time(10), skill_min=1.8, skill_max=2.8, style="social", capacity=8, confirmed_player_ids=["p7", "p8", "p12"], external_booking_url="https://hudle.in/"),
            Session(id="s5", group_name="Whitefield After-Work Doubles", organizer_id="p6", area="Whitefield", session_date=date(2026, 9, 2), start_time=time(19, 30), end_time=time(21, 30), skill_min=3.0, skill_max=3.6, style="casual", capacity=8, confirmed_player_ids=["p1", "p2", "p6", "p11", "p14", "p3"], external_booking_url="https://playo.co/"),
            Session(id="s6", group_name="Kadugodi Advanced Ladder", organizer_id="p10", area="Kadugodi", session_date=date(2026, 9, 5), start_time=time(7), end_time=time(9), skill_min=3.8, skill_max=4.5, style="competitive", capacity=8, confirmed_player_ids=["p9", "p10", "p13"], external_booking_url="https://playo.co/"),
            Session(id="s7", group_name="Whitefield Full Court Social", organizer_id="p3", area="Whitefield", session_date=date(2026, 8, 30), start_time=time(11), end_time=time(13), skill_min=2.8, skill_max=3.4, style="social", capacity=8, confirmed_player_ids=["p1", "p2", "p3", "p6", "p7", "p8", "p11", "p14"], external_booking_url="https://hudle.in/", status="full"),
            Session(id="s8", group_name="Brookefield Saturday Mix", organizer_id="p14", area="Brookefield", session_date=date(2026, 9, 5), start_time=time(17), end_time=time(19), skill_min=3.0, skill_max=3.7, style="social", capacity=8, confirmed_player_ids=["p4", "p5", "p8", "p14"], external_booking_url="https://playo.co/"),
        ]


class InMemoryRepository:
    """Local fallback; use COURTMATE_DATASTORE=firestore for shared data."""

    def __init__(self) -> None:
        self.players = {p.id: p for p in DemoData.seed_players()}
        self.sessions = {s.id: s for s in DemoData.seed_sessions()}
        self.feedback: list[Feedback] = []
        self.join_requests: dict[str, JoinRequest] = {}

    def list_sessions(self) -> list[Session]:
        return list(self.sessions.values())

    def get_session(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    def list_players(self) -> list[Player]:
        return list(self.players.values())

    def get_player(self, player_id: str) -> Player | None:
        return self.players.get(player_id)

    def save_player(self, player: Player) -> Player:
        self.players[player.id] = player
        return player

    def save_feedback(self, feedback: Feedback) -> Feedback:
        self.feedback.append(feedback)
        return feedback

    def save_join_request(self, join_request: JoinRequest) -> JoinRequest:
        self.join_requests[join_request.id] = join_request
        return join_request

    def list_join_requests(self, session_id: str) -> list[JoinRequest]:
        return [request for request in self.join_requests.values() if request.session_id == session_id]

    def save_session(self, session: Session) -> Session:
        self.sessions[session.id] = session
        return session


class FirestoreRepository:
    """Firestore-backed repository using Application Default Credentials."""

    def __init__(self, project: str | None = None) -> None:
        try:
            from google.cloud import firestore
        except ImportError as error:
            raise RuntimeError("Install google-cloud-firestore to use the Firestore datastore") from error
        self.client = firestore.Client(project=project or os.getenv("GOOGLE_CLOUD_PROJECT"))
        self.max_session_reads = int(os.getenv("COURTMATE_MAX_SESSION_READS", "100"))
        self.max_player_reads = int(os.getenv("COURTMATE_MAX_PLAYER_READS", "500"))

    @staticmethod
    def _as_player(document) -> Player:
        data = document.to_dict() or {}
        data["id"] = document.id
        return Player.model_validate(data)

    @staticmethod
    def _as_session(document) -> Session:
        data = document.to_dict() or {}
        data["id"] = document.id
        for field in ("session_date", "start_time", "end_time"):
            value = data.get(field)
            if isinstance(value, datetime):
                data[field] = value.date().isoformat() if field == "session_date" else value.time().isoformat()
        return Session.model_validate(data)

    @staticmethod
    def _write_model(model) -> dict:
        return model.model_dump(mode="json", exclude={"id"})

    def list_sessions(self) -> list[Session]:
        documents = self.client.collection("sessions").limit(self.max_session_reads).stream()
        return [self._as_session(document) for document in documents]

    def get_session(self, session_id: str) -> Session | None:
        document = self.client.collection("sessions").document(session_id).get()
        return self._as_session(document) if document.exists else None

    def list_players(self) -> list[Player]:
        documents = self.client.collection("players").limit(self.max_player_reads).stream()
        return [self._as_player(document) for document in documents]

    def get_player(self, player_id: str) -> Player | None:
        document = self.client.collection("players").document(player_id).get()
        return self._as_player(document) if document.exists else None

    def save_player(self, player: Player) -> Player:
        reference = self.client.collection("players").document(player.id)
        reference.set(self._write_model(player), merge=True)
        return player

    def save_feedback(self, feedback: Feedback) -> Feedback:
        self.client.collection("feedback").add(feedback.model_dump(mode="json"))
        return feedback

    def save_join_request(self, join_request: JoinRequest) -> JoinRequest:
        reference = self.client.collection("join_requests").document(join_request.id)
        reference.set(join_request.model_dump(mode="json"))
        return join_request

    def list_join_requests(self, session_id: str) -> list[JoinRequest]:
        documents = self.client.collection("join_requests").where("session_id", "==", session_id).limit(100).stream()
        return [JoinRequest.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]

    def save_session(self, session: Session) -> Session:
        reference = self.client.collection("sessions").document(session.id)
        reference.set(self._write_model(session))
        return session


def create_repository() -> Repository:
    datastore = os.getenv("COURTMATE_DATASTORE", "memory").lower()
    if datastore == "firestore":
        return FirestoreRepository()
    return InMemoryRepository()


def seed_firestore(repository: FirestoreRepository) -> None:
    batch = repository.client.batch()
    for player in DemoData.seed_players():
        reference = repository.client.collection("players").document(player.id)
        batch.set(reference, repository._write_model(player))
    for session in DemoData.seed_sessions():
        reference = repository.client.collection("sessions").document(session.id)
        batch.set(reference, repository._write_model(session))
    batch.commit()
