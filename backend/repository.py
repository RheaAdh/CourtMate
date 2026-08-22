import os
from datetime import datetime
from typing import Protocol

from .models import ChatPost, Feedback, JoinRequest, Player, Session


class Repository(Protocol):
    def list_sessions(self) -> list[Session]: ...
    def get_session(self, session_id: str) -> Session | None: ...
    def list_players(self) -> list[Player]: ...
    def get_player(self, player_id: str) -> Player | None: ...
    def save_player(self, player: Player) -> Player: ...
    def save_feedback(self, feedback: Feedback) -> Feedback: ...
    def list_feedback(self, session_id: str | None = None) -> list[Feedback]: ...
    def save_chat_post(self, post: ChatPost) -> ChatPost: ...
    def list_chat_posts(self, session_id: str) -> list[ChatPost]: ...
    def save_join_request(self, join_request: JoinRequest) -> JoinRequest: ...
    def list_join_requests(self, session_id: str) -> list[JoinRequest]: ...
    def list_join_requests_for_player(self, player_id: str) -> list[JoinRequest]: ...
    def list_sessions_by_organizer(self, organizer_id: str) -> list[Session]: ...
    def list_sessions_for_player(self, player_id: str) -> list[Session]: ...
    def save_session(self, session: Session) -> Session: ...


class InMemoryRepository:
    """Local fallback; use COURTMATE_DATASTORE=firestore for shared data."""

    def __init__(self) -> None:
        self.players: dict[str, Player] = {}
        self.sessions: dict[str, Session] = {}
        self.feedback: list[Feedback] = []
        self.chat_posts: dict[str, ChatPost] = {}
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

    def list_feedback(self, session_id: str | None = None) -> list[Feedback]:
        if session_id is None:
            return list(self.feedback)
        return [item for item in self.feedback if item.session_id == session_id]

    def save_chat_post(self, post: ChatPost) -> ChatPost:
        self.chat_posts[post.id] = post
        return post

    def list_chat_posts(self, session_id: str) -> list[ChatPost]:
        return sorted((post for post in self.chat_posts.values() if post.session_id == session_id), key=lambda post: post.created_at)

    def save_join_request(self, join_request: JoinRequest) -> JoinRequest:
        self.join_requests[join_request.id] = join_request
        return join_request

    def list_join_requests(self, session_id: str) -> list[JoinRequest]:
        return [request for request in self.join_requests.values() if request.session_id == session_id]

    def list_join_requests_for_player(self, player_id: str) -> list[JoinRequest]:
        return [request for request in self.join_requests.values() if request.player_id == player_id]

    def list_sessions_by_organizer(self, organizer_id: str) -> list[Session]:
        return [session for session in self.sessions.values() if session.organizer_id == organizer_id]

    def list_sessions_for_player(self, player_id: str) -> list[Session]:
        return [session for session in self.sessions.values() if player_id in session.confirmed_player_ids]

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

    def list_feedback(self, session_id: str | None = None) -> list[Feedback]:
        collection = self.client.collection("feedback")
        documents = collection.where("session_id", "==", session_id).limit(1000).stream() if session_id else collection.limit(1000).stream()
        return [Feedback.model_validate(document.to_dict() or {}) for document in documents]

    def save_chat_post(self, post: ChatPost) -> ChatPost:
        reference = self.client.collection("chat_posts").document(post.id)
        reference.set(post.model_dump(mode="json"))
        return post

    def list_chat_posts(self, session_id: str) -> list[ChatPost]:
        documents = self.client.collection("chat_posts").where("session_id", "==", session_id).limit(100).stream()
        posts = [ChatPost.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]
        return sorted(posts, key=lambda post: post.created_at)

    def save_join_request(self, join_request: JoinRequest) -> JoinRequest:
        reference = self.client.collection("join_requests").document(join_request.id)
        reference.set(join_request.model_dump(mode="json"))
        return join_request

    def list_join_requests(self, session_id: str) -> list[JoinRequest]:
        documents = self.client.collection("join_requests").where("session_id", "==", session_id).limit(100).stream()
        return [JoinRequest.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]

    def list_join_requests_for_player(self, player_id: str) -> list[JoinRequest]:
        documents = self.client.collection("join_requests").where("player_id", "==", player_id).limit(100).stream()
        return [JoinRequest.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]

    def list_sessions_by_organizer(self, organizer_id: str) -> list[Session]:
        documents = self.client.collection("sessions").where("organizer_id", "==", organizer_id).limit(self.max_session_reads).stream()
        return [self._as_session(document) for document in documents]

    def list_sessions_for_player(self, player_id: str) -> list[Session]:
        documents = self.client.collection("sessions").where("confirmed_player_ids", "array_contains", player_id).limit(self.max_session_reads).stream()
        return [self._as_session(document) for document in documents]

    def save_session(self, session: Session) -> Session:
        reference = self.client.collection("sessions").document(session.id)
        reference.set(self._write_model(session))
        return session


def create_repository() -> Repository:
    datastore = os.getenv("COURTMATE_DATASTORE", "memory").lower()
    if datastore == "firestore":
        return FirestoreRepository()
    return InMemoryRepository()
