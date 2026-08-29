import os
from datetime import datetime
from typing import Protocol

from .models import AppNotification, ChatPost, Feedback, FollowRecord, JoinRequest, Player, Session, normalize_cmr_player


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
    def save_notification(self, notification: AppNotification) -> AppNotification: ...
    def list_notifications_for_player(self, player_id: str) -> list[AppNotification]: ...
    def mark_notification_read(self, notification_id: str, player_id: str) -> AppNotification | None: ...
    def save_follow(self, follow: FollowRecord) -> FollowRecord: ...
    def delete_follow(self, follower_id: str, following_id: str) -> None: ...
    def is_following(self, follower_id: str, following_id: str) -> bool: ...
    def list_followers(self, player_id: str) -> list[FollowRecord]: ...
    def list_following(self, player_id: str) -> list[FollowRecord]: ...


class InMemoryRepository:
    """Local fallback; use COURTMATE_DATASTORE=firestore for shared data."""

    def __init__(self) -> None:
        self.players: dict[str, Player] = {}
        self.sessions: dict[str, Session] = {}
        self.feedback: list[Feedback] = []
        self.chat_posts: dict[str, ChatPost] = {}
        self.join_requests: dict[str, JoinRequest] = {}
        self.notifications: dict[str, AppNotification] = {}
        self.follows: dict[str, FollowRecord] = {}

    def list_sessions(self) -> list[Session]:
        return list(self.sessions.values())

    def get_session(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    def list_players(self) -> list[Player]:
        return [normalize_cmr_player(player) for player in self.players.values()]

    def get_player(self, player_id: str) -> Player | None:
        player = self.players.get(player_id)
        return normalize_cmr_player(player) if player else None

    def save_player(self, player: Player) -> Player:
        normalized = normalize_cmr_player(player)
        self.players[normalized.id] = normalized
        return normalized

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

    def save_notification(self, notification: AppNotification) -> AppNotification:
        self.notifications[notification.id] = notification
        return notification

    def list_notifications_for_player(self, player_id: str) -> list[AppNotification]:
        return sorted((item for item in self.notifications.values() if item.player_id == player_id), key=lambda item: item.created_at, reverse=True)

    def mark_notification_read(self, notification_id: str, player_id: str) -> AppNotification | None:
        notification = self.notifications.get(notification_id)
        if not notification or notification.player_id != player_id:
            return None
        updated = notification.model_copy(update={"read": True})
        self.notifications[notification_id] = updated
        return updated

    def save_follow(self, follow: FollowRecord) -> FollowRecord:
        self.follows[follow.id] = follow
        return follow

    def delete_follow(self, follower_id: str, following_id: str) -> None:
        self.follows.pop(f"{follower_id}_{following_id}", None)

    def is_following(self, follower_id: str, following_id: str) -> bool:
        return f"{follower_id}_{following_id}" in self.follows

    def list_followers(self, player_id: str) -> list[FollowRecord]:
        return [follow for follow in self.follows.values() if follow.following_id == player_id]

    def list_following(self, player_id: str) -> list[FollowRecord]:
        return [follow for follow in self.follows.values() if follow.follower_id == player_id]


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
        return normalize_cmr_player(Player.model_validate(data))

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
        normalized = normalize_cmr_player(player)
        reference = self.client.collection("players").document(normalized.id)
        reference.set(self._write_model(normalized), merge=True)
        return normalized

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

    def save_notification(self, notification: AppNotification) -> AppNotification:
        reference = self.client.collection("notifications").document(notification.id)
        reference.set(self._write_model(notification), merge=True)
        return notification

    def list_notifications_for_player(self, player_id: str) -> list[AppNotification]:
        documents = self.client.collection("notifications").where("player_id", "==", player_id).limit(100).stream()
        notifications = [AppNotification.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]
        return sorted(notifications, key=lambda item: item.created_at, reverse=True)

    def mark_notification_read(self, notification_id: str, player_id: str) -> AppNotification | None:
        reference = self.client.collection("notifications").document(notification_id)
        document = reference.get()
        if not document.exists:
            return None
        notification = AppNotification.model_validate({**(document.to_dict() or {}), "id": document.id})
        if notification.player_id != player_id:
            return None
        updated = notification.model_copy(update={"read": True})
        reference.set(self._write_model(updated), merge=True)
        return updated

    def save_follow(self, follow: FollowRecord) -> FollowRecord:
        reference = self.client.collection("follows").document(follow.id)
        reference.set(self._write_model(follow), merge=True)
        return follow

    def delete_follow(self, follower_id: str, following_id: str) -> None:
        self.client.collection("follows").document(f"{follower_id}_{following_id}").delete()

    def is_following(self, follower_id: str, following_id: str) -> bool:
        document = self.client.collection("follows").document(f"{follower_id}_{following_id}").get()
        return document.exists

    def list_followers(self, player_id: str) -> list[FollowRecord]:
        documents = self.client.collection("follows").where("following_id", "==", player_id).limit(self.max_player_reads).stream()
        return [FollowRecord.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]

    def list_following(self, player_id: str) -> list[FollowRecord]:
        documents = self.client.collection("follows").where("follower_id", "==", player_id).limit(self.max_player_reads).stream()
        return [FollowRecord.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]


def create_repository() -> Repository:
    datastore = os.getenv("COURTMATE_DATASTORE", "memory").lower()
    if datastore == "firestore":
        return FirestoreRepository()
    return InMemoryRepository()
