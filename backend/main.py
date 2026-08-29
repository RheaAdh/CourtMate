import os
import re
import json
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
from datetime import date, datetime, time, timedelta, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import AuthIdentity, get_current_identity
from .gemini import GeminiIntentParser
from .matching import distance_km, search_sessions, suggest_replacements
from .models import ActivityProof, ActivityProofRequest, AppNotification, CMRHistoryPoint, ChatPost, ChatPostRequest, ChatResponse, CreateGroupRequest, CreatedGroupResponse, CreateTournamentRequest, Feedback, FeedbackRequest, FollowRecord, GroupProposal, GroupViewResponse, IncomingRequestsResponse, JoinRequest, JoinRequestDecisionRequest, JoinRequestRequest, JoinRequestView, JoinRequestsResponse, LeaderboardEntry, LeaderboardResponse, MyGamesResponse, MyGroupsResponse, MyRequestsResponse, NotificationsResponse, ParseRequest, PastGame, Player, ProfileGameSummary, ProfileImageUpdateRequest, ProfileImageUploadRequest, ProfileImageUploadResponse, ProfileUpdateRequest, PublicPlayerProfile, PublicPlayerProfilesResponse, ReplacementResponse, SearchIntent, SearchResponse, Session, Sport, Tournament, TournamentDetailsResponse, TournamentListResponse, TournamentMatch, TournamentRegistration, TournamentScoreRequest, baseline_rating_for_sport, cmr_from_legacy_rating, rating_for_sport
from .repository import create_repository
from .tournaments import calculate_standings, generate_round_robin_matches, rules_for_sport, validate_score


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
_geocode_cache: dict[str, tuple[float, float] | None] = {}
_fallback_area_coordinates = {
    "whitefield": (12.9698, 77.7499),
    "brookefield": (12.9665, 77.7168),
    "kadugodi": (13.0068, 77.7585),
    "varthur": (12.9408, 77.7460),
    "indiranagar": (12.9784, 77.6408),
    "koramangala": (12.9352, 77.6245),
}
_known_localities = tuple(_fallback_area_coordinates)


def get_current_player(identity: AuthIdentity = Depends(get_current_identity)) -> Player:
    player = repository.get_player(identity.uid)
    if player:
        return player
    display_name = identity.display_name or (identity.email.split("@")[0] if identity.email else "CourtMate player")
    default_area = os.getenv("COURTMATE_DEFAULT_AREA", "Whitefield")
    coordinates = _geocode_area(default_area)
    return repository.save_player(Player(id=identity.uid, display_name=display_name, area=default_area, latitude=coordinates[0] if coordinates else None, longitude=coordinates[1] if coordinates else None))


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
        if next_status == "completed":
            _refresh_cmr_ratings()
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


def _geocode_area(area: str) -> tuple[float, float] | None:
    """Resolve a locality with Google Maps, falling back to known locality coordinates."""
    normalized_area = area.strip().lower()
    if not normalized_area:
        return None
    if normalized_area in _geocode_cache:
        return _geocode_cache[normalized_area]
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    coordinates = None
    if api_key:
        params = urlencode({"address": f"{area}, Bengaluru, India", "key": api_key})
        try:
            request = Request(f"https://maps.googleapis.com/maps/api/geocode/json?{params}", headers={"Accept": "application/json"})
            with urlopen(request, timeout=2) as response:
                payload = json.load(response)
            if payload.get("status") == "OK" and payload.get("results"):
                location = payload["results"][0]["geometry"]["location"]
                coordinates = (float(location["lat"]), float(location["lng"]))
        except (OSError, ValueError, KeyError, IndexError, json.JSONDecodeError):
            coordinates = None
    if coordinates is None:
        coordinates = _fallback_area_coordinates.get(normalized_area)
    _geocode_cache[normalized_area] = coordinates
    return coordinates


def _parse_intent(query: str, sport: Sport | None = None, player: Player | None = None) -> SearchIntent:
    intent = intent_parser.parse(query, sport)
    lowered_query = query.lower()
    locality_match = re.search(r"\b(?:near|around|in)\s+(.+?)(?=\s+(?:this|next|on|at|for|today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|weekday|weekend|morning|afternoon|evening|tonight)\b|$)", lowered_query)
    requested_locality = locality_match.group(1).strip(" ,.") if locality_match else ""
    has_explicit_locality = bool(requested_locality and not requested_locality.startswith(("my location", "my area", "my locality", "the ")))
    if has_explicit_locality:
        intent = intent.model_copy(update={"area": requested_locality.title(), "latitude": None, "longitude": None})
    if not has_explicit_locality and player:
        updates = {"area": player.area}
        if player.latitude is not None and player.longitude is not None:
            updates.update({"latitude": player.latitude, "longitude": player.longitude})
        intent = intent.model_copy(update=updates)
    if intent.latitude is None or intent.longitude is None:
        coordinates = _geocode_area(intent.area)
        if coordinates:
            intent = intent.model_copy(update={"latitude": coordinates[0], "longitude": coordinates[1]})
    return intent


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "courtmate-api", "datastore": type(repository).__name__}


@app.post("/v1/intent/parse", response_model=SearchIntent)
def parse_intent(request: ParseRequest) -> SearchIntent:
    return _parse_intent(request.query, request.sport)


@app.get("/v1/me", response_model=Player)
def me(player: Player = Depends(get_current_player)) -> Player:
    return player


@app.get("/v1/players/{player_id}", response_model=PublicPlayerProfile)
def public_player_profile(player_id: str, player: Player = Depends(get_current_player)) -> PublicPlayerProfile:
    target = repository.get_player(player_id)
    if not target:
        raise HTTPException(status_code=404, detail="Player not found")
    return _public_profile(target, player.id)


@app.post("/v1/players/{player_id}/follow", response_model=PublicPlayerProfile)
def follow_player(player_id: str, player: Player = Depends(get_current_player)) -> PublicPlayerProfile:
    target = repository.get_player(player_id)
    if not target:
        raise HTTPException(status_code=404, detail="Player not found")
    if target.id == player.id:
        raise HTTPException(status_code=409, detail="You cannot follow yourself")
    if not repository.is_following(player.id, target.id):
        repository.save_follow(FollowRecord(id=f"{player.id}_{target.id}", follower_id=player.id, following_id=target.id, created_at=datetime.now(timezone.utc)))
        try:
            repository.save_notification(AppNotification(
                id=f"follow-{player.id}-{target.id}",
                player_id=target.id,
                kind="follow",
                title="New follower",
                message=f"{player.display_name} followed you.",
                session_id="",
                actor_id=player.id,
                created_at=datetime.now(timezone.utc),
            ))
        except Exception:
            pass
    return _public_profile(target, player.id)


@app.post("/v1/players/{player_id}/unfollow", response_model=PublicPlayerProfile)
def unfollow_player(player_id: str, player: Player = Depends(get_current_player)) -> PublicPlayerProfile:
    target = repository.get_player(player_id)
    if not target:
        raise HTTPException(status_code=404, detail="Player not found")
    repository.delete_follow(player.id, target.id)
    return _public_profile(target, player.id)


def _social_profiles(player: Player, following: bool) -> PublicPlayerProfilesResponse:
    records = repository.list_following(player.id) if following else repository.list_followers(player.id)
    profiles = []
    for record in records:
        target_id = record.following_id if following else record.follower_id
        target = repository.get_player(target_id)
        if target:
            profiles.append(_public_profile(target, player.id))
    profiles.sort(key=lambda profile: profile.display_name.lower())
    return PublicPlayerProfilesResponse(profiles=profiles)


@app.get("/v1/me/following", response_model=PublicPlayerProfilesResponse)
def my_following(player: Player = Depends(get_current_player)) -> PublicPlayerProfilesResponse:
    return _social_profiles(player, following=True)


@app.get("/v1/me/followers", response_model=PublicPlayerProfilesResponse)
def my_followers(player: Player = Depends(get_current_player)) -> PublicPlayerProfilesResponse:
    return _social_profiles(player, following=False)


@app.post("/v1/me/profile", response_model=Player)
def update_profile(request: ProfileUpdateRequest, player: Player = Depends(get_current_player)) -> Player:
    updates = request.model_dump(exclude_none=True, exclude={"sport", "skill_level", "skill_rating"})
    if request.area and request.latitude is None and request.longitude is None:
        coordinates = _geocode_area(request.area)
        if coordinates:
            updates.update({"latitude": coordinates[0], "longitude": coordinates[1]})
    updated = player.model_copy(update=updates)
    if request.sport and request.skill_rating is not None:
        sport_ratings = {**player.sport_ratings, request.sport: request.skill_rating}
        rating_sources = {**player.rating_sources, request.sport: "self_reported"}
        rating_updates = {"sport_ratings": sport_ratings, "rating_sources": rating_sources}
        if request.sport == "pickleball":
            rating_updates.update({"dupr_rating": request.skill_rating, "rating_source": "self_reported"})
        updated = updated.model_copy(update=rating_updates)
    if request.sport and request.skill_level:
        updated = updated.model_copy(update={"skill_levels": {**updated.skill_levels, request.sport: request.skill_level}})
    return repository.save_player(updated)


def _profile_storage_client():
    """Return a GCS client that can sign URLs with local or Cloud Run credentials."""
    from google.cloud import storage

    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    client = storage.Client(project=project)
    credentials = client._credentials
    if hasattr(credentials, "sign_bytes"):
        return client

    from google.auth import iam
    from google.auth.transport.requests import Request as GoogleAuthRequest

    service_account_email = os.getenv("COURTMATE_SIGNING_SERVICE_ACCOUNT") or getattr(credentials, "service_account_email", None)
    if not service_account_email:
        raise RuntimeError("Set COURTMATE_SIGNING_SERVICE_ACCOUNT for signed GCS URLs")
    signer = iam.Signer(GoogleAuthRequest(), credentials, service_account_email)
    return storage.Client(project=project, credentials=signer)


@app.post("/v1/me/profile-image/upload-url", response_model=ProfileImageUploadResponse)
def create_profile_image_upload_url(request: ProfileImageUploadRequest, player: Player = Depends(get_current_player)) -> ProfileImageUploadResponse:
    bucket_name = os.getenv("COURTMATE_PROFILE_BUCKET", "profile-pictures")
    extension = "jpg" if request.content_type == "image/jpeg" else request.content_type.split("/", 1)[1]
    object_name = f"profiles/{player.id}/{uuid4()}.{extension}"
    try:
        bucket = _profile_storage_client().bucket(bucket_name)
        blob = bucket.blob(object_name)
        upload_url = blob.generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=10),
            method="PUT",
            content_type=request.content_type,
        )
    except ImportError as error:
        raise HTTPException(status_code=500, detail="Install google-cloud-storage to upload profile pictures") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Could not create a profile picture upload URL") from error
    image_url = f"https://storage.googleapis.com/{bucket_name}/{quote(object_name, safe='/')}"
    return ProfileImageUploadResponse(upload_url=upload_url, image_url=image_url, object_name=object_name, expires_in=600)


@app.post("/v1/me/profile-image", response_model=Player)
def update_profile_image(request: ProfileImageUpdateRequest, player: Player = Depends(get_current_player)) -> Player:
    bucket_name = os.getenv("COURTMATE_PROFILE_BUCKET", "profile-pictures")
    parsed_url = urlparse(request.profile_image_url)
    expected_prefix = f"/{bucket_name}/profiles/{player.id}/"
    if parsed_url.scheme != "https" or parsed_url.hostname != "storage.googleapis.com" or not parsed_url.path.startswith(expected_prefix):
        raise HTTPException(status_code=422, detail="Profile image must be uploaded to the CourtMate profile bucket")
    return repository.save_player(player.model_copy(update={"profile_image_url": request.profile_image_url}))


def _profile_activity(player_id: str) -> tuple[list[ProfileGameSummary], dict[str, int]]:
    today = date.today()
    window_start = today - timedelta(days=83)
    sessions = [session for session in repository.list_sessions() if player_id in session.confirmed_player_ids and session.status != "cancelled"]
    played_sessions = [session for session in sessions if session.session_date <= today]
    recent_games = [
        ProfileGameSummary(
            id=session.id,
            group_name=session.group_name,
            sport=session.sport,
            area=session.area,
            session_date=session.session_date,
            start_time=session.start_time,
            status="played" if session.session_date < today or session.status == "completed" else session.status,
        )
        for session in sorted(played_sessions, key=lambda item: (item.session_date, item.start_time), reverse=True)[:6]
    ]
    activity_by_date: dict[str, int] = {}
    for session in played_sessions:
        if window_start <= session.session_date <= today:
            key = session.session_date.isoformat()
            activity_by_date[key] = activity_by_date.get(key, 0) + 1
    return recent_games, activity_by_date


def _public_profile(player: Player, viewer_id: str | None = None) -> PublicPlayerProfile:
    recent_games, activity_by_date = _profile_activity(player.id)
    return PublicPlayerProfile(
        id=player.id,
        display_name=player.display_name,
        profile_image_url=player.profile_image_url,
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
        cmr_ratings=player.cmr_ratings,
        cmr_game_counts=player.cmr_game_counts,
        followers_count=len(repository.list_followers(player.id)),
        following_count=len(repository.list_following(player.id)),
        is_following=bool(viewer_id and repository.is_following(viewer_id, player.id)),
        follows_you=bool(viewer_id and repository.is_following(player.id, viewer_id)),
        recent_games=recent_games,
        activity_by_date=activity_by_date,
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
        score = candidate.cmr_ratings.get(sport) if sport else candidate.community_score
        ratings_count = candidate.cmr_game_counts.get(sport, 0) if sport else 0
        if score is None:
            score = candidate.community_scores.get(sport) if sport else candidate.community_score
            ratings_count = candidate.community_rating_counts.get(sport, 0) if sport else candidate.community_rating_count
        if score is None:
            score = rating_for_sport(candidate, sport) if sport else candidate.dupr_rating
        if score is None:
            continue
        if ratings_count == 0 and not sport:
            ratings_count = candidate.community_rating_count
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
            value = rating.rating
            if value is None and rating.skill_level:
                value = {"beginner": 2, "intermediate": 3, "advanced": 4}[rating.skill_level]
            if value is not None:
                ratings_by_player.setdefault((rating.player_id, sport), []).append(value)
    for (player_id, sport), ratings in ratings_by_player.items():
        player = repository.get_player(player_id)
        if player:
            community_scores = {**player.community_scores, sport: round(sum(ratings) / len(ratings), 2)}
            community_rating_counts = {**player.community_rating_counts, sport: len(ratings)}
            updates = {"community_scores": community_scores, "community_rating_counts": community_rating_counts}
            if sport == "pickleball":
                updates.update({"community_score": community_scores[sport], "community_rating_count": len(ratings)})
            repository.save_player(player.model_copy(update=updates))


def _refresh_cmr_ratings() -> None:
    """Recompute CMR and a chronological per-game history from completed-game feedback."""
    ratings_by_player: dict[tuple[str, str], dict[str, list[float]]] = {}
    sessions_by_id = {session.id: session for session in repository.list_sessions() if session.status == "completed"}
    for feedback_item in repository.list_feedback():
        session = sessions_by_id.get(feedback_item.session_id)
        if not session:
            continue
        for rating in feedback_item.ratings:
            value = rating.rating
            if rating.skill_level:
                value = {"beginner": 25.0, "intermediate": 50.0, "advanced": 75.0}[rating.skill_level]
            elif value is not None:
                value = round((value - 1) * 100 / 4, 2)
            if value is not None:
                game_ratings = ratings_by_player.setdefault((rating.player_id, session.sport), {})
                game_ratings.setdefault(session.id, []).append(value)
    completed_sessions_by_player: dict[str, list[Session]] = {}
    for session in sessions_by_id.values():
        for player_id in session.confirmed_player_ids:
            completed_sessions_by_player.setdefault(player_id, []).append(session)
    for player_id, completed_sessions in completed_sessions_by_player.items():
        player = repository.get_player(player_id)
        if not player:
            continue
        sessions_by_sport: dict[str, list[Session]] = {}
        for session in completed_sessions:
            sessions_by_sport.setdefault(session.sport, []).append(session)
        cmr_ratings = dict(player.cmr_ratings)
        cmr_game_counts = dict(player.cmr_game_counts)
        cmr_history = dict(player.cmr_history)
        for sport, sport_sessions in sessions_by_sport.items():
            prior = cmr_from_legacy_rating(baseline_rating_for_sport(player, sport) or 3.5)
            running_rating: float | None = None
            game_total = 0.0
            rated_game_count = 0
            history: list[CMRHistoryPoint] = []
            for session in sorted(sport_sessions, key=lambda item: (item.session_date, item.start_time)):
                values = ratings_by_player.get((player_id, sport), {}).get(session.id, [])
                if values:
                    game_rating = round(sum(values) / len(values), 2)
                    game_total += game_rating
                    rated_game_count += 1
                    previous_rating = running_rating if running_rating is not None else prior
                    running_rating = round((prior * 3 + game_total) / (3 + rated_game_count), 2)
                    delta = round(running_rating - previous_rating, 2)
                    history.append(CMRHistoryPoint(session_id=session.id, session_date=session.session_date, group_name=session.group_name, game_rating=game_rating, rating=running_rating, delta=delta))
                else:
                    history.append(CMRHistoryPoint(session_id=session.id, session_date=session.session_date, group_name=session.group_name, rating=running_rating))
            cmr_history[sport] = history
            if running_rating is not None:
                cmr_ratings[sport] = running_rating
                cmr_game_counts[sport] = rated_game_count
        repository.save_player(player.model_copy(update={"cmr_ratings": cmr_ratings, "cmr_game_counts": cmr_game_counts, "cmr_history": cmr_history, "cmr_scale": 100}))


def _notification_day_part(session: Session) -> str:
    day_type = "weekend" if session.session_date.weekday() >= 5 else "weekday"
    if session.start_time.hour < 12:
        day_part = "mornings"
    elif session.start_time.hour >= 16:
        day_part = "evenings"
    else:
        day_part = "afternoons"
    return f"{day_type} {day_part}"


def _matches_new_game(player: Player, session: Session) -> bool:
    if player.id == session.organizer_id:
        return False
    if session.latitude is not None and session.longitude is not None and player.latitude is not None and player.longitude is not None:
        if distance_km(player.latitude, player.longitude, session.latitude, session.longitude) > player.travel_radius_km:
            return False
    elif player.area.strip().lower() != session.area.strip().lower():
        return False
    player_rating = rating_for_sport(player, session.sport)
    if player_rating is not None and not session.skill_min <= player_rating <= session.skill_max:
        return False
    if player.availability and _notification_day_part(session) not in player.availability:
        return False
    compatible_style = player.style == session.style or (player.style == "casual" and session.style == "social") or (player.style == "social" and session.style == "casual")
    return compatible_style


def _notify_players_about_game(session: Session) -> None:
    game_date = session.session_date.strftime("%a, %d %b")
    for candidate in repository.list_players():
        if not _matches_new_game(candidate, session):
            continue
        notification = AppNotification(
            id=f"game-{session.id}-{candidate.id}",
            player_id=candidate.id,
            title=f"A {session.sport.replace('_', ' ')} game opened near you",
            message=f"{session.group_name} is looking for players on {game_date} at {session.start_time.strftime('%I:%M %p').lstrip('0')} in {session.area}.",
            session_id=session.id,
            created_at=datetime.now(timezone.utc),
        )
        try:
            repository.save_notification(notification)
        except Exception:
            # A notification failure must not prevent game creation.
            continue


def _query_group_name(query: str, intent: SearchIntent, style: str) -> str:
    ignored_words = {"find", "me", "a", "an", "the", "show", "looking", "for", "create", "group", "game", "games", "near", "in", "at", "on", "this", "around", "please", "morning", "afternoon", "evening", "tonight", "beginner", "intermediate", "advanced", "casual", "social", "competitive", "pickleball", "badminton", "tennis", "padel", "squash", "table", "ping", "pong"}
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
        latitude=intent.latitude,
        longitude=intent.longitude,
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
    intent = _parse_intent(request.query, request.sport, player)
    sessions = repository.list_sessions()
    recommendations = search_sessions(sessions, intent, repository.list_players(), player, exact=request.mode == "exact")
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
    saved_request = repository.save_join_request(JoinRequest(id=request_id, session_id=session_id, player_id=player.id, player_display_name=player.display_name, status=status, created_at=datetime.now(timezone.utc)))
    if status == "pending":
        try:
            repository.save_notification(AppNotification(
                id=f"request-{request_id}",
                player_id=session.organizer_id,
                kind="join_request",
                title="New join request",
                message=f"{player.display_name} wants to join {session.group_name}.",
                session_id=session.id,
                request_id=saved_request.id,
                created_at=datetime.now(timezone.utc),
            ))
        except Exception:
            pass
    return saved_request


def _notify_request_update(join_request: JoinRequest, session: Session) -> None:
    try:
        status_label = "confirmed" if join_request.status == "approved" else join_request.status
        repository.save_notification(AppNotification(
            id=f"request-update-{join_request.id}-{join_request.status}",
            player_id=join_request.player_id,
            kind="request_update",
            title=f"Join request {status_label}",
            message=f"Your request for {session.group_name} is {status_label}.",
            session_id=session.id,
            request_id=join_request.id,
            created_at=datetime.now(timezone.utc),
        ))
    except Exception:
        pass


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
            saved_request = repository.save_join_request(join_request)
            _notify_request_update(saved_request, session)
            return saved_request
        if join_request.player_id not in session.confirmed_player_ids:
            session.confirmed_player_ids.append(join_request.player_id)
            repository.save_session(session)
    join_request.status = request.status
    saved_request = repository.save_join_request(join_request)
    _notify_request_update(saved_request, session)
    return saved_request


@app.get("/v1/me/requests", response_model=MyRequestsResponse)
def my_requests(player: Player = Depends(get_current_player)) -> MyRequestsResponse:
    request_views = []
    for join_request in repository.list_join_requests_for_player(player.id):
        session = _get_session(join_request.session_id)
        if session:
            request_views.append(JoinRequestView(request=join_request, session=session))
    request_views.sort(key=lambda item: item.request.created_at, reverse=True)
    return MyRequestsResponse(requests=request_views)


@app.get("/v1/me/notifications", response_model=NotificationsResponse)
def notifications(player: Player = Depends(get_current_player)) -> NotificationsResponse:
    return NotificationsResponse(notifications=repository.list_notifications_for_player(player.id))


@app.post("/v1/me/notifications/{notification_id}/read", response_model=AppNotification)
def mark_notification_read(notification_id: str, player: Player = Depends(get_current_player)) -> AppNotification:
    notification = repository.mark_notification_read(notification_id, player.id)
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")
    return notification


@app.get("/v1/me/incoming-requests", response_model=IncomingRequestsResponse)
def incoming_requests(player: Player = Depends(get_current_player)) -> IncomingRequestsResponse:
    """Aggregate pending requests across every group owned by the current player."""
    _refresh_all_session_statuses()
    request_views = []
    for session in repository.list_sessions_by_organizer(player.id):
        if session.status in {"completed", "cancelled"}:
            continue
        for join_request in repository.list_join_requests(session.id):
            if join_request.status == "pending":
                request_views.append(JoinRequestView(request=join_request, session=session))
    request_views.sort(key=lambda item: item.request.created_at, reverse=True)
    return IncomingRequestsResponse(requests=request_views)


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
    members = [_public_profile(players_by_id[player_id], player.id) for player_id in session.confirmed_player_ids if player_id in players_by_id]
    return GroupViewResponse(session=session, members=members, activity_proofs=repository.list_activity_proofs(session_id=session.id))


def _tournament_details(tournament: Tournament) -> TournamentDetailsResponse:
    registrations = repository.list_tournament_registrations(tournament.id)
    matches = repository.list_tournament_matches(tournament.id)
    return TournamentDetailsResponse(
        tournament=tournament,
        registrations=sorted(registrations, key=lambda item: item.created_at),
        matches=matches,
        standings=calculate_standings(registrations, matches),
    )


@app.get("/v1/tournaments", response_model=TournamentListResponse)
def list_tournaments(player: Player = Depends(get_current_player)) -> TournamentListResponse:
    tournaments = [item for item in repository.list_tournaments() if item.status != "cancelled"]
    tournaments.sort(key=lambda item: (item.tournament_date, item.created_at))
    return TournamentListResponse(tournaments=tournaments)


@app.post("/v1/tournaments", response_model=TournamentDetailsResponse)
def create_tournament(request: CreateTournamentRequest, player: Player = Depends(get_current_player)) -> TournamentDetailsResponse:
    try:
        rules = rules_for_sport(request.sport)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    tournament_id = f"t-{uuid4().hex[:12]}"
    tournament = Tournament(
        id=tournament_id,
        name=request.name.strip(),
        sport=request.sport,
        organizer_id=player.id,
        area=request.area.strip(),
        venue_name=request.venue_name.strip() if request.venue_name else None,
        tournament_date=request.tournament_date,
        capacity=request.capacity,
        format=request.format,
        rules=rules,
        created_at=datetime.now(timezone.utc),
    )
    registration = TournamentRegistration(
        id=f"{tournament.id}_{player.id}",
        tournament_id=tournament.id,
        player_id=player.id,
        display_name=player.display_name,
        cmr_rating=player.cmr_ratings.get(request.sport),
        created_at=datetime.now(timezone.utc),
    )
    tournament.registration_ids.append(registration.id)
    repository.save_tournament(tournament)
    repository.save_tournament_registration(registration)
    return _tournament_details(tournament)


@app.get("/v1/tournaments/{tournament_id}", response_model=TournamentDetailsResponse)
def tournament_details(tournament_id: str, player: Player = Depends(get_current_player)) -> TournamentDetailsResponse:
    tournament = repository.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return _tournament_details(tournament)


@app.post("/v1/tournaments/{tournament_id}/register", response_model=TournamentRegistration)
def register_for_tournament(tournament_id: str, player: Player = Depends(get_current_player)) -> TournamentRegistration:
    tournament = repository.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    if tournament.status != "registration":
        raise HTTPException(status_code=409, detail="Registration is closed for this tournament")
    registration_id = f"{tournament.id}_{player.id}"
    existing = next((item for item in repository.list_tournament_registrations(tournament.id) if item.player_id == player.id and item.status != "withdrawn"), None)
    if existing:
        return existing
    registered_count = sum(item.status == "registered" for item in repository.list_tournament_registrations(tournament.id))
    status = "registered" if registered_count < tournament.capacity else "waitlisted"
    registration = TournamentRegistration(
        id=registration_id,
        tournament_id=tournament.id,
        player_id=player.id,
        display_name=player.display_name,
        status=status,
        cmr_rating=player.cmr_ratings.get(tournament.sport),
        created_at=datetime.now(timezone.utc),
    )
    tournament.registration_ids.append(registration.id)
    repository.save_tournament(tournament)
    return repository.save_tournament_registration(registration)


@app.post("/v1/tournaments/{tournament_id}/fixtures", response_model=TournamentDetailsResponse)
def generate_tournament_fixtures(tournament_id: str, player: Player = Depends(get_current_player)) -> TournamentDetailsResponse:
    tournament = repository.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    if tournament.organizer_id != player.id:
        raise HTTPException(status_code=403, detail="Only the organizer can generate fixtures")
    if tournament.status != "registration":
        raise HTTPException(status_code=409, detail="Fixtures have already been generated")
    registrations = repository.list_tournament_registrations(tournament.id)
    try:
        matches = generate_round_robin_matches(tournament.id, registrations)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    for match in matches:
        repository.save_tournament_match(match)
    tournament.status = "in_progress"
    repository.save_tournament(tournament)
    return _tournament_details(tournament)


@app.post("/v1/tournaments/{tournament_id}/matches/{match_id}/score", response_model=TournamentMatch)
def enter_tournament_score(tournament_id: str, match_id: str, request: TournamentScoreRequest, player: Player = Depends(get_current_player)) -> TournamentMatch:
    tournament = repository.get_tournament(tournament_id)
    match = repository.get_tournament_match(match_id)
    if not tournament or not match or match.tournament_id != tournament_id:
        raise HTTPException(status_code=404, detail="Tournament match not found")
    if tournament.status not in {"in_progress", "registration"}:
        raise HTTPException(status_code=409, detail="This tournament is closed")
    if player.id not in {match.player_a_id, match.player_b_id, tournament.organizer_id}:
        raise HTTPException(status_code=403, detail="Only match players or the organizer can enter a score")
    try:
        validate_score(request.score_a, request.score_b, tournament.rules)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if match.status == "completed":
        raise HTTPException(status_code=409, detail="This match result is already locked")
    if match.status == "pending_confirmation" and match.score_entered_by != player.id and player.id != tournament.organizer_id:
        if match.score_a != request.score_a or match.score_b != request.score_b:
            raise HTTPException(status_code=409, detail="The submitted score does not match the pending result")
        match.status = "completed"
        match.confirmed_by = player.id
        match.winner_id = match.player_a_id if request.score_a > request.score_b else match.player_b_id
    elif player.id == tournament.organizer_id or request.confirm:
        match.status = "completed"
        match.confirmed_by = player.id
        match.winner_id = match.player_a_id if request.score_a > request.score_b else match.player_b_id
    else:
        match.status = "pending_confirmation"
        match.score_entered_by = player.id
    match.score_a = request.score_a
    match.score_b = request.score_b
    match.score_entered_by = match.score_entered_by or player.id
    saved_match = repository.save_tournament_match(match)
    if all(item.status == "completed" for item in repository.list_tournament_matches(tournament.id)):
        tournament.status = "completed"
        repository.save_tournament(tournament)
    return saved_match


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
    saved = repository.save_session(session)
    _refresh_cmr_ratings()
    return saved


@app.post("/v1/groups", response_model=CreatedGroupResponse)
def create_group(request: CreateGroupRequest, player: Player = Depends(get_current_player)) -> CreatedGroupResponse:
    intent = _parse_intent(request.query, request.sport, player)
    proposal = _group_proposal(intent, player.id, request.group_name, request.query)
    overrides = request.model_dump(exclude_none=True, exclude={"query", "group_name", "sport"})
    if request.area:
        coordinates = _geocode_area(request.area)
        overrides.update({"area": request.area, "latitude": coordinates[0] if coordinates else None, "longitude": coordinates[1] if coordinates else None})
    proposal = proposal.model_copy(update=overrides)
    session_date = proposal.session_date or date.today()
    start_time = proposal.start_time or time(19)
    end_time = proposal.end_time or (datetime.combine(session_date, start_time) + timedelta(hours=2)).time()
    if session_date < date.today():
        raise HTTPException(status_code=422, detail="Choose today or a future date")
    if end_time <= start_time:
        raise HTTPException(status_code=422, detail="End time must be after start time")
    if proposal.skill_min > proposal.skill_max:
        raise HTTPException(status_code=422, detail="Minimum skill must not exceed maximum skill")
    session = Session(
        id=f"g-{uuid4().hex[:10]}",
        group_name=proposal.group_name,
        organizer_id=player.id,
        area=proposal.area,
        latitude=proposal.latitude,
        longitude=proposal.longitude,
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
    saved_session = repository.save_session(session)
    _notify_players_about_game(saved_session)
    return CreatedGroupResponse(session=saved_session, message="Group created. Compatible nearby players have been notified.")


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
        if rating.player_id == player.id:
            raise HTTPException(status_code=422, detail="You cannot rate yourself")
        if rating.player_id not in session.confirmed_player_ids:
            raise HTTPException(status_code=422, detail="You can only rate players from this group")
        if rating.skill_level is None and rating.rating is None:
            raise HTTPException(status_code=422, detail="Choose a skill level or skip this player")
    seen_team_players: set[str] = set()
    if request.teams:
        if len(request.teams) < 2:
            raise HTTPException(status_code=422, detail="Add at least two teams for a match result")
        has_score = any(team.score is not None for team in request.teams)
        if has_score and any(team.score is None for team in request.teams):
            raise HTTPException(status_code=422, detail="Enter a score for every team")
        for team in request.teams:
            for player_id in team.player_ids:
                if player_id not in session.confirmed_player_ids:
                    raise HTTPException(status_code=422, detail="Teams can only include players from this group")
                if player_id in seen_team_players:
                    raise HTTPException(status_code=422, detail="A player can only be on one team")
                seen_team_players.add(player_id)
    saved = repository.save_feedback(Feedback(session_id=session_id, created_at=datetime.now(timezone.utc), player_id=player.id, fun=request.fun, fairness=request.fairness, would_return=request.would_return, ratings=ratings, teams=request.teams))
    _refresh_community_scores()
    _refresh_cmr_ratings()
    return saved


@app.post("/v1/sessions/{session_id}/activity-proof/analyze", response_model=ActivityProof)
def analyze_activity_proof(session_id: str, request: ActivityProofRequest, player: Player = Depends(get_current_player)) -> ActivityProof:
    session = _member_session(session_id, player)
    if session.status != "completed":
        raise HTTPException(status_code=409, detail="Attach tracker stats after the game is complete")
    parsed_url = urlparse(request.image_url)
    if parsed_url.scheme != "https" or parsed_url.hostname not in {"firebasestorage.googleapis.com", "storage.googleapis.com"}:
        raise HTTPException(status_code=422, detail="Tracker screenshot must be stored in Google Cloud Storage")
    if not intent_parser.image_analysis_available:
        raise HTTPException(status_code=503, detail="Gemini image analysis is not configured")
    try:
        download_request = Request(request.image_url, headers={"Accept": "image/*"})
        with urlopen(download_request, timeout=8) as response:
            mime_type = response.headers.get_content_type()
            image_bytes = response.read(8 * 1024 * 1024 + 1)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Could not read the tracker screenshot") from error
    if mime_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=422, detail="Tracker screenshot must be JPG, PNG, or WebP")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Tracker screenshots must be smaller than 8 MB")
    try:
        analysis = intent_parser.analyze_activity_image(image_bytes, mime_type)
    except Exception as error:
        raise HTTPException(status_code=502, detail="Gemini could not read this screenshot") from error
    proof = ActivityProof(id=f"proof-{uuid4().hex[:12]}", session_id=session.id, player_id=player.id, image_url=request.image_url, analysis=analysis, created_at=datetime.now(timezone.utc))
    return repository.save_activity_proof(proof)
