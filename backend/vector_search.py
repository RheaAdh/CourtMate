"""Grounded semantic retrieval for CourtMate.

Firestore remains authoritative. This module only stores searchable projections
and returns candidate IDs; callers must re-read and validate source records.
"""

from __future__ import annotations

import logging
import math
import os
from datetime import date, datetime
from typing import TYPE_CHECKING, Protocol

from .models import Player, SearchDocument, SearchIntent, Session, Tournament, VectorSearchResult

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


class GeminiEmbeddingProvider:
    """Vertex AI embedding adapter with lazy, optional SDK initialization."""

    def __init__(self) -> None:
        self.model = EMBEDDING_MODEL
        self.version = EMBEDDING_VERSION
        self.dimensions = EMBEDDING_DIMENSIONS
        self._client = None
        if os.getenv("COURTMATE_VECTOR_SEARCH_ENABLED", "true").lower() not in {"1", "true", "yes"}:
            return
        use_vertex = os.getenv("COURTMATE_USE_VERTEX_AI", "false").lower() in {"1", "true", "yes"} or os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "false").lower() in {"1", "true", "yes"}
        if not use_vertex:
            logger.info("Vector search is disabled until Vertex AI mode is enabled")
            return
        try:
            from google import genai

            self._client = genai.Client(
                vertexai=True,
                project=os.getenv("GOOGLE_CLOUD_PROJECT"),
                location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
            )
        except (ImportError, ValueError, TypeError) as error:
            logger.warning("Vertex AI embeddings are unavailable: %s", error)

    @property
    def available(self) -> bool:
        return self._client is not None

    def _embed(self, text: str, task_type: str) -> list[float]:
        if not self._client:
            raise RuntimeError("Vertex AI embeddings are not configured")
        from google.genai.types import EmbedContentConfig

        response = self._client.models.embed_content(
            model=self.model,
            contents=text,
            config=EmbedContentConfig(task_type=task_type, output_dimensionality=self.dimensions),
        )
        embeddings = getattr(response, "embeddings", None) or []
        values = getattr(embeddings[0], "values", None) if embeddings else None
        if not values:
            raise RuntimeError("Vertex AI returned an empty embedding")
        return [float(value) for value in values]

    def embed_document(self, text: str) -> list[float]:
        return self._embed(text, "RETRIEVAL_DOCUMENT")

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text, "RETRIEVAL_QUERY")


def _safe_date(value: date | datetime | None) -> str | None:
    return value.isoformat() if value else None


def _document_id(source_type: str, source_id: str) -> str:
    # Firestore document IDs cannot contain '/', so keep the logical key in id.
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
        f"{'Venue: ' + session.venue_name + '. ' if session.venue_name else ''}"
        f"{'External booking link available.' if session.external_booking_url else ''}"
    )
    return _base_document("session", session.id, content, {
        "sport": session.sport,
        "area": session.area.lower(),
        "status": session.status,
        "visibility": "public",
        "event_date": _safe_date(session.session_date),
        "open_slots": open_slots,
    })


def tournament_to_document(tournament: Tournament) -> SearchDocument:
    content = (
        f"{tournament.sport.replace('_', ' ')} tournament named {tournament.name}. "
        f"{tournament.format.replace('_', ' ')} format in {tournament.area}. "
        f"Tournament date {tournament.tournament_date.strftime('%A %d %B')}. "
        f"{tournament.capacity} player capacity. "
        f"{'Venue: ' + tournament.venue_name + '. ' if tournament.venue_name else ''}"
        f"{tournament.summary}"
    )
    return _base_document("tournament", tournament.id, content, {
        "sport": tournament.sport,
        "area": tournament.area.lower(),
        "status": tournament.status,
        "visibility": "public",
        "event_date": _safe_date(tournament.tournament_date),
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


def venue_to_document(venue: dict[str, object]) -> SearchDocument:
    venue_id = str(venue.get("id", venue.get("name", "venue")))
    name = str(venue.get("name", "Court venue"))
    area = str(venue.get("area", ""))
    sports = str(venue.get("sports", "racket sports"))
    content = f"Racket-sport court venue {name} in {area}. Sports: {sports}."
    return _base_document("venue", venue_id, content, {"area": area.lower(), "visibility": "public"})


def faq_documents() -> list[SearchDocument]:
    return [
        _base_document("faq", "court-mate-scope", "CourtMate helps people find racket-sport games, groups, players, venues, tournaments, and game coordination. It does not replace external court-booking platforms.", {"visibility": "public"}),
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

    def upsert_tournament(self, tournament: Tournament) -> SearchDocument:
        return self.upsert(tournament_to_document(tournament))

    def rebuild(self) -> int:
        if not self.provider.available:
            raise RuntimeError("Vector search is not configured")
        documents = [
            *(session_to_document(session) for session in self.repository.list_sessions() if session.status not in {"completed", "cancelled"}),
            *(tournament_to_document(tournament) for tournament in self.repository.list_tournaments() if tournament.status not in {"completed", "cancelled"}),
            *(player_to_document(player) for player in self.repository.list_players()),
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

    def search(self, query: str, intent: SearchIntent, source_type: str, limit: int | None = None, filter_sport: bool = True) -> list[VectorSearchResult]:
        if not self.provider.available:
            raise RuntimeError("Vector search is not configured")
        result_limit = limit or int(os.getenv("COURTMATE_MAX_VECTOR_RESULTS", "20"))
        filters: dict[str, str | int | float | bool | None] = {
            "source_type": source_type,
            "visibility": "public",
        }
        if source_type in {"session", "tournament"}:
            if filter_sport:
                filters["sport"] = intent.sport
            filters["status"] = "open" if source_type == "session" else "registration"
        vector = self.provider.embed_query(query)
        return self.repository.search_search_documents(vector, filters=filters, limit=result_limit)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return -1.0
    denominator = math.sqrt(sum(value * value for value in left)) * math.sqrt(sum(value * value for value in right))
    return sum(a * b for a, b in zip(left, right)) / denominator if denominator else -1.0
