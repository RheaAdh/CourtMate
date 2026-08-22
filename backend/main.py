import os
import re
from datetime import date, datetime, time, timedelta, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import AuthIdentity, get_current_identity
from .gemini import GeminiIntentParser
from .matching import search_sessions, suggest_replacements
from .models import ChatPost, ChatPostRequest, ChatResponse, CreateGroupRequest, CreatedGroupResponse, Feedback, FeedbackRequest, GroupProposal, GroupViewResponse, JoinRequest, JoinRequestDecisionRequest, JoinRequestRequest, JoinRequestView, JoinRequestsResponse, LeaderboardEntry, LeaderboardResponse, MyGamesResponse, MyGroupsResponse, MyRequestsResponse, ParseRequest, PastGame, Player, ProfileUpdateRequest, PublicPlayerProfile, ReplacementResponse, SearchIntent, SearchResponse, Session, Sport, rating_for_sport
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
local_timezone = ZoneInfo(os.getenv("COURTMATE_TIMEZONE", "Asia/Kolkata"))


def get_current_player(identity: AuthIdentity = Depends(get_current_identity)) -> Player:
    player = repository.get_player(identity.uid)
    if player:
        return player
    display_name = identity.display_name or (identity.email.split("@")[0] if identity.email else "CourtMate player")
    return repository.save_player(Player(id=identity.uid, display_name=display_name, area=os.getenv("COURTMATE_DEFAULT_AREA", "Whitefield")))


def _session_window(session: Session) -> tuple[datetime, datetime]:
    start = datetime.combine(session.session_date, session.start_time, tzinfo=local_timezone)
    end = datetime.combine(session.session_date, session.end_time, tzinfo=local_timezone)
    return start, end


def _refresh_session_status(session: Session) -> Session:
    if session.status in {"completed", "cancelled"}:
        return session
    now = datetime.now(local_timezone)
    start, end = _session_window(session)
    next_status = "completed" if now >= end else "in_progress" if now >= start else session.status
    if next_status != session.status:
        session.status = next_status
        repository.save_session(session)
    return session


def _get_session(session_id: str) -> Session | None:
    session = repository.get_session(session_id)
    return _refresh_session_status(session) if session else None


def _refresh_all_session_statuses() -> None:
    for session in repository.list_sessions():
        _refresh_session_status(session)


def _require_active_session(session: Session) -> None:
    if session.status in {"completed", "cancelled", "in_progress"}:
        raise HTTPException(status_code=409, detail="This game is closed and no longer accepts changes")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "courtmate-api", "datastore": type(repository).__name__}


@app.post("/v1/intent/parse", response_model=SearchIntent)
def parse_intent(request: ParseRequest) -> SearchIntent:
    return intent_parser.parse(request.query, request.sport)


@app.get("/v1/me", response_model=Player)
def me(player: Player = Depends(get_current_player)) -> Player:
    return player


@app.post("/v1/me/profile", response_model=Player)
def update_profile(request: ProfileUpdateRequest, player: Player = Depends(get_current_player)) -> Player:
    updates = request.model_dump(exclude_none=True, exclude={"sport", "skill_rating"})
    updated = player.model_copy(update=updates)
    if request.sport and request.skill_rating is not None:
        sport_ratings = {**player.sport_ratings, request.sport: request.skill_rating}
        rating_sources = {**player.rating_sources, request.sport: "self_reported"}
        rating_updates = {"sport_ratings": sport_ratings, "rating_sources": rating_sources}
        if request.sport == "pickleball":
            rating_updates.update({"dupr_rating": request.skill_rating, "rating_source": "self_reported"})
        updated = updated.model_copy(update=rating_updates)
    return repository.save_player(updated)


def _public_profile(player: Player) -> PublicPlayerProfile:
    return PublicPlayerProfile(
        id=player.id,
        display_name=player.display_name,
        area=player.area,
        dupr_rating=player.dupr_rating,
        rating_source=player.rating_source,
        rating_confidence=player.rating_confidence,
        sport_ratings=player.sport_ratings,
        rating_sources=player.rating_sources,
        style=player.style,
        reliability=player.reliability,
        community_score=player.community_score,
        community_rating_count=player.community_rating_count,
        community_scores=player.community_scores,
        community_rating_counts=player.community_rating_counts,
    )


def _member_session(session_id: str, player: Player) -> Session:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if player.id not in session.confirmed_player_ids:
        raise HTTPException(status_code=403, detail="Only confirmed group members can access this space")
    return session


def _leaderboard(session_ids: list[str], scope: str, sport: str | None = None) -> LeaderboardResponse:
    players_by_id = {candidate.id: candidate for candidate in repository.list_players() if candidate.id in session_ids}
    entries = []
    for candidate in players_by_id.values():
        score = candidate.community_scores.get(sport) if sport else candidate.community_score
        if score is None:
            score = rating_for_sport(candidate, sport) if sport else candidate.dupr_rating
        if score is None:
            continue
        ratings_count = candidate.community_rating_counts.get(sport, 0) if sport else candidate.community_rating_count
        entries.append((candidate, round(score, 2), ratings_count))
    entries.sort(key=lambda item: (-item[1], -item[0].reliability, item[0].display_name.lower()))
    return LeaderboardResponse(
        scope=scope,
        entries=[LeaderboardEntry(rank=index, player=_public_profile(candidate), score=score, ratings_count=count) for index, (candidate, score, count) in enumerate(entries, start=1)],
    )


def _refresh_community_scores() -> None:
    ratings_by_player: dict[tuple[str, str], list[int]] = {}
    for feedback_item in repository.list_feedback():
        session = repository.get_session(feedback_item.session_id)
        sport = session.sport if session else "pickleball"
        for rating in feedback_item.ratings:
            ratings_by_player.setdefault((rating.player_id, sport), []).append(rating.rating)
    for (player_id, sport), ratings in ratings_by_player.items():
        player = repository.get_player(player_id)
        if player:
            community_scores = {**player.community_scores, sport: round(sum(ratings) / len(ratings), 2)}
            community_rating_counts = {**player.community_rating_counts, sport: len(ratings)}
            updates = {"community_scores": community_scores, "community_rating_counts": community_rating_counts}
            if sport == "pickleball":
                updates.update({"community_score": community_scores[sport], "community_rating_count": len(ratings)})
            repository.save_player(player.model_copy(update=updates))


def _query_group_name(query: str, intent: SearchIntent, style: str) -> str:
    ignored_words = {"find", "me", "a", "an", "the", "show", "looking", "for", "create", "group", "game", "games", "near", "in", "at", "on", "this", "around", "please", "morning", "afternoon", "evening", "tonight", "beginner", "intermediate", "advanced", "casual", "social", "competitive", "pickleball", "badminton", "tennis", "padel", "squash", "table", "ping", "pong", "basketball", "volleyball"}
    words = [word for word in re.findall(r"[a-zA-Z0-9]+", query.lower()) if word not in ignored_words]
    phrase = " ".join(word.title() for word in words[:5])
    if not phrase:
        phrase = f"{intent.area} {style.title()}"
    return f"{phrase} {intent.sport.replace('_', ' ').title()}"[:64]


def _group_proposal(intent: SearchIntent, player_id: str, proposed_name: str | None = None, query: str = "") -> GroupProposal:
    player = repository.get_player(player_id)
    rating = rating_for_sport(player, intent.sport) if player else None
    rating = rating if rating is not None else 3.25
    skill_min = intent.skill_min if intent.skill_min is not None else max(1.0, round(rating - .3, 1))
    skill_max = intent.skill_max if intent.skill_max is not None else min(8.0, round(rating + .3, 1))
    style = intent.style if intent.style != "any" else player.style if player else "casual"
    return GroupProposal(
        group_name=proposed_name or _query_group_name(query, intent, style),
        area=intent.area,
        session_date=intent.date,
        start_time=intent.start_time,
        end_time=intent.end_time,
        skill_min=skill_min,
        skill_max=skill_max,
        style=style,
        sport=intent.sport,
        explanation=f"No existing {intent.sport.replace('_', ' ')} group met every requirement. Start this group and CourtMate can invite nearby players in the same skill band.",
    )


@app.post("/v1/sessions/search", response_model=SearchResponse)
def search(request: ParseRequest, player: Player = Depends(get_current_player)) -> SearchResponse:
    _refresh_all_session_statuses()
    intent = intent_parser.parse(request.query, request.sport)
    sessions = repository.list_sessions()
    recommendations = search_sessions(sessions, intent, repository.list_players(), player)
    decision = intent_parser.decide(request.query, intent, sessions, recommendations, player)
    proposal = _group_proposal(intent, player.id, decision.proposed_group_name, request.query) if not recommendations else None
    return SearchResponse(intent=intent, recommendations=recommendations, action=decision.action, message=decision.summary, group_proposal=proposal)


@app.post("/v1/sessions/{session_id}/join", response_model=JoinRequest)
def join_session(session_id: str, request: JoinRequestRequest | None = None, player: Player = Depends(get_current_player)) -> JoinRequest:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_active_session(session)
    if player.id in session.confirmed_player_ids:
        raise HTTPException(status_code=409, detail="Player is already confirmed for this session")
    request_id = f"{session_id}_{player.id}"
    previous = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.player_id == player.id and candidate.status in {"pending", "approved", "waitlisted"}), None)
    if previous:
        raise HTTPException(status_code=409, detail=f"Join request is already {previous.status}")
    status = "pending"
    if session.open_slots < 1:
        session.waitlist_player_ids.append(player.id)
        repository.save_session(session)
        status = "waitlisted"
    return repository.save_join_request(JoinRequest(id=request_id, session_id=session_id, player_id=player.id, player_display_name=player.display_name, status=status, created_at=datetime.now(timezone.utc)))


@app.post("/v1/sessions/{session_id}/leave", response_model=Session)
def leave_session(session_id: str, player: Player = Depends(get_current_player)) -> Session:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_active_session(session)
    if session.organizer_id == player.id:
        raise HTTPException(status_code=409, detail="The organizer cannot leave their own group")
    if player.id in session.confirmed_player_ids:
        session.confirmed_player_ids.remove(player.id)
        prior_request = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.player_id == player.id and candidate.status == "approved"), None)
        if prior_request:
            prior_request.status = "withdrawn"
            repository.save_join_request(prior_request)
        if session.waitlist_player_ids:
            promoted_id = session.waitlist_player_ids.pop(0)
            if promoted_id not in session.confirmed_player_ids:
                session.confirmed_player_ids.append(promoted_id)
            promoted_request = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.player_id == promoted_id and candidate.status == "waitlisted"), None)
            if promoted_request:
                promoted_request.status = "approved"
                repository.save_join_request(promoted_request)
    elif player.id in session.waitlist_player_ids:
        session.waitlist_player_ids.remove(player.id)
        waitlist_request = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.player_id == player.id and candidate.status == "waitlisted"), None)
        if waitlist_request:
            waitlist_request.status = "withdrawn"
            repository.save_join_request(waitlist_request)
    else:
        pending_request = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.player_id == player.id and candidate.status == "pending"), None)
        if pending_request:
            pending_request.status = "withdrawn"
            repository.save_join_request(pending_request)
            return session
        raise HTTPException(status_code=409, detail="You are not confirmed or waitlisted for this session")
    if session.open_slots > 0 and session.status == "full":
        session.status = "open"
    return repository.save_session(session)


@app.get("/v1/sessions/{session_id}/join-requests", response_model=JoinRequestsResponse)
def join_requests(session_id: str, player: Player = Depends(get_current_player)) -> JoinRequestsResponse:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.organizer_id != player.id:
        raise HTTPException(status_code=403, detail="Only the group organizer can view join requests")
    return JoinRequestsResponse(session=session, requests=repository.list_join_requests(session_id))


@app.post("/v1/sessions/{session_id}/join-requests/{request_id}/decision", response_model=JoinRequest)
def decide_join_request(session_id: str, request_id: str, request: JoinRequestDecisionRequest, player: Player = Depends(get_current_player)) -> JoinRequest:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_active_session(session)
    if session.organizer_id != player.id:
        raise HTTPException(status_code=403, detail="Only the group organizer can decide join requests")
    join_request = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.id == request_id), None)
    if not join_request:
        raise HTTPException(status_code=404, detail="Join request not found")
    if join_request.status != "pending":
        raise HTTPException(status_code=409, detail="Join request has already been decided")
    if request.status == "approved":
        if session.open_slots < 1:
            if join_request.player_id not in session.waitlist_player_ids:
                session.waitlist_player_ids.append(join_request.player_id)
                repository.save_session(session)
            join_request.status = "waitlisted"
            return repository.save_join_request(join_request)
        if join_request.player_id not in session.confirmed_player_ids:
            session.confirmed_player_ids.append(join_request.player_id)
            repository.save_session(session)
    join_request.status = request.status
    return repository.save_join_request(join_request)


@app.get("/v1/me/requests", response_model=MyRequestsResponse)
def my_requests(player: Player = Depends(get_current_player)) -> MyRequestsResponse:
    request_views = []
    for join_request in repository.list_join_requests_for_player(player.id):
        session = _get_session(join_request.session_id)
        if session:
            request_views.append(JoinRequestView(request=join_request, session=session))
    request_views.sort(key=lambda item: item.request.created_at, reverse=True)
    return MyRequestsResponse(requests=request_views)


@app.get("/v1/me/groups", response_model=MyGroupsResponse)
def my_groups(player: Player = Depends(get_current_player)) -> MyGroupsResponse:
    _refresh_all_session_statuses()
    groups = repository.list_sessions_by_organizer(player.id)
    groups.sort(key=lambda session: (session.session_date, session.start_time))
    return MyGroupsResponse(groups=groups)


@app.get("/v1/me/games", response_model=MyGamesResponse)
def my_games(player: Player = Depends(get_current_player)) -> MyGamesResponse:
    _refresh_all_session_statuses()
    player_sessions = repository.list_sessions_for_player(player.id)
    games = [session for session in player_sessions if session.session_date >= date.today() and session.status not in {"completed", "cancelled"}]
    games.sort(key=lambda session: (session.session_date, session.start_time))
    past_games = []
    for session in player_sessions:
        if session.status != "completed" or player.id not in session.confirmed_player_ids:
            continue
        entries = _leaderboard(session.confirmed_player_ids, f"group:{session.id}", session.sport).entries
        player_entry = next((entry for entry in entries if entry.player.id == player.id), None)
        past_games.append(PastGame(session=session, rank=player_entry.rank if player_entry else None, score=player_entry.score if player_entry else None, ratings_count=player_entry.ratings_count if player_entry else 0, group_size=len(session.confirmed_player_ids)))
    past_games.sort(key=lambda item: (item.session.session_date, item.session.start_time), reverse=True)
    return MyGamesResponse(games=games, past_games=past_games)


@app.get("/v1/sessions/{session_id}/group", response_model=GroupViewResponse)
def group_view(session_id: str, player: Player = Depends(get_current_player)) -> GroupViewResponse:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    players_by_id = {candidate.id: candidate for candidate in repository.list_players()}
    members = [_public_profile(players_by_id[player_id]) for player_id in session.confirmed_player_ids if player_id in players_by_id]
    return GroupViewResponse(session=session, members=members)


@app.get("/v1/sessions/{session_id}/chat", response_model=ChatResponse)
def group_chat(session_id: str, player: Player = Depends(get_current_player)) -> ChatResponse:
    session = _member_session(session_id, player)
    return ChatResponse(session=session, posts=repository.list_chat_posts(session_id))


@app.post("/v1/sessions/{session_id}/chat", response_model=ChatPost)
def post_group_chat(session_id: str, request: ChatPostRequest, player: Player = Depends(get_current_player)) -> ChatPost:
    session = _member_session(session_id, player)
    _require_active_session(session)
    return repository.save_chat_post(ChatPost(id=uuid4().hex, session_id=session_id, player_id=player.id, player_display_name=player.display_name, message=request.message.strip(), created_at=datetime.now(timezone.utc)))


@app.get("/v1/sessions/{session_id}/leaderboard", response_model=LeaderboardResponse)
def group_leaderboard(session_id: str, player: Player = Depends(get_current_player)) -> LeaderboardResponse:
    session = _member_session(session_id, player)
    return _leaderboard(session.confirmed_player_ids, f"group:{session_id}", session.sport)


@app.get("/v1/leaderboards/local", response_model=LeaderboardResponse)
def local_leaderboard(area: str | None = None, sport: Sport = "pickleball", player: Player = Depends(get_current_player)) -> LeaderboardResponse:
    requested_area = (area or player.area).strip().lower()
    local_players = [candidate for candidate in repository.list_players() if candidate.area.lower() == requested_area]
    return _leaderboard([candidate.id for candidate in local_players], f"local:{area or player.area}:{sport}", sport)


@app.post("/v1/sessions/{session_id}/complete", response_model=Session)
def complete_session(session_id: str, player: Player = Depends(get_current_player)) -> Session:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.organizer_id != player.id:
        raise HTTPException(status_code=403, detail="Only the group organizer can close this game")
    if session.status == "cancelled":
        raise HTTPException(status_code=409, detail="Cancelled games cannot be completed")
    session.status = "completed"
    return repository.save_session(session)


@app.post("/v1/groups", response_model=CreatedGroupResponse)
def create_group(request: CreateGroupRequest, player: Player = Depends(get_current_player)) -> CreatedGroupResponse:
    intent = intent_parser.parse(request.query, request.sport)
    proposal = _group_proposal(intent, player.id, request.group_name, request.query)
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
        sport=proposal.sport,
        capacity=proposal.capacity,
        confirmed_player_ids=[player.id],
    )
    return CreatedGroupResponse(session=repository.save_session(session), message="Group created. CourtMate can now invite compatible nearby players.")


@app.get("/v1/sessions/{session_id}/replacement", response_model=ReplacementResponse)
def replacement(session_id: str, player: Player = Depends(get_current_player)) -> ReplacementResponse:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return ReplacementResponse(session=session, candidates=suggest_replacements(session, repository.list_players()))


@app.post("/v1/sessions/{session_id}/feedback", response_model=Feedback)
def feedback(session_id: str, request: FeedbackRequest, player: Player = Depends(get_current_player)) -> Feedback:
    session = _member_session(session_id, player)
    ratings = request.ratings
    if request.player_id and request.rating is not None:
        ratings = [*ratings, {"player_id": request.player_id, "rating": request.rating}]
    for rating in ratings:
        if rating.player_id not in session.confirmed_player_ids:
            raise HTTPException(status_code=422, detail="You can only rate players from this group")
    saved = repository.save_feedback(Feedback(session_id=session_id, created_at=datetime.now(timezone.utc), player_id=player.id, fun=request.fun, fairness=request.fairness, would_return=request.would_return, ratings=ratings))
    _refresh_community_scores()
    return saved
