import os
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .gemini import GeminiIntentParser
from .matching import search_sessions, suggest_replacements
from .models import Feedback, FeedbackRequest, ParseRequest, ReplacementResponse, SearchIntent, SearchResponse
from .repository import InMemoryRepository


app = FastAPI(title="CourtMate API", version="0.1.0")
allowed_origins = [origin.strip() for origin in os.getenv("COURTMATE_ALLOWED_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
repository = InMemoryRepository()
intent_parser = GeminiIntentParser()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "courtmate-api"}


@app.post("/v1/intent/parse", response_model=SearchIntent)
def parse_intent(request: ParseRequest) -> SearchIntent:
    return intent_parser.parse(request.query)


@app.post("/v1/sessions/search", response_model=SearchResponse)
def search(request: ParseRequest) -> SearchResponse:
    intent = intent_parser.parse(request.query)
    return SearchResponse(intent=intent, recommendations=search_sessions(repository.list_sessions(), intent))


@app.get("/v1/sessions/{session_id}/replacement", response_model=ReplacementResponse)
def replacement(session_id: str) -> ReplacementResponse:
    session = repository.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return ReplacementResponse(session=session, candidates=suggest_replacements(session, repository.list_players()))


@app.post("/v1/sessions/{session_id}/feedback", response_model=Feedback)
def feedback(session_id: str, request: FeedbackRequest) -> Feedback:
    if not repository.get_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return repository.save_feedback(Feedback(session_id=session_id, created_at=datetime.now(timezone.utc), **request.model_dump()))
