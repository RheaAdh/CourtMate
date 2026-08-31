import hashlib
import os
from datetime import datetime
from typing import Protocol

from .models import ActivityProof, AppNotification, ChatPost, CommunityMembership, Feedback, FollowRecord, JoinRequest, Player, SearchDocument, Session, SocialComment, SocialPost, VectorSearchResult, normalize_cmr_player
from .vector_search import cosine_similarity


def _feedback_document_id(feedback: Feedback) -> str:
    """Keep one current feedback submission per player for each session."""
    return hashlib.sha256(f"{feedback.session_id}:{feedback.player_id}".encode("utf-8")).hexdigest()


def _latest_feedback_by_submission(feedback_items: list[Feedback]) -> list[Feedback]:
    """Collapse historical duplicate docs left by older append-only storage."""
    latest: dict[tuple[str, str], Feedback] = {}
    for item in feedback_items:
        key = (item.session_id, item.player_id)
        previous = latest.get(key)
        if previous is None or item.created_at >= previous.created_at:
            latest[key] = item
    return list(latest.values())


class Repository(Protocol):
    def list_sessions(self) -> list[Session]: ...
    def get_sessions(self, session_ids: list[str]) -> list[Session]: ...
    def get_session(self, session_id: str) -> Session | None: ...
    def list_players(self) -> list[Player]: ...
    def get_player(self, player_id: str) -> Player | None: ...
    def save_player(self, player: Player) -> Player: ...
    def save_feedback(self, feedback: Feedback) -> Feedback: ...
    def list_feedback(self, session_id: str | None = None) -> list[Feedback]: ...
    def save_activity_proof(self, proof: ActivityProof) -> ActivityProof: ...
    def list_activity_proofs(self, session_id: str | None = None, player_id: str | None = None) -> list[ActivityProof]: ...
    def save_chat_post(self, post: ChatPost) -> ChatPost: ...
    def list_chat_posts(self, session_id: str) -> list[ChatPost]: ...
    def save_social_post(self, post: SocialPost) -> SocialPost: ...
    def get_social_post(self, post_id: str) -> SocialPost | None: ...
    def list_social_posts(self) -> list[SocialPost]: ...
    def toggle_social_like(self, post_id: str, player_id: str) -> SocialPost | None: ...
    def save_social_comment(self, comment: SocialComment) -> SocialComment: ...
    def list_social_comments(self, post_id: str) -> list[SocialComment]: ...
    def record_social_share(self, post_id: str) -> SocialPost | None: ...
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
    def is_follow_request_pending(self, follower_id: str, following_id: str) -> bool: ...
    def list_followers(self, player_id: str) -> list[FollowRecord]: ...
    def list_following(self, player_id: str) -> list[FollowRecord]: ...
    def save_search_document(self, document: SearchDocument) -> SearchDocument: ...
    def delete_search_document(self, document_id: str) -> None: ...
    def list_search_documents(self) -> list[SearchDocument]: ...
    def search_search_documents(self, query_vector: list[float], filters: dict[str, str | int | float | bool | None], limit: int) -> list[VectorSearchResult]: ...
    def save_community_membership(self, membership: CommunityMembership) -> CommunityMembership: ...
    def get_community_membership(self, community_id: str, player_id: str) -> CommunityMembership | None: ...
    def list_community_memberships_for_player(self, player_id: str) -> list[CommunityMembership]: ...


class InMemoryRepository:
    """Local fallback; use COURTMATE_DATASTORE=firestore for shared data."""

    def __init__(self) -> None:
        self.players: dict[str, Player] = {}
        self.sessions: dict[str, Session] = {}
        self.feedback: list[Feedback] = []
        self.activity_proofs: dict[str, ActivityProof] = {}
        self.chat_posts: dict[str, ChatPost] = {}
        self.social_posts: dict[str, SocialPost] = {}
        self.social_comments: dict[str, SocialComment] = {}
        self.join_requests: dict[str, JoinRequest] = {}
        self.notifications: dict[str, AppNotification] = {}
        self.follows: dict[str, FollowRecord] = {}
        self.search_documents: dict[str, SearchDocument] = {}
        self.community_memberships: dict[str, CommunityMembership] = {}

    def list_sessions(self) -> list[Session]:
        return list(self.sessions.values())

    def get_sessions(self, session_ids: list[str]) -> list[Session]:
        return [self.sessions[session_id] for session_id in session_ids if session_id in self.sessions]

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
        self.feedback = [
            item
            for item in self.feedback
            if (item.session_id, item.player_id) != (feedback.session_id, feedback.player_id)
        ]
        self.feedback.append(feedback)
        return feedback

    def list_feedback(self, session_id: str | None = None) -> list[Feedback]:
        items = _latest_feedback_by_submission(self.feedback)
        if session_id is None:
            return items
        return [item for item in items if item.session_id == session_id]

    def save_activity_proof(self, proof: ActivityProof) -> ActivityProof:
        self.activity_proofs[proof.id] = proof
        return proof

    def list_activity_proofs(self, session_id: str | None = None, player_id: str | None = None) -> list[ActivityProof]:
        proofs = list(self.activity_proofs.values())
        if session_id:
            proofs = [proof for proof in proofs if proof.session_id == session_id]
        if player_id:
            proofs = [proof for proof in proofs if proof.player_id == player_id]
        return sorted(proofs, key=lambda proof: proof.created_at, reverse=True)

    def save_chat_post(self, post: ChatPost) -> ChatPost:
        self.chat_posts[post.id] = post
        return post

    def list_chat_posts(self, session_id: str) -> list[ChatPost]:
        return sorted((post for post in self.chat_posts.values() if post.session_id == session_id), key=lambda post: post.created_at)

    def save_social_post(self, post: SocialPost) -> SocialPost:
        self.social_posts[post.id] = post
        return post

    def get_social_post(self, post_id: str) -> SocialPost | None:
        return self.social_posts.get(post_id)

    def list_social_posts(self) -> list[SocialPost]:
        return sorted(self.social_posts.values(), key=lambda post: post.created_at, reverse=True)

    def toggle_social_like(self, post_id: str, player_id: str) -> SocialPost | None:
        post = self.social_posts.get(post_id)
        if not post:
            return None
        liked_by = [item for item in post.liked_by if item != player_id]
        if len(liked_by) == len(post.liked_by):
            liked_by.append(player_id)
        return self.save_social_post(post.model_copy(update={"liked_by": liked_by}))

    def save_social_comment(self, comment: SocialComment) -> SocialComment:
        self.social_comments[comment.id] = comment
        post = self.social_posts.get(comment.post_id)
        if post:
            self.save_social_post(post.model_copy(update={"comment_count": post.comment_count + 1}))
        return comment

    def list_social_comments(self, post_id: str) -> list[SocialComment]:
        return sorted((comment for comment in self.social_comments.values() if comment.post_id == post_id), key=lambda comment: comment.created_at)

    def record_social_share(self, post_id: str) -> SocialPost | None:
        post = self.social_posts.get(post_id)
        return self.save_social_post(post.model_copy(update={"share_count": post.share_count + 1})) if post else None

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

    def save_community_membership(self, membership: CommunityMembership) -> CommunityMembership:
        self.community_memberships[membership.id] = membership
        return membership

    def get_community_membership(self, community_id: str, player_id: str) -> CommunityMembership | None:
        return next((item for item in self.community_memberships.values() if item.community_id == community_id and item.player_id == player_id), None)

    def list_community_memberships_for_player(self, player_id: str) -> list[CommunityMembership]:
        return sorted((item for item in self.community_memberships.values() if item.player_id == player_id), key=lambda item: item.joined_at, reverse=True)

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
        follow = self.follows.get(f"{follower_id}_{following_id}")
        return bool(follow and follow.status == "accepted")

    def is_follow_request_pending(self, follower_id: str, following_id: str) -> bool:
        follow = self.follows.get(f"{follower_id}_{following_id}")
        return bool(follow and follow.status == "pending")

    def list_followers(self, player_id: str) -> list[FollowRecord]:
        return [follow for follow in self.follows.values() if follow.following_id == player_id and follow.status == "accepted"]

    def list_following(self, player_id: str) -> list[FollowRecord]:
        return [follow for follow in self.follows.values() if follow.follower_id == player_id and follow.status == "accepted"]

    def save_search_document(self, document: SearchDocument) -> SearchDocument:
        self.search_documents[document.id] = document
        return document

    def delete_search_document(self, document_id: str) -> None:
        self.search_documents.pop(document_id, None)

    def list_search_documents(self) -> list[SearchDocument]:
        return list(self.search_documents.values())

    def search_search_documents(self, query_vector: list[float], filters: dict[str, str | int | float | bool | None], limit: int) -> list[VectorSearchResult]:
        candidates = []
        for document in self.search_documents.values():
            values = {**document.metadata, "source_type": document.source_type, "source_id": document.source_id}
            if any(values.get(key) != value for key, value in filters.items() if value is not None):
                continue
            similarity = cosine_similarity(query_vector, document.embedding)
            if similarity < 0:
                continue
            candidates.append(VectorSearchResult(document=document, distance=1 - similarity))
        return sorted(candidates, key=lambda item: item.distance if item.distance is not None else 2)[:limit]


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

    def get_sessions(self, session_ids: list[str]) -> list[Session]:
        if not session_ids:
            return []
        references = [self.client.collection("sessions").document(session_id) for session_id in dict.fromkeys(session_ids)]
        return [self._as_session(document) for document in self.client.get_all(references) if document.exists]

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
        self.client.collection("feedback").document(_feedback_document_id(feedback)).set(feedback.model_dump(mode="json"))
        return feedback

    def list_feedback(self, session_id: str | None = None) -> list[Feedback]:
        collection = self.client.collection("feedback")
        documents = collection.where("session_id", "==", session_id).limit(1000).stream() if session_id else collection.limit(1000).stream()
        return _latest_feedback_by_submission([Feedback.model_validate(document.to_dict() or {}) for document in documents])

    def save_activity_proof(self, proof: ActivityProof) -> ActivityProof:
        reference = self.client.collection("activity_proofs").document(proof.id)
        reference.set(self._write_model(proof))
        return proof

    def list_activity_proofs(self, session_id: str | None = None, player_id: str | None = None) -> list[ActivityProof]:
        collection = self.client.collection("activity_proofs")
        if session_id:
            documents = collection.where("session_id", "==", session_id).limit(100).stream()
        elif player_id:
            documents = collection.where("player_id", "==", player_id).limit(100).stream()
        else:
            documents = collection.limit(100).stream()
        proofs = [ActivityProof.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]
        return sorted(proofs, key=lambda proof: proof.created_at, reverse=True)

    def save_chat_post(self, post: ChatPost) -> ChatPost:
        reference = self.client.collection("chat_posts").document(post.id)
        reference.set(post.model_dump(mode="json"))
        return post

    def list_chat_posts(self, session_id: str) -> list[ChatPost]:
        documents = self.client.collection("chat_posts").where("session_id", "==", session_id).limit(100).stream()
        posts = [ChatPost.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]
        return sorted(posts, key=lambda post: post.created_at)

    @staticmethod
    def _as_social_post(document) -> SocialPost:
        return SocialPost.model_validate({**(document.to_dict() or {}), "id": document.id})

    def save_social_post(self, post: SocialPost) -> SocialPost:
        reference = self.client.collection("social_posts").document(post.id)
        reference.set(self._write_model(post))
        return post

    def get_social_post(self, post_id: str) -> SocialPost | None:
        document = self.client.collection("social_posts").document(post_id).get()
        return self._as_social_post(document) if document.exists else None

    def list_social_posts(self) -> list[SocialPost]:
        documents = self.client.collection("social_posts").limit(100).stream()
        return sorted((self._as_social_post(document) for document in documents), key=lambda post: post.created_at, reverse=True)

    def toggle_social_like(self, post_id: str, player_id: str) -> SocialPost | None:
        reference = self.client.collection("social_posts").document(post_id)
        document = reference.get()
        if not document.exists:
            return None
        post = self._as_social_post(document)
        liked_by = [item for item in post.liked_by if item != player_id]
        if len(liked_by) == len(post.liked_by):
            liked_by.append(player_id)
        updated = post.model_copy(update={"liked_by": liked_by})
        reference.set(self._write_model(updated))
        return updated

    def save_social_comment(self, comment: SocialComment) -> SocialComment:
        reference = self.client.collection("social_comments").document(comment.id)
        reference.set(self._write_model(comment))
        post = self.get_social_post(comment.post_id)
        if post:
            self.save_social_post(post.model_copy(update={"comment_count": post.comment_count + 1}))
        return comment

    def list_social_comments(self, post_id: str) -> list[SocialComment]:
        documents = self.client.collection("social_comments").where("post_id", "==", post_id).limit(100).stream()
        comments = [SocialComment.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]
        return sorted(comments, key=lambda comment: comment.created_at)

    def record_social_share(self, post_id: str) -> SocialPost | None:
        reference = self.client.collection("social_posts").document(post_id)
        document = reference.get()
        if not document.exists:
            return None
        post = self._as_social_post(document)
        updated = post.model_copy(update={"share_count": post.share_count + 1})
        reference.set(self._write_model(updated))
        return updated

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

    def save_community_membership(self, membership: CommunityMembership) -> CommunityMembership:
        reference = self.client.collection("community_memberships").document(membership.id)
        reference.set(self._write_model(membership), merge=True)
        return membership

    def get_community_membership(self, community_id: str, player_id: str) -> CommunityMembership | None:
        documents = self.client.collection("community_memberships").where("community_id", "==", community_id).where("player_id", "==", player_id).limit(1).stream()
        document = next(iter(documents), None)
        return CommunityMembership.model_validate({**(document.to_dict() or {}), "id": document.id}) if document else None

    def list_community_memberships_for_player(self, player_id: str) -> list[CommunityMembership]:
        documents = self.client.collection("community_memberships").where("player_id", "==", player_id).limit(100).stream()
        memberships = [CommunityMembership.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents]
        return sorted(memberships, key=lambda item: item.joined_at, reverse=True)

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
        return document.exists and (document.to_dict() or {}).get("status", "accepted") == "accepted"

    def is_follow_request_pending(self, follower_id: str, following_id: str) -> bool:
        document = self.client.collection("follows").document(f"{follower_id}_{following_id}").get()
        return document.exists and (document.to_dict() or {}).get("status", "accepted") == "pending"

    def list_followers(self, player_id: str) -> list[FollowRecord]:
        documents = self.client.collection("follows").where("following_id", "==", player_id).limit(self.max_player_reads).stream()
        return [FollowRecord.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents if (document.to_dict() or {}).get("status", "accepted") == "accepted"]

    def list_following(self, player_id: str) -> list[FollowRecord]:
        documents = self.client.collection("follows").where("follower_id", "==", player_id).limit(self.max_player_reads).stream()
        return [FollowRecord.model_validate({**(document.to_dict() or {}), "id": document.id}) for document in documents if (document.to_dict() or {}).get("status", "accepted") == "accepted"]

    def save_search_document(self, document: SearchDocument) -> SearchDocument:
        from google.cloud.firestore_v1.vector import Vector

        payload = document.model_dump(mode="json")
        payload["embedding"] = Vector(document.embedding)
        # Keep filter fields top-level so Firestore can pre-filter vector queries.
        payload.update(document.metadata)
        self.client.collection("search_documents").document(document.id).set(payload)
        return document

    def delete_search_document(self, document_id: str) -> None:
        self.client.collection("search_documents").document(document_id).delete()

    def list_search_documents(self) -> list[SearchDocument]:
        documents = self.client.collection("search_documents").limit(5000).stream()
        return [self._as_search_document(document) for document in documents]

    def search_search_documents(self, query_vector: list[float], filters: dict[str, str | int | float | bool | None], limit: int) -> list[VectorSearchResult]:
        from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
        from google.cloud.firestore_v1.vector import Vector

        query = self.client.collection("search_documents")
        for field, value in filters.items():
            if value is not None:
                query = query.where(field, "==", value)
        vector_query = query.find_nearest(
            vector_field="embedding",
            query_vector=Vector(query_vector),
            distance_measure=DistanceMeasure.COSINE,
            limit=limit,
        )
        results = []
        for document in vector_query.stream():
            distance = getattr(document, "distance", None)
            results.append(VectorSearchResult(document=self._as_search_document(document), distance=float(distance) if distance is not None else None))
        return results


def create_repository() -> Repository:
    datastore = os.getenv("COURTMATE_DATASTORE", "memory").lower()
    if datastore == "firestore":
        return FirestoreRepository()
    return InMemoryRepository()
