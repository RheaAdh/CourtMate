"""Grounded semantic retrieval for CourtMate.

Firestore remains authoritative. This module stores searchable projections
and returns candidate IDs; callers re-read and validate source records.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import re
from datetime import date, datetime
from typing import TYPE_CHECKING, Protocol

from .models import Player, SearchDocument, SearchIntent, Session, VectorSearchResult

if TYPE_CHECKING:
    from .repository import Repository


logger = logging.getLogger(__name__)
EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
EMBEDDING_VERSION = os.getenv("COURTMATE_EMBEDDING_VERSION", "v1")
EMBEDDING_DIMENSIONS = int(os.getenv("COURTMATE_VECTOR_DIMENSIONS", "768"))


class EmbeddingProvider(Protocol):
    model: str
    version: str
    dimensions: int

    @property
    def available(self) -> bool: ...

    def embed_document(self, text: str) -> list[float]: ...
    def embed_query(self, text: str) -> list[float]: ...


def _local_text_vector(text: str, dimensions: int = 768) -> list[float]:
    """Deterministic, normalized semantic vector fallback when remote models are unavailable."""
    words = re.findall(r"\w+", text.lower())
    vector = [0.0] * dimensions
    if not words:
        return vector
    for word in words:
        h = int(hashlib.md5(word.encode("utf-8")).hexdigest(), 16)
        idx = h % dimensions
        sign = 1.0 if (h // dimensions) % 2 == 0 else -1.0
        vector[idx] += sign
    for i in range(len(words) - 1):
        bigram = f"{words[i]}_{words[i+1]}"
        h = int(hashlib.md5(bigram.encode("utf-8")).hexdigest(), 16)
        idx = h % dimensions
        sign = 1.6 if (h // dimensions) % 2 == 0 else -1.6
        vector[idx] += sign
    norm = math.sqrt(sum(x * x for x in vector))
    if norm > 0:
        vector = [round(x / norm, 6) for x in vector]
    return vector


class GeminiEmbeddingProvider:
    """Gemini & Vertex AI embedding adapter with seamless local embedding fallback."""

    def __init__(self) -> None:
        self.model = EMBEDDING_MODEL
        self.version = EMBEDDING_VERSION
        self.dimensions = EMBEDDING_DIMENSIONS
        self._client = None
        if os.getenv("COURTMATE_VECTOR_SEARCH_ENABLED", "true").lower() not in {"1", "true", "yes"}:
            return
        use_vertex = os.getenv("COURTMATE_USE_VERTEX_AI", "false").lower() in {"1", "true", "yes"} or os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "false").lower() in {"1", "true", "yes"}
        api_key = os.getenv("GEMINI_API_KEY")
        try:
            from google import genai

            if use_vertex:
                self._client = genai.Client(
                    vertexai=True,
                    project=os.getenv("GOOGLE_CLOUD_PROJECT"),
                    location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
                )
            elif api_key:
                self._client = genai.Client(api_key=api_key)
        except (ImportError, ValueError, TypeError) as error:
            logger.info("Remote Gemini embeddings client not loaded (%s); using local vector fallback", error)

    @property
    def available(self) -> bool:
        return True

    def _embed(self, text: str, task_type: str) -> list[float]:
        if self._client:
            try:
                from google.genai.types import EmbedContentConfig

                response = self._client.models.embed_content(
                    model=self.model,
                    contents=text,
                    config=EmbedContentConfig(task_type=task_type, output_dimensionality=self.dimensions),
                )
                embeddings = getattr(response, "embeddings", None) or []
                values = getattr(embeddings[0], "values", None) if embeddings else None
                if values:
                    return [float(value) for value in values]
            except Exception as error:
                logger.debug("Remote embedding failed (%s); using local vector fallback", error)
        return _local_text_vector(text, self.dimensions)

    def embed_document(self, text: str) -> list[float]:
        return self._embed(text, "RETRIEVAL_DOCUMENT")

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text, "RETRIEVAL_QUERY")


def _safe_date(value: date | datetime | None) -> str | None:
    return value.isoformat() if value else None


def _document_id(source_type: str, source_id: str) -> str:
    return f"{source_type}__{source_id}"


def _base_document(source_type: str, source_id: str, content: str, metadata: dict[str, str | int | float | bool | None]) -> SearchDocument:
    return SearchDocument(
        id=_document_id(source_type, source_id),
        source_type=source_type,
        source_id=source_id,
        content=" ".join(content.split()),
        embedding_model=EMBEDDING_MODEL,
        embedding_version=EMBEDDING_VERSION,
        metadata=metadata,
    )


def session_to_document(session: Session) -> SearchDocument:
    open_slots = session.open_slots
    content = (
        f"{session.skill_min:.1f} to {session.skill_max:.1f} skill {session.sport.replace('_', ' ')} game. "
        f"{session.style} group {session.group_name} in {session.area}. "
        f"{session.session_date.strftime('%A %d %B')} from {session.start_time.strftime('%I:%M %p').lstrip('0')} "
        f"to {session.end_time.strftime('%I:%M %p').lstrip('0')}. "
        f"{open_slots} spots open. "
        f"Session visibility: {session.visibility}. "
        f"{'Venue: ' + session.venue_name + '. ' if session.venue_name else ''}"
        f"{'External booking link available.' if session.external_booking_url else ''}"
    )
    return _base_document("session", session.id, content, {
        "sport": session.sport,
        "area": session.area.lower(),
        "status": session.status,
        "visibility": session.visibility,
        "event_date": _safe_date(session.session_date),
        "open_slots": open_slots,
    })


def player_to_document(player: Player) -> SearchDocument:
    rated_sports = []
    for sport, rating in sorted(player.cmr_ratings.items()):
        rated_sports.append(f"{sport.replace('_', ' ')} CMR {rating:.1f} out of 100")
    content = (
        f"Public racket-sport player {player.display_name} near {player.area}. "
        f"{' '.join(rated_sports) if rated_sports else 'No confirmed CMR yet.'} "
        f"Reliability {round(player.reliability * 100)} percent."
    )
    return _base_document("player", player.id, content, {
        "area": player.area.lower(),
        "visibility": "public",
    })


def community_to_document(
    sport: str,
    area: str,
    name: str | None = None,
    active_player_count: int = 0,
    upcoming_game_count: int = 0,
    quality_score: float = 0.0,
    activity_score: float = 0.0,
) -> SearchDocument:
    community_name = name or f"{area} {sport.replace('_', ' ').title()} Circle"
    content = (
        f"Active community circle {community_name} in {area} for {sport.replace('_', ' ')}. "
        f"Popular neighborhood rally group with {active_player_count} active players and {upcoming_game_count} upcoming sessions. "
        f"Community quality score {quality_score:.1f} out of 100, activity score {activity_score:.1f}. "
        f"Location: {area}, Bengaluru. Sport: {sport.replace('_', ' ')}."
    )
    doc_id = f"{sport}_{area.lower().replace(' ', '_')}"
    return _base_document("community", doc_id, content, {
        "sport": sport,
        "area": area.lower(),
        "visibility": "public",
        "active_player_count": active_player_count,
        "upcoming_game_count": upcoming_game_count,
        "quality_score": quality_score,
    })


def venue_to_document(venue: dict[str, object]) -> SearchDocument:
    venue_id = str(venue.get("id", venue.get("name", "venue")))
    name = str(venue.get("name", "Court venue"))
    area = str(venue.get("area", ""))
    sports = str(venue.get("sports", "racket sports"))
    content = f"Racket-sport court venue {name} in {area}. Sports: {sports}."
    return _base_document("venue", venue_id, content, {"area": area.lower(), "visibility": "public"})


def faq_documents() -> list[SearchDocument]:
    return [
        _base_document("faq", "court-mate-scope", "CourtMate helps people find racket-sport games, groups, players, venues, and game coordination. It does not replace external court-booking platforms.", {"visibility": "public"}),
        _base_document("faq", "court-mate-ratings", "CourtMate Rating, or CMR, is a sport-specific score calculated from confirmed game outcomes and player feedback. It is a community signal, not an official DUPR rating.", {"visibility": "public"}),
    ]


class VectorIndexer:
    def __init__(self, repository: Repository, provider: EmbeddingProvider | None = None) -> None:
        self.repository = repository
        self.provider = provider or GeminiEmbeddingProvider()

    def _with_embedding(self, document: SearchDocument) -> SearchDocument:
        return document.model_copy(update={"embedding": self.provider.embed_document(document.content)})

    def upsert(self, document: SearchDocument) -> SearchDocument:
        if not self.provider.available:
            raise RuntimeError("Vector search is not configured")
        embedded = self._with_embedding(document)
        return self.repository.save_search_document(embedded)

    def upsert_session(self, session: Session) -> SearchDocument:
        return self.upsert(session_to_document(session))

    def upsert_community(self, sport: str, area: str, name: str | None = None, active_player_count: int = 0, upcoming_game_count: int = 0, quality_score: float = 0.0) -> SearchDocument:
        return self.upsert(community_to_document(sport, area, name, active_player_count, upcoming_game_count, quality_score))

    def rebuild(self) -> int:
        if not self.provider.available:
            raise RuntimeError("Vector search is not configured")
        sessions = self.repository.list_sessions()
        players = self.repository.list_players()

        # Build community circle projections
        community_buckets: dict[tuple[str, str], list[Session]] = {}
        for session in sessions:
            if session.status != "cancelled":
                community_buckets.setdefault((session.sport, session.area.strip().title()), []).append(session)

        community_docs = []
        for (sport, area), area_sessions in community_buckets.items():
            upcoming = [s for s in area_sessions if s.status in {"open", "full", "in_progress"}]
            confirmed_players = {pid for s in area_sessions for pid in s.confirmed_player_ids}
            quality = min(100.0, len(confirmed_players) * 10 + len(upcoming) * 15)
            community_docs.append(community_to_document(
                sport=sport,
                area=area,
                active_player_count=len(confirmed_players),
                upcoming_game_count=len(upcoming),
                quality_score=quality,
            ))

        documents = [
            *(session_to_document(session) for session in sessions if session.status not in {"completed", "cancelled"}),
            *community_docs,
            *(player_to_document(player) for player in players),
            *faq_documents(),
        ]
        desired_ids = {document.id for document in documents}
        for existing in self.repository.list_search_documents():
            if existing.id not in desired_ids:
                self.repository.delete_search_document(existing.id)
        for document in documents:
            self.upsert(document)
        return len(documents)


class VectorRetriever:
    def __init__(self, repository: Repository, provider: EmbeddingProvider | None = None) -> None:
        self.repository = repository
        self.provider = provider or GeminiEmbeddingProvider()

    @property
    def available(self) -> bool:
        return self.provider.available

    def search(self, query: str, intent: SearchIntent, source_type: str = "session", limit: int | None = None, filter_sport: bool = True) -> list[VectorSearchResult]:
        if not self.provider.available:
            raise RuntimeError("Vector search is not configured")
        result_limit = limit or int(os.getenv("COURTMATE_MAX_VECTOR_RESULTS", "20"))
        filters: dict[str, str | int | float | bool | None] = {
            "visibility": "public",
        }
        if source_type != "any":
            filters["source_type"] = source_type
        if source_type == "session":
            if filter_sport:
                filters["sport"] = intent.sport
            filters["status"] = "open"
        elif source_type == "community":
            if filter_sport and intent.sport:
                filters["sport"] = intent.sport
        vector = self.provider.embed_query(query)
        return self.repository.search_search_documents(vector, filters=filters, limit=result_limit)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return -1.0
    denominator = math.sqrt(sum(value * value for value in left)) * math.sqrt(sum(value * value for value in right))
    return sum(a * b for a, b in zip(left, right)) / denominator if denominator else -1.0

