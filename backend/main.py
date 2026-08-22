import os
from datetime import date, datetime, time, timedelta, timezone
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .gemini import GeminiIntentParser
from .matching import search_sessions, suggest_replacements
from .models import CreateGroupRequest, CreatedGroupResponse, Feedback, FeedbackRequest, GroupProposal, JoinRequest, JoinRequestRequest, ParseRequest, ReplacementResponse, SearchIntent, SearchResponse, Session
from .repository import create_repository


load_dotenv()

app = FastAPI(title="CourtMate API", version="0.1.0")
allowed_origins = [origin.strip() for origin in os.getenv("COURTMATE_ALLOWED_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
repository = create_repository()
intent_parser = GeminiIntentParser()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "courtmate-api", "datastore": type(repository).__name__}


@app.post("/v1/intent/parse", response_model=SearchIntent)
def parse_intent(request: ParseRequest) -> SearchIntent:
    return intent_parser.parse(request.query)


def _group_proposal(intent: SearchIntent, player_id: str, proposed_name: str | None = None) -> GroupProposal:
    player = repository.get_player(player_id)
    rating = player.dupr_rating if player and player.dupr_rating is not None else 3.25
    skill_min = intent.skill_min if intent.skill_min is not None else max(1.0, round(rating - .3, 1))
    skill_max = intent.skill_max if intent.skill_max is not None else min(8.0, round(rating + .3, 1))
    style = intent.style if intent.style != "any" else player.style if player else "casual"
    return GroupProposal(
        group_name=proposed_name or f"{intent.area} {style.title()} Rally",
        area=intent.area,
        session_date=intent.date,
        start_time=intent.start_time,
        end_time=intent.end_time,
        skill_min=skill_min,
        skill_max=skill_max,
        style=style,
        explanation="No existing group met every requirement. Start this group and CourtMate can invite nearby players in the same DUPR band.",
    )


@app.post("/v1/sessions/search", response_model=SearchResponse)
def search(request: ParseRequest) -> SearchResponse:
    intent = intent_parser.parse(request.query)
    player_id = request.player_id or "p1"
    player = repository.get_player(player_id)
    sessions = repository.list_sessions()
    recommendations = search_sessions(sessions, intent, repository.list_players(), player)
    decision = intent_parser.decide(request.query, intent, sessions, recommendations, player)
    proposal = _group_proposal(intent, player_id, decision.proposed_group_name) if not recommendations else None
    return SearchResponse(intent=intent, recommendations=recommendations, action=decision.action, message=decision.summary, group_proposal=proposal)


@app.post("/v1/sessions/{session_id}/join", response_model=JoinRequest)
def join_session(session_id: str, request: JoinRequestRequest) -> JoinRequest:
    session = repository.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not repository.get_player(request.player_id):
        raise HTTPException(status_code=404, detail="Player not found")
    if request.player_id in session.confirmed_player_ids:
        raise HTTPException(status_code=409, detail="Player is already confirmed for this session")
    if session.open_slots < 1:
        raise HTTPException(status_code=409, detail="Session is full")
    return repository.save_join_request(JoinRequest(id=f"{session_id}_{request.player_id}", session_id=session_id, player_id=request.player_id, created_at=datetime.now(timezone.utc)))


@app.post("/v1/groups", response_model=CreatedGroupResponse)
def create_group(request: CreateGroupRequest) -> CreatedGroupResponse:
    player = repository.get_player(request.player_id)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    intent = intent_parser.parse(request.query)
    proposal = _group_proposal(intent, request.player_id)
    session_date = proposal.session_date or date.today()
    start_time = proposal.start_time or time(19)
    end_time = proposal.end_time or (datetime.combine(session_date, start_time) + timedelta(hours=2)).time()
    session = Session(
        id=f"g-{uuid4().hex[:10]}",
        group_name=proposal.group_name,
        organizer_id=player.id,
        area=proposal.area,
        session_date=session_date,
        start_time=start_time,
        end_time=end_time,
        skill_min=proposal.skill_min,
        skill_max=proposal.skill_max,
        style=proposal.style,
        capacity=proposal.capacity,
        confirmed_player_ids=[player.id],
    )
    return CreatedGroupResponse(session=repository.save_session(session), message="Group created. CourtMate can now invite compatible nearby players.")


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
