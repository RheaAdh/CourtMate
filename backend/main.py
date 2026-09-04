import base64
import io
import json
import logging
import os
import re
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
from datetime import date, datetime, time, timedelta, timezone
from time import monotonic, perf_counter
from typing import Literal
from uuid import uuid4
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware

from .auth import AuthIdentity, get_current_identity
from .facilities import BENGALURU_FACILITIES
from .gemini import GeminiIntentParser
from .matching import distance_km, search_sessions, suggest_replacements
from .models import ActivityProof, ActivityProofRequest, ActivityProofsResponse, AppNotification, BookingUpdateRequest, CMRHistoryPoint, ChatPost, ChatPostRequest, ChatResponse, ChatResultDecisionRequest, CommunityActivityPoint, CommunityJoinRequest, CommunityLeaderboardEntry, CommunityLeaderboardResponse, CommunityMapResponse, CommunityMembership, CommunityMembershipResponse, CreateGroupRequest, CreatedGroupResponse, ExploreSessionsResponse, Facility, FacilityListResponse, Feedback, FeedbackRequest, FollowRecord, GameCluster, GroupProposal, GroupViewResponse, IncomingRequestsResponse, JoinRequest, JoinRequestDecisionRequest, JoinRequestView, JoinRequestsResponse, LeaderboardEntry, LeaderboardResponse, MapNearbyGame, MapSport, MatchTeam, MyActivityResponse, MyGamesResponse, MyGroupsResponse, MyRequestsResponse, NotificationsResponse, ParseRequest, PastGame, PerformanceChatRequest, PerformanceChatResponse, Player, PlayerDensityPoint, PlayerDensityResponse, PlayerRating, ProfileGameSummary, ProfileImageUpdateRequest, ProfileImageUploadRequest, ProfileImageUploadResponse, ProfileUpdateRequest, PublicPlayerProfile, PublicPlayerProfilesResponse, ReplacementResponse, RetrievalTrace, SearchIntent, SearchResponse, Session, SocialComment, SocialCommentCreateRequest, SocialCommentsResponse, SocialFeedResponse, SocialLeaderboardEntry, SocialPost, SocialPostCreateRequest, SocialPostView, SocialSessionPlayer, Sport, SportyAvatarRequest, SportyAvatarResponse, TimePollOption, TimePollVoteRequest, baseline_rating_for_sport, cmr_from_legacy_rating, rating_for_sport
from .repository import create_repository
from .vector_search import VectorIndexer, VectorRetriever


load_dotenv()
logger = logging.getLogger("courtmate")

app = FastAPI(title="CourtMate API", version="0.1.0")
allowed_origins = [origin.strip() for origin in os.getenv("COURTMATE_ALLOWED_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]


@app.middleware("http")
async def add_request_timing(request, call_next):
    started = perf_counter()
    response = await call_next(request)
    elapsed_ms = round((perf_counter() - started) * 1000, 1)
    response.headers["X-Response-Time-Ms"] = str(elapsed_ms)
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.url.path.startswith("/v1/") and response.status_code < 400:
        _clear_read_view_cache()
    logger.info("%s %s %s %.1fms", request.method, request.url.path, response.status_code, elapsed_ms)
    return response
repository = create_repository()
intent_parser = GeminiIntentParser()
vector_retriever = VectorRetriever(repository)
vector_indexer = VectorIndexer(repository)
local_timezone = ZoneInfo(os.getenv("COURTMATE_TIMEZONE", "Asia/Kolkata"))
_geocode_cache: dict[str, tuple[float, float] | None] = {}
_social_feed_cache: dict[tuple[str, str, str], tuple[float, SocialFeedResponse]] = {}
_read_view_cache: dict[tuple[str, ...], tuple[float, object]] = {}
try:
    _social_feed_cache_ttl_seconds = max(0.0, float(os.getenv("COURTMATE_SOCIAL_FEED_CACHE_TTL_SECONDS", "15")))
except ValueError:
    _social_feed_cache_ttl_seconds = 15.0
try:
    _read_view_cache_ttl_seconds = max(0.0, float(os.getenv("COURTMATE_READ_CACHE_TTL_SECONDS", "12")))
except ValueError:
    _read_view_cache_ttl_seconds = 12.0
_fallback_area_coordinates = {
    "whitefield": (12.9698, 77.7499),
    "brookefield": (12.9665, 77.7168),
    "kadugodi": (13.0068, 77.7585),
    "varthur": (12.9408, 77.7460),
    "indiranagar": (12.9784, 77.6408),
    "koramangala": (12.9352, 77.6245),
}
_known_localities = tuple(_fallback_area_coordinates)


def _index_session_best_effort(session: Session) -> None:
    """Keep search enrichment optional so a model/index outage never blocks writes."""
    try:
        if session.status in {"completed", "cancelled"}:
            repository.delete_search_document(f"session__{session.id}")
        else:
            vector_indexer.upsert_session(session)
    except Exception:
        # The operational Firestore record remains valid; rebuild_vector_index
        # can repair an unavailable or newly-created vector index later.
        return


def _clear_social_feed_cache() -> None:
    _social_feed_cache.clear()


def _clear_read_view_cache() -> None:
    """Drop private read models after writes so interactive state is never stale."""
    _read_view_cache.clear()


def _read_view_cache_key(view: str, player_id: str, *parts: str) -> tuple[str, ...]:
    return view, player_id, *parts


def _get_cached_read_view(key: tuple[str, ...]):
    if _read_view_cache_ttl_seconds <= 0:
        return None
    cached = _read_view_cache.get(key)
    if not cached:
        return None
    created_at, response = cached
    if monotonic() - created_at >= _read_view_cache_ttl_seconds:
        _read_view_cache.pop(key, None)
        return None
    return response.model_copy(deep=True)


def _cache_read_view(key: tuple[str, ...], response):
    if _read_view_cache_ttl_seconds > 0:
        _read_view_cache[key] = (monotonic(), response.model_copy(deep=True))
    return response


def _social_feed_cache_key(player_id: str, feed: str, sport: Sport | None) -> tuple[str, str, str]:
    return player_id, feed, sport or "all"


def _get_cached_social_feed(key: tuple[str, str, str]) -> SocialFeedResponse | None:
    if _social_feed_cache_ttl_seconds <= 0:
        return None
    cached = _social_feed_cache.get(key)
    if not cached:
        return None
    created_at, response = cached
    if monotonic() - created_at >= _social_feed_cache_ttl_seconds:
        _social_feed_cache.pop(key, None)
        return None
    return response.model_copy(deep=True)


def _cache_social_feed(key: tuple[str, str, str], response: SocialFeedResponse) -> SocialFeedResponse:
    if _social_feed_cache_ttl_seconds > 0:
        _social_feed_cache[key] = (monotonic(), response.model_copy(deep=True))
    return response


def get_current_player(identity: AuthIdentity = Depends(get_current_identity)) -> Player:
    player = repository.get_player(identity.uid)
    if player:
        return player
    display_name = identity.display_name or (identity.email.split("@")[0] if identity.email else "CourtMate player")
    default_area = os.getenv("COURTMATE_DEFAULT_AREA", "Whitefield")
    coordinates = _geocode_area(default_area)
    return repository.save_player(Player(
        id=identity.uid,
        display_name=display_name,
        area=default_area,
        latitude=coordinates[0] if coordinates else None,
        longitude=coordinates[1] if coordinates else None,
        cmr_scale=10,
    ))


def _local_today() -> date:
    """Use the configured product timezone for every calendar-facing decision."""
    return datetime.now(local_timezone).date()


def _session_window(session: Session) -> tuple[datetime, datetime]:
    start = datetime.combine(session.session_date, session.start_time, tzinfo=local_timezone)
    end = datetime.combine(session.session_date, session.end_time, tzinfo=local_timezone)
    return start, end


def _tracked_reliability(player: Player, *, on_time_check_in_count: int, late_check_in_count: int, withdrawal_count: int, late_withdrawal_count: int) -> float:
    """Build a separate reliability signal from attendance and confirmed commitments."""
    check_in_count = on_time_check_in_count + late_check_in_count
    if check_in_count:
        # Four neutral check-ins prevent one arrival from swinging the score wildly.
        attendance_score = (3 + on_time_check_in_count + late_check_in_count * 0.5) / (4 + check_in_count)
    else:
        attendance_score = 0.75
    withdrawal_penalty = withdrawal_count * 0.04 + late_withdrawal_count * 0.08
    return round(max(0.3, min(1.0, attendance_score - withdrawal_penalty)), 3)


def _save_player_reliability_event(player: Player, *, on_time: bool | None = None, withdrew_late: bool | None = None) -> Player:
    on_time_count = player.on_time_check_in_count + (1 if on_time is True else 0)
    late_check_in_count = player.late_check_in_count + (1 if on_time is False else 0)
    withdrawal_count = player.withdrawal_count + (1 if withdrew_late is not None else 0)
    late_withdrawal_count = player.late_withdrawal_count + (1 if withdrew_late is True else 0)
    reliability = _tracked_reliability(
        player,
        on_time_check_in_count=on_time_count,
        late_check_in_count=late_check_in_count,
        withdrawal_count=withdrawal_count,
        late_withdrawal_count=late_withdrawal_count,
    )
    return repository.save_player(player.model_copy(update={
        "on_time_check_in_count": on_time_count,
        "late_check_in_count": late_check_in_count,
        "withdrawal_count": withdrawal_count,
        "late_withdrawal_count": late_withdrawal_count,
        "reliability": reliability,
    }))


def _refresh_session_status(session: Session, refresh_cmr: bool = True, persist: bool = True, index: bool = True) -> Session:
    if session.status in {"completed", "cancelled"}:
        return session
    # A window-based session has no actual playing time until its poll settles.
    if not session.time_finalized:
        return session
    now = datetime.now(local_timezone)
    start, end = _session_window(session)
    next_status = "awaiting_feedback" if now >= end else "in_progress" if now >= start else session.status
    if next_status != session.status:
        updates: dict[str, object] = {"status": next_status}
        session = session.model_copy(update=updates)
        if persist:
            repository.save_session(session)
        if index and persist:
            _index_session_best_effort(session)
    return session


def _get_session(session_id: str) -> Session | None:
    session = repository.get_session(session_id)
    return _refresh_session_status(session, refresh_cmr=False, index=False) if session else None


def _refresh_all_session_statuses(persist: bool = True) -> list[Session]:
    sessions = repository.list_sessions()
    # Discovery, feeds, and activity pages are read paths. Persist only the
    # lightweight status transition; never make them wait for an embedding
    # request or full CMR rebuild just because a scheduled game crossed its
    # start/end time.
    return [_refresh_session_status(session, refresh_cmr=False, persist=persist, index=False) for session in sessions]


def _require_active_session(session: Session) -> None:
    if session.status == "cancelled":
        raise HTTPException(status_code=409, detail="Cancelled games do not accept new activity")


def _require_joinable_session(session: Session) -> None:
    """Keep completed game history stable while leaving post-game chat available."""
    _require_active_session(session)
    if session.status in {"awaiting_feedback", "completed"}:
        raise HTTPException(status_code=409, detail="This completed game is closed to new players")


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


def _parse_intent(query: str, sport: Sport | None = None, player: Player | None = None, context: str | None = None) -> SearchIntent:
    intent = intent_parser.parse(query, sport, context)
    lowered_query = f"{query} {context or ''}".lower()
    locality_match = re.search(r"\b(?:near|around|in)\s+(.+?)(?=\s+(?:this|next|on|at|for|with|and|today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|weekday|weekend|morning|afternoon|evening|tonight|skill|level|rating|cmr)\b|$)", lowered_query)
    requested_locality = locality_match.group(1).strip(" ,.") if locality_match else ""
    has_explicit_locality = bool(
        requested_locality
        and requested_locality not in {"me", "here", "my location", "my area", "my locality"}
        and not requested_locality.startswith("my ")
        and not requested_locality.startswith("the ")
    )
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
    return _parse_intent(request.query, request.sport, context=request.context)


@app.get("/v1/me", response_model=Player)
def me(player: Player = Depends(get_current_player)) -> Player:
    return player


@app.get("/v1/players/recommended", response_model=PublicPlayerProfilesResponse)
def recommended_players(player: Player = Depends(get_current_player)) -> PublicPlayerProfilesResponse:
    cache_key = _read_view_cache_key("recommended_players", player.id)
    cached = _get_cached_read_view(cache_key)
    if cached is not None:
        return cached
    following_ids = {record.following_id for record in repository.list_following(player.id)}
    player_sports = set(player.cmr_ratings) | set(player.sport_ratings)
    all_sessions = repository.list_sessions()
    player_sessions = [session for session in all_sessions if player.id in session.confirmed_player_ids]
    player_session_ids = {session.id for session in player_sessions}
    candidates = []
    for candidate in repository.list_players():
        if candidate.id == player.id or candidate.id in following_ids or candidate.is_profile_private:
            continue
        candidate_sports = set(candidate.cmr_ratings) | set(candidate.sport_ratings)
        candidate_sessions = [session for session in all_sessions if candidate.id in session.confirmed_player_ids]
        shared_sports = len(player_sports & candidate_sports)
        shared_area = bool(player.area.strip() and candidate.area.strip() and player.area.strip().lower() == candidate.area.strip().lower())
        shared_sessions = len(player_session_ids & {session.id for session in candidate_sessions})
        activity = len(candidate_sessions)
        score = (5 if shared_area else 0) + shared_sports * 2 + (3 if shared_sessions else 0) + min(activity, 5) * .1
        candidates.append((score, candidate.display_name.lower(), candidate))
    candidates.sort(key=lambda item: (-item[0], item[1]))
    profiles = []
    viewer_following_ids = {record.following_id for record in repository.list_following(player.id)}
    for _, _, candidate in candidates[:8]:
        mutual_ids = viewer_following_ids & {record.following_id for record in repository.list_following(candidate.id)}
        mutual_names = sorted(
            (mutual.display_name for mutual in repository.list_players() if mutual.id in mutual_ids),
            key=str.lower,
        )[:3]
        profiles.append(_public_profile(candidate, player.id, all_sessions).model_copy(update={"mutual_connections": mutual_names}))
    return _cache_read_view(cache_key, PublicPlayerProfilesResponse(profiles=profiles))


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
    if repository.is_following(player.id, target.id):
        return _public_profile(target, player.id)
    if not repository.is_follow_request_pending(player.id, target.id):
        repository.save_follow(FollowRecord(id=f"{player.id}_{target.id}", follower_id=player.id, following_id=target.id, status="pending", created_at=datetime.now(timezone.utc)))
        _clear_social_feed_cache()
        try:
            repository.save_notification(AppNotification(
                id=f"follow-{player.id}-{target.id}",
                player_id=target.id,
                kind="follow",
                title="Follow request",
                message=f"{player.display_name} wants to follow you.",
                session_id="",
                actor_id=player.id,
                created_at=datetime.now(timezone.utc),
            ))
        except Exception:
            pass
    return _public_profile(target, player.id)


@app.post("/v1/me/follow-requests/{notification_id}", response_model=PublicPlayerProfile)
def decide_follow_request(notification_id: str, decision: JoinRequestDecisionRequest, player: Player = Depends(get_current_player)) -> PublicPlayerProfile:
    notification = next((item for item in repository.list_notifications_for_player(player.id) if item.id == notification_id and item.kind == "follow"), None)
    if not notification or not notification.actor_id:
        raise HTTPException(status_code=404, detail="Follow request not found")
    requester = repository.get_player(notification.actor_id)
    if not requester:
        raise HTTPException(status_code=404, detail="Requester not found")
    if decision.status == "approved":
        repository.save_follow(FollowRecord(id=f"{requester.id}_{player.id}", follower_id=requester.id, following_id=player.id, status="accepted", created_at=datetime.now(timezone.utc)))
        _clear_social_feed_cache()
    else:
        repository.delete_follow(requester.id, player.id)
    repository.mark_notification_read(notification.id, player.id)
    return _public_profile(requester, player.id)


@app.post("/v1/players/{player_id}/unfollow", response_model=PublicPlayerProfile)
def unfollow_player(player_id: str, player: Player = Depends(get_current_player)) -> PublicPlayerProfile:
    target = repository.get_player(player_id)
    if not target:
        raise HTTPException(status_code=404, detail="Player not found")
    repository.delete_follow(player.id, target.id)
    _clear_social_feed_cache()
    return _public_profile(target, player.id)


def _social_profiles(player: Player, following: bool) -> PublicPlayerProfilesResponse:
    records = repository.list_following(player.id) if following else repository.list_followers(player.id)
    if following:
        records += repository.list_pending_following(player.id)
    sessions = repository.list_sessions()
    profiles = []
    for record in records:
        target_id = record.following_id if following else record.follower_id
        target = repository.get_player(target_id)
        if target:
            profiles.append(_public_profile(target, player.id, sessions))
    profiles.sort(key=lambda profile: profile.display_name.lower())
    return PublicPlayerProfilesResponse(profiles=profiles)


@app.get("/v1/me/following", response_model=PublicPlayerProfilesResponse)
def my_following(player: Player = Depends(get_current_player)) -> PublicPlayerProfilesResponse:
    return _social_profiles(player, following=True)


@app.get("/v1/me/followers", response_model=PublicPlayerProfilesResponse)
def my_followers(player: Player = Depends(get_current_player)) -> PublicPlayerProfilesResponse:
    return _social_profiles(player, following=False)


@app.get("/v1/social/feed", response_model=SocialFeedResponse)
def social_feed(feed: str = "all", sport: Sport | None = None, player: Player = Depends(get_current_player)) -> SocialFeedResponse:
    if feed not in {"all", "following", "personal"}:
        raise HTTPException(status_code=422, detail="Feed must be all, following, or personal")
    cache_key = _social_feed_cache_key(player.id, feed, sport)
    cached = _get_cached_social_feed(cache_key)
    if cached is not None:
        return cached
    sessions = _refresh_all_session_statuses()
    sessions_by_id = {session.id: session for session in sessions}
    players_by_id = {candidate.id: candidate for candidate in repository.list_players()}
    following_ids = {record.following_id for record in repository.list_following(player.id)}
    feed_posts = []
    for post in repository.list_social_posts():
        # The former session-activity cards were shared group operations. Keep
        # them out of the feed so every visible post has a player author.
        if _session_id_from_activity_post_id(post.id):
            continue
        session = sessions_by_id.get(post.session_id) if post.session_id else None
        if session and not _session_visible_to_player(session, player, following_ids):
            continue
        if feed == "personal" and post.player_id != player.id:
            continue
        if feed == "following" and post.player_id not in following_ids:
            continue
        if sport and post.sport != sport:
            continue
        feed_posts.append(_social_post_view(post, player.id, session, players_by_id))
    feed_posts.sort(key=lambda item: item.created_at, reverse=True)
    return _cache_social_feed(cache_key, SocialFeedResponse(posts=feed_posts[:50]))


@app.post("/v1/sessions/{session_id}/social-activity", response_model=SocialPostView)
def publish_session_social_activity(session_id: str, player: Player = Depends(get_current_player)) -> SocialPostView:
    _member_session(session_id, player)
    raise HTTPException(status_code=410, detail="Completed games are shared as individual player posts")


def _session_visible_to_player(session: Session, player: Player, following_ids: set[str] | None = None) -> bool:
    """Keep private game activity out of discovery while preserving member access."""
    if session.organizer_id == player.id or player.id in session.confirmed_player_ids:
        return True
    if session.visibility == "public":
        return True
    if session.visibility == "followers":
        followed = following_ids if following_ids is not None else {record.following_id for record in repository.list_following(player.id)}
        return session.organizer_id in followed
    return False


def _map_session_visible_to_player(session: Session, visibility_filter: str, following_ids: set[str]) -> bool:
    """Show public games by default and follower games only to direct connections."""
    if session.visibility == "private":
        return False
    is_connection_game = session.organizer_id in following_ids
    if visibility_filter == "public":
        return session.visibility == "public"
    if visibility_filter == "friends":
        return is_connection_game
    return session.visibility == "public" or (session.visibility == "followers" and is_connection_game)


@app.post("/v1/social/posts", response_model=SocialPostView)
def create_social_post(request: SocialPostCreateRequest, player: Player = Depends(get_current_player)) -> SocialPostView:
    caption = request.caption.strip()
    if not caption:
        raise HTTPException(status_code=422, detail="Post caption is required")
    media_urls = list(dict.fromkeys(
        value.strip()
        for value in [request.media_url, *request.media_urls]
        if value and value.strip()
    ))
    if len(media_urls) > 6:
        raise HTTPException(status_code=422, detail="Attach no more than 6 photos")
    inline_media_sizes = [len(value.encode("utf-8")) for value in media_urls if value.lower().startswith("data:image/")]
    if any(size > _SOCIAL_INLINE_MEDIA_PER_URL_LIMIT for size in inline_media_sizes) or sum(inline_media_sizes) > _SOCIAL_INLINE_MEDIA_TOTAL_LIMIT:
        raise HTTPException(status_code=422, detail="One or more photos are too large. Re-upload the photos or attach fewer images.")
    if media_urls and not request.media_type:
        raise HTTPException(status_code=422, detail="Media type is required with an attachment")
    if request.media_urls and request.media_type != "image":
        raise HTTPException(status_code=422, detail="Photo attachments must be images")
    if media_urls and not request.session_id:
        raise HTTPException(status_code=422, detail="Photos and videos must be attached to a game")
    if request.session_id:
        session = _get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Tagged game not found")
        if session.sport != request.sport:
            raise HTTPException(status_code=422, detail="Post sport must match the tagged game")
        if player.id != session.organizer_id and player.id not in session.confirmed_player_ids:
            raise HTTPException(status_code=403, detail="Only players in this game can tag it in a post")
        if session.status == "cancelled":
            raise HTTPException(status_code=409, detail="Cancelled games cannot be posted about")
    post = repository.save_social_post(SocialPost(
        id=f"social-{uuid4().hex}",
        player_id=player.id,
        player_display_name=player.display_name,
        profile_image_url=player.profile_image_url,
        sport=request.sport,
        session_id=request.session_id,
        caption=caption,
        media_url=media_urls[0] if media_urls else None,
        media_type=request.media_type,
        media_urls=media_urls,
        created_at=datetime.now(timezone.utc),
    ))
    _clear_social_feed_cache()
    return _social_post_view(post, player.id)


@app.delete("/v1/social/posts/{post_id}")
def delete_social_post(post_id: str, player: Player = Depends(get_current_player)) -> dict[str, bool]:
    if not repository.delete_social_post(post_id, player.id):
        raise HTTPException(status_code=404, detail="Social post not found")
    _clear_social_feed_cache()
    return {"deleted": True}


@app.post("/v1/social/posts/{post_id}/like", response_model=SocialPostView)
def toggle_social_like(post_id: str, player: Player = Depends(get_current_player)) -> SocialPostView:
    post, session = _ensure_social_target(post_id, player)
    updated = repository.toggle_social_like(post.id, player.id)
    if not updated:
        raise HTTPException(status_code=404, detail="Social post not found")
    _clear_social_feed_cache()
    if session and _session_id_from_activity_post_id(post_id):
        players_by_id = {candidate.id: candidate for candidate in repository.list_players()}
        return _session_social_view(session, players_by_id, player.id)
    return _social_post_view(updated, player.id, session)


@app.get("/v1/social/posts/{post_id}/comments", response_model=SocialCommentsResponse)
def list_social_comments(post_id: str, player: Player = Depends(get_current_player)) -> SocialCommentsResponse:
    post, session = _social_target(post_id, player)
    if not post or (session and not _session_visible_to_player(session, player)):
        raise HTTPException(status_code=404, detail="Social post not found")
    return SocialCommentsResponse(comments=repository.list_social_comments(post_id))


@app.post("/v1/social/posts/{post_id}/comments", response_model=SocialComment)
def create_social_comment(post_id: str, request: SocialCommentCreateRequest, player: Player = Depends(get_current_player)) -> SocialComment:
    _ensure_social_target(post_id, player)
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Comment is required")
    comment = repository.save_social_comment(SocialComment(
        id=f"comment-{uuid4().hex}",
        post_id=post_id,
        player_id=player.id,
        player_display_name=player.display_name,
        profile_image_url=player.profile_image_url,
        message=message,
        created_at=datetime.now(timezone.utc),
    ))
    _clear_social_feed_cache()
    return comment


@app.post("/v1/social/posts/{post_id}/share", response_model=SocialPostView)
def share_social_post(post_id: str, player: Player = Depends(get_current_player)) -> SocialPostView:
    post, session = _ensure_social_target(post_id, player)
    updated = repository.record_social_share(post.id)
    if not updated:
        raise HTTPException(status_code=404, detail="Social post not found")
    _clear_social_feed_cache()
    if session and _session_id_from_activity_post_id(post_id):
        players_by_id = {candidate.id: candidate for candidate in repository.list_players()}
        return _session_social_view(session, players_by_id, player.id)
    return _social_post_view(updated, player.id, session)


@app.post("/v1/me/profile", response_model=Player)
def update_profile(request: ProfileUpdateRequest, player: Player = Depends(get_current_player)) -> Player:
    updates = request.model_dump(exclude_none=True, exclude={"primary_sport", "sport", "self_assessed_level", "skill_level", "skill_rating"})
    if request.area and request.latitude is None and request.longitude is None:
        coordinates = _geocode_area(request.area)
        if coordinates:
            updates.update({"latitude": coordinates[0], "longitude": coordinates[1]})
    updated = player.model_copy(update=updates)
    if request.primary_sport:
        updated = updated.model_copy(update={"primary_sport": request.primary_sport})
    if request.sport:
        self_assessed_level = request.self_assessed_level
        legacy_cmr = None
        if self_assessed_level is None and request.skill_rating is not None:
            # Temporary compatibility for older clients that posted 1-8.
            legacy_cmr = cmr_from_legacy_rating(request.skill_rating)
            self_assessed_level = round(legacy_cmr)
        if self_assessed_level is None and request.skill_level:
            self_assessed_level = {"beginner": 2, "intermediate": 4, "advanced": 6}[request.skill_level]
        if self_assessed_level is not None:
            games_played = updated.cmr_game_counts.get(request.sport, 0)
            if games_played:
                raise HTTPException(status_code=409, detail="CMR is based on confirmed competitive games and cannot be reset")
            level = legacy_cmr if legacy_cmr is not None else float(self_assessed_level)
            updated = updated.model_copy(update={
                "primary_sport": updated.primary_sport or request.sport,
                "self_assessed_levels": {**updated.self_assessed_levels, request.sport: int(self_assessed_level)},
                "cmr_starting_ratings": {**updated.cmr_starting_ratings, request.sport: level},
                "cmr_ratings": {**updated.cmr_ratings, request.sport: level},
                "cmr_scale": 10,
            })
        if request.skill_rating is not None:
            # Preserve the legacy fields for older mobile clients while the
            # canonical CMR and onboarding values above power all matching.
            updated = updated.model_copy(update={
                "sport_ratings": {**updated.sport_ratings, request.sport: request.skill_rating},
                "rating_sources": {**updated.rating_sources, request.sport: "self_reported"},
            })
        if request.skill_level:
            updated = updated.model_copy(update={
                "skill_levels": {**updated.skill_levels, request.sport: request.skill_level},
            })
    return repository.save_player(updated)


def _profile_storage_client():
    """Return a GCS client using the application's default credentials."""
    from google.cloud import storage

    return storage.Client(project=os.getenv("GOOGLE_CLOUD_PROJECT"))


def _profile_bucket_name() -> str:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    return os.getenv("COURTMATE_PROFILE_BUCKET") or os.getenv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET") or f"{project}.firebasestorage.app"


def _generate_profile_upload_url(blob, content_type: str) -> str:
    """Generate a signed URL using a key or IAM signBlob, depending on ADC."""
    credentials = blob.bucket._client._credentials
    signing_options = {}
    if not hasattr(credentials, "sign_bytes"):
        from google.auth.transport.requests import Request as GoogleAuthRequest

        service_account_email = os.getenv("COURTMATE_SIGNING_SERVICE_ACCOUNT") or getattr(credentials, "service_account_email", None)
        if not service_account_email:
            raise RuntimeError("Set COURTMATE_SIGNING_SERVICE_ACCOUNT for signed GCS URLs")
        credentials.refresh(GoogleAuthRequest())
        signing_options = {"service_account_email": service_account_email, "access_token": credentials.token}
    return blob.generate_signed_url(
        version="v4",
        expiration=timedelta(minutes=10),
        method="PUT",
        content_type=content_type,
        **signing_options,
    )


@app.post("/v1/me/profile-image/upload-url", response_model=ProfileImageUploadResponse)
def create_profile_image_upload_url(request: ProfileImageUploadRequest, player: Player = Depends(get_current_player)) -> ProfileImageUploadResponse:
    bucket_name = _profile_bucket_name()
    extension = "jpg" if request.content_type == "image/jpeg" else request.content_type.split("/", 1)[1]
    object_name = f"profile-images/{player.id}/{uuid4()}.{extension}"
    try:
        bucket = _profile_storage_client().bucket(bucket_name)
        blob = bucket.blob(object_name)
        upload_url = _generate_profile_upload_url(blob, request.content_type)
    except ImportError as error:
        raise HTTPException(status_code=500, detail="Install google-cloud-storage to upload profile pictures") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Could not create a profile picture upload URL") from error
    image_url = f"https://storage.googleapis.com/{bucket_name}/{quote(object_name, safe='/')}"
    return ProfileImageUploadResponse(upload_url=upload_url, image_url=image_url, object_name=object_name, expires_in=600)


_SOCIAL_INLINE_MEDIA_PER_URL_LIMIT = 120 * 1024
_SOCIAL_INLINE_MEDIA_TOTAL_LIMIT = 700 * 1024


def _optimize_image_fallback(
    image_bytes: bytes,
    max_dim: int = 400,
    quality: int = 80,
    max_data_uri_bytes: int = 192 * 1024,
) -> str | None:
    """Produce a bounded data URI only when Cloud Storage is temporarily unavailable."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_bytes))
        img = img.convert("RGB")
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=quality)
        data_uri = f"data:image/webp;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"
    except Exception:
        data_uri = f"data:image/jpeg;base64,{base64.b64encode(image_bytes).decode('ascii')}"
    return data_uri if len(data_uri.encode("utf-8")) <= max_data_uri_bytes else None


@app.post("/v1/me/profile-image/upload", response_model=Player)
async def upload_profile_image(request: FastAPIRequest, player: Player = Depends(get_current_player)) -> Player:
    """Upload profile bytes through the API so browsers do not encounter Storage CORS issues."""
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=422, detail="Profile photo must be JPG, PNG, or WebP")
    content_length = int(request.headers.get("content-length", "0") or 0)
    if content_length > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Profile photos must be smaller than 5 MB")
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=422, detail="Choose a profile photo")
    if len(image_bytes) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Profile photos must be smaller than 5 MB")

    bucket_name = _profile_bucket_name()
    extension = "jpg" if content_type == "image/jpeg" else content_type.split("/", 1)[1]
    object_name = f"profile-images/{player.id}/{uuid4()}.{extension}"
    download_token = uuid4().hex
    image_url = None
    try:
        blob = _profile_storage_client().bucket(bucket_name).blob(object_name)
        blob.metadata = {"firebaseStorageDownloadTokens": download_token}
        blob.upload_from_string(image_bytes, content_type=content_type)
        image_url = (
            f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/"
            f"{quote(object_name, safe='')}?alt=media&token={download_token}"
        )
    except Exception as error:
        logger.warning("Profile photo storage upload failed (%s); using data URL fallback", error)
        image_url = _optimize_image_fallback(image_bytes, max_dim=400, quality=80)
        if not image_url:
            raise HTTPException(status_code=503, detail="Profile photo storage is unavailable. Please try again shortly.")

    return repository.save_player(player.model_copy(update={"profile_image_url": image_url}))


@app.post("/v1/social/media/upload")
async def upload_social_media(request: FastAPIRequest, player: Player = Depends(get_current_player)) -> dict[str, str]:
    """Upload post and rally photos through the API to avoid browser Storage CORS restrictions."""
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=422, detail="Photo must be JPG, PNG, or WebP")
    content_length = int(request.headers.get("content-length", "0") or 0)
    if content_length > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Photo must be smaller than 8 MB")
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=422, detail="Choose a photo to upload")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Photo must be smaller than 8 MB")

    bucket_name = _profile_bucket_name()
    extension = "jpg" if content_type == "image/jpeg" else content_type.split("/", 1)[1]
    object_name = f"social-posts/{player.id}/{uuid4()}.{extension}"
    download_token = uuid4().hex
    media_url = None
    try:
        blob = _profile_storage_client().bucket(bucket_name).blob(object_name)
        blob.metadata = {"firebaseStorageDownloadTokens": download_token}
        blob.upload_from_string(image_bytes, content_type=content_type)
        media_url = (
            f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/"
            f"{quote(object_name, safe='')}?alt=media&token={download_token}"
        )
    except Exception as error:
        logger.warning("Social media storage upload failed (%s); using data URL fallback", error)
        media_url = _optimize_image_fallback(image_bytes, max_dim=800, quality=82, max_data_uri_bytes=_SOCIAL_INLINE_MEDIA_PER_URL_LIMIT)
        if not media_url:
            raise HTTPException(status_code=503, detail="Photo storage is unavailable. Please try again shortly.")

    return {"media_url": media_url}


@app.post("/v1/me/sporty-avatar-options", response_model=SportyAvatarResponse)
def create_sporty_avatar_options(request: SportyAvatarRequest, player: Player = Depends(get_current_player)) -> SportyAvatarResponse:
    """Generate preview-only sport avatars from the user's stored profile image."""
    source = urlparse(request.source_image_url)
    if source.scheme != "https" or source.hostname not in {"storage.googleapis.com", "firebasestorage.googleapis.com"}:
        raise HTTPException(status_code=422, detail="Choose a profile photo stored in CourtMate")
    try:
        with urlopen(Request(request.source_image_url, headers={"Accept": "image/*"}), timeout=8) as response:
            mime_type = response.headers.get_content_type()
            image_bytes = response.read(8 * 1024 * 1024 + 1)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Could not read your profile photo") from error
    if mime_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=422, detail="Profile photo must be JPG, PNG, or WebP")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Profile photo is too large")
    try:
        return SportyAvatarResponse(options=intent_parser.generate_sporty_avatar(image_bytes, mime_type, request.sport))
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Gemini could not create avatar options right now") from error


@app.post("/v1/me/profile-image", response_model=Player)
def update_profile_image(request: ProfileImageUpdateRequest, player: Player = Depends(get_current_player)) -> Player:
    if request.profile_image_url is None:
        return repository.save_player(player.model_copy(update={"profile_image_url": None}))

    if request.profile_image_url.startswith("/avatars/") and request.profile_image_url.endswith(".svg"):
        return repository.save_player(player.model_copy(update={"profile_image_url": request.profile_image_url}))

    if request.profile_image_url.startswith("data:image/"):
        return repository.save_player(player.model_copy(update={"profile_image_url": request.profile_image_url}))

    parsed_url = urlparse(request.profile_image_url)
    is_valid_host = parsed_url.hostname in {"storage.googleapis.com", "firebasestorage.googleapis.com", "lh3.googleusercontent.com"}
    has_profile_path = (
        f"profiles/{player.id}/" in parsed_url.path
        or f"profiles%2F{player.id}" in parsed_url.path
        or f"profiles%2F{quote(player.id, safe='')}" in parsed_url.path
        or "/o/profile-images" in parsed_url.path
        or "/profiles/" in parsed_url.path
    )
    if not (is_valid_host and has_profile_path):
        project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
        if not (is_valid_host and (project in (parsed_url.hostname or "") or project in parsed_url.path)):
            raise HTTPException(status_code=422, detail="Profile image must be uploaded to the CourtMate profile bucket")
    return repository.save_player(player.model_copy(update={"profile_image_url": request.profile_image_url}))


def _profile_activity(player_id: str, sessions: list[Session] | None = None) -> tuple[list[ProfileGameSummary], dict[str, int]]:
    today = _local_today()
    window_start = today - timedelta(days=83)
    sessions = [session for session in (sessions if sessions is not None else repository.list_sessions()) if player_id in session.confirmed_player_ids and session.status != "cancelled"]
    played_sessions = [session for session in sessions if session.session_date < today or session.status == "completed"]
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


def _profile_weekly_streak(player_id: str, sessions: list[Session], today: date | None = None) -> tuple[int, bool]:
    """Count consecutive Monday-Sunday weeks with at least one completed game."""
    current_date = today or _local_today()
    current_week = current_date - timedelta(days=current_date.weekday())
    completed_weeks = {
        session.session_date - timedelta(days=session.session_date.weekday())
        for session in sessions
        if player_id in session.confirmed_player_ids
        and session.status == "completed"
        and session.session_date <= current_date
    }
    streak = 0
    week = current_week
    while week in completed_weeks:
        streak += 1
        week -= timedelta(days=7)
    return streak, current_week in completed_weeks


def _public_profile(
    player: Player,
    viewer_id: str | None = None,
    sessions: list[Session] | None = None,
    include_relations: bool = True,
    include_activity: bool = True,
    followers_count: int | None = None,
    following_count: int | None = None,
    is_following: bool | None = None,
    follow_request_pending: bool | None = None,
    follows_you: bool | None = None,
) -> PublicPlayerProfile:
    private_view = bool(
        player.is_profile_private
        and viewer_id
        and viewer_id != player.id
        and not repository.is_following(viewer_id, player.id)
    )
    if include_activity:
        profile_sessions = sessions if sessions is not None else repository.list_sessions()
        recent_games, activity_by_date = _profile_activity(player.id, profile_sessions)
        weekly_streak, weekly_streak_active = _profile_weekly_streak(player.id, profile_sessions)
    else:
        recent_games, activity_by_date = [], {}
        weekly_streak, weekly_streak_active = 0, False

    if include_relations:
        resolved_followers_count = followers_count if followers_count is not None else len(repository.list_followers(player.id))
        resolved_following_count = following_count if following_count is not None else len(repository.list_following(player.id))
        resolved_is_following = is_following if is_following is not None else bool(viewer_id and repository.is_following(viewer_id, player.id))
        resolved_follow_request_pending = follow_request_pending if follow_request_pending is not None else bool(viewer_id and repository.is_follow_request_pending(viewer_id, player.id))
        resolved_follows_you = follows_you if follows_you is not None else bool(viewer_id and repository.is_following(player.id, viewer_id))
    else:
        resolved_followers_count = followers_count or 0
        resolved_following_count = following_count or 0
        resolved_is_following = bool(is_following)
        resolved_follow_request_pending = bool(follow_request_pending)
        resolved_follows_you = bool(follows_you)

    if private_view:
        bio = ""
        area = ""
        sport_ratings = {}
        rating_sources = {}
        cmr_ratings = {}
        cmr_game_counts = {}
        cmr_confidence = {}
        recent_games = []
        activity_by_date = {}
        weekly_streak = 0
        weekly_streak_active = False
        reliability = 0.75
        on_time_check_in_count = 0
        late_check_in_count = 0
        withdrawal_count = 0
        late_withdrawal_count = 0
        community_score = None
        community_rating_count = 0
        community_scores = {}
        community_rating_counts = {}
    else:
        bio = player.bio
        area = player.area
        sport_ratings = player.sport_ratings
        rating_sources = player.rating_sources
        cmr_ratings = player.cmr_ratings
        cmr_game_counts = player.cmr_game_counts
        cmr_confidence = player.cmr_confidence
        reliability = player.reliability
        on_time_check_in_count = player.on_time_check_in_count
        late_check_in_count = player.late_check_in_count
        withdrawal_count = player.withdrawal_count
        late_withdrawal_count = player.late_withdrawal_count
        community_score = player.community_score
        community_rating_count = player.community_rating_count
        community_scores = player.community_scores
        community_rating_counts = player.community_rating_counts

    return PublicPlayerProfile(
        id=player.id,
        display_name=player.display_name,
        bio=bio,
        is_profile_private=player.is_profile_private,
        profile_image_url=player.profile_image_url,
        area=area,
        dupr_rating=player.dupr_rating,
        rating_source=player.rating_source,
        rating_confidence=player.rating_confidence,
        sport_ratings=sport_ratings,
        rating_sources=rating_sources,
        style=player.style,
        reliability=reliability,
        on_time_check_in_count=on_time_check_in_count,
        late_check_in_count=late_check_in_count,
        withdrawal_count=withdrawal_count,
        late_withdrawal_count=late_withdrawal_count,
        community_score=community_score,
        community_rating_count=community_rating_count,
        community_scores=community_scores,
        community_rating_counts=community_rating_counts,
        cmr_ratings=cmr_ratings,
        cmr_game_counts=cmr_game_counts,
        cmr_confidence=cmr_confidence,
        followers_count=resolved_followers_count,
        following_count=resolved_following_count,
        is_following=resolved_is_following,
        follow_request_pending=resolved_follow_request_pending,
        follows_you=resolved_follows_you,
        recent_games=recent_games,
        activity_by_date=activity_by_date,
        weekly_streak=weekly_streak,
        weekly_streak_active=weekly_streak_active,
    )


def _session_cmr_rating(candidate: Player, sport: str) -> float | None:
    rating = rating_for_sport(candidate, sport)
    return round(rating, 2) if rating is not None else None


def _session_cmr_delta(candidate: Player, session: Session) -> float | None:
    point = next((item for item in candidate.cmr_history.get(session.sport, []) if item.session_id == session.id), None)
    return round(point.delta, 1) if point and point.delta is not None else None


def _session_leaderboard(session: Session, players_by_id: dict[str, Player]) -> list[SocialLeaderboardEntry]:
    players = [players_by_id[player_id] for player_id in session.confirmed_player_ids if player_id in players_by_id]
    ranked_players = sorted(
        players,
        key=lambda candidate: (
            -(_session_cmr_rating(candidate, session.sport) or -1),
            -candidate.reliability,
            candidate.display_name.lower(),
        ),
    )
    return [
        SocialLeaderboardEntry(
            rank=index,
            player_id=candidate.id,
            display_name=candidate.display_name,
            profile_image_url=candidate.profile_image_url,
            cmr_rating=_session_cmr_rating(candidate, session.sport),
            cmr_delta=_session_cmr_delta(candidate, session),
        )
        for index, candidate in enumerate(ranked_players, start=1)
    ]


def _social_post_view(post: SocialPost, viewer_id: str, session: Session | None = None, players_by_id: dict[str, Player] | None = None) -> SocialPostView:
    session = session if session is not None else repository.get_session(post.session_id) if post.session_id else None
    players_by_id = players_by_id if players_by_id is not None else {candidate.id: candidate for candidate in repository.list_players()} if session else {}
    post_player = players_by_id.get(post.player_id)
    return SocialPostView(
        id=post.id,
        player_id=post.player_id,
        player_display_name=post.player_display_name,
        profile_image_url=post.profile_image_url,
        sport=post.sport,
        session_id=post.session_id,
        session_name=session.group_name if session else None,
        session_date=session.session_date if session else None,
        session_area=session.area if session else None,
        player_cmr=_session_cmr_rating(post_player, session.sport) if post_player and session else None,
        player_cmr_delta=_session_cmr_delta(post_player, session) if post_player and session else None,
        caption=post.caption,
        media_url=post.media_url,
        media_type=post.media_type,
        media_urls=post.media_urls or ([post.media_url] if post.media_url else []),
        like_count=len(post.liked_by),
        comment_count=post.comment_count,
        share_count=post.share_count,
        liked_by_me=viewer_id in post.liked_by,
        created_at=post.created_at,
        session_leaderboard=_session_leaderboard(session, players_by_id) if session else [],
    )


def _session_activity_post_id(session_id: str) -> str:
    return f"session-activity-{session_id}"


def _session_id_from_activity_post_id(post_id: str) -> str | None:
    prefix = "session-activity-"
    return post_id[len(prefix):] if post_id.startswith(prefix) else None


def _virtual_session_social_post(session: Session, players_by_id: dict[str, Player] | None = None) -> SocialPost:
    players_by_id = players_by_id or {candidate.id: candidate for candidate in repository.list_players()}
    organizer = players_by_id.get(session.organizer_id)
    organizer_name = organizer.display_name if organizer else "CourtMate player"
    return SocialPost(
        id=_session_activity_post_id(session.id),
        player_id=session.organizer_id,
        player_display_name=organizer_name,
        profile_image_url=organizer.profile_image_url if organizer else None,
        sport=session.sport,
        session_id=session.id,
        caption=f"{organizer_name} is playing in {session.group_name}.",
        created_at=datetime.combine(session.session_date, session.start_time, tzinfo=local_timezone),
    )


def _social_target(post_id: str, player: Player) -> tuple[SocialPost | None, Session | None]:
    post = repository.get_social_post(post_id)
    if post:
        session = _get_session(post.session_id) if post.session_id else None
        if session and not _session_visible_to_player(session, player):
            return None, None
        return post, session

    session_id = _session_id_from_activity_post_id(post_id)
    if not session_id:
        return None, None
    session = _get_session(session_id)
    if not session or not _session_visible_to_player(session, player):
        return None, None
    return _virtual_session_social_post(session), session


def _ensure_social_target(post_id: str, player: Player) -> tuple[SocialPost, Session | None]:
    post, session = _social_target(post_id, player)
    if not post:
        raise HTTPException(status_code=404, detail="Social post not found")
    if repository.get_social_post(post_id) is None:
        post = repository.save_social_post(post)
    return post, session


def _session_social_view(session: Session, players_by_id: dict[str, Player] | None = None, viewer_id: str | None = None, media_posts: list[SocialPost] | None = None) -> SocialPostView:
    players_by_id = players_by_id or {candidate.id: candidate for candidate in repository.list_players()}
    participants = [players_by_id.get(player_id) for player_id in session.confirmed_player_ids]
    players = [candidate for candidate in participants if candidate]
    leaderboard = _session_leaderboard(session, players_by_id)
    organizer = players_by_id.get(session.organizer_id) or (players[0] if players else None)
    organizer_name = organizer.display_name if organizer else "CourtMate player"
    activity_post_id = _session_activity_post_id(session.id)
    engagement = repository.get_social_post(activity_post_id)
    media_posts = sorted(media_posts or [], key=lambda post: post.created_at)
    media_urls = [post.media_url for post in media_posts if post.media_url][:6]
    return SocialPostView(
        id=activity_post_id,
        player_id=organizer.id if organizer else session.organizer_id,
        player_display_name=organizer_name,
        profile_image_url=organizer.profile_image_url if organizer else None,
        sport=session.sport,
        session_id=session.id,
        session_name=session.group_name,
        session_date=session.session_date,
        session_area=session.area,
        caption=f"{session.group_name} is in the books. See how the line-up moved.",
        media_url=media_urls[0] if media_urls else None,
        media_type=media_posts[0].media_type if media_urls else None,
        media_urls=media_urls,
        # New activities sort by publication time. Older sessions without this
        # field retain a stable scheduled-start fallback.
        created_at=session.social_activity_published_at or datetime.combine(
            session.session_date,
            session.start_time,
            tzinfo=local_timezone,
        ),
        activity_type="session",
        session_status=session.status,
        like_count=len(engagement.liked_by) if engagement else 0,
        comment_count=len(repository.list_social_comments(activity_post_id)),
        share_count=engagement.share_count if engagement else 0,
        liked_by_me=bool(engagement and viewer_id and viewer_id in engagement.liked_by),
        session_players=[
            SocialSessionPlayer(
                id=candidate.id,
                display_name=candidate.display_name,
                profile_image_url=candidate.profile_image_url,
                cmr_rating=_session_cmr_rating(candidate, session.sport),
            )
            for candidate in players
        ],
        session_leaderboard=leaderboard,
    )


def _member_session(session_id: str, player: Player) -> Session:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if player.id not in session.confirmed_player_ids:
        raise HTTPException(status_code=403, detail="Only confirmed group members can access this space")
    return session


def _leaderboard(
    session_ids: list[str],
    scope: str,
    sport: str | None = None,
    players: list[Player] | None = None,
    sessions: list[Session] | None = None,
) -> LeaderboardResponse:
    players_by_id = {candidate.id: candidate for candidate in (players or repository.list_players()) if candidate.id in session_ids}
    sessions = sessions if sessions is not None else repository.list_sessions()
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
        entries=[
            LeaderboardEntry(
                rank=index,
                player=_public_profile(candidate, sessions=sessions, include_relations=False, include_activity=False),
                score=score,
                ratings_count=count,
            )
            for index, (candidate, score, count) in enumerate(entries, start=1)
        ],
    )


def _refresh_community_scores() -> None:
    ratings_by_player: dict[tuple[str, str], list[float]] = {}
    sessions_by_id = {session.id: session for session in repository.list_sessions()}
    for feedback_item in repository.list_feedback():
        session = sessions_by_id.get(feedback_item.session_id)
        sport = session.sport if session else "pickleball"
        for rating in feedback_item.ratings:
            value = rating.rating
            if value is None and rating.rating_10 is not None:
                value = round(rating.rating_10 / 2, 2)
            if value is None and rating.skill_level:
                value = {"beginner": 2, "intermediate": 3, "advanced": 4}[rating.skill_level]
            if value is not None:
                ratings_by_player.setdefault((rating.player_id, sport), []).append(value)
    players_by_id = {player.id: player for player in repository.list_players()}
    for (player_id, sport), ratings in ratings_by_player.items():
        player = players_by_id.get(player_id)
        if player:
            community_scores = {**player.community_scores, sport: round(sum(ratings) / len(ratings), 2)}
            community_rating_counts = {**player.community_rating_counts, sport: len(ratings)}
            updates = {"community_scores": community_scores, "community_rating_counts": community_rating_counts}
            if sport == "pickleball":
                updates.update({"community_score": community_scores[sport], "community_rating_count": len(ratings)})
            repository.save_player(player.model_copy(update=updates))


def _cmr_seed_rating(player: Player, sport: Sport) -> float:
    """Start a sport at its chosen level, or a neutral 5.00 CMR."""
    return baseline_rating_for_sport(player, sport) or 5.0


def _cmr_confidence_for_games(game_count: int) -> float:
    """Ramp confidence quickly at first, then slow it as the record matures."""
    return round(min(100.0, 100 * (1 - 0.72 ** max(game_count, 0))), 1)


def _is_valid_competitive_result(session: Session, teams: list[MatchTeam]) -> bool:
    """Accept a final two-sided score without prescribing a sport's format."""
    if session.rating_mode != "competitive" or len(teams) != 2:
        return False
    if any(team.score is None or not team.player_ids for team in teams):
        return False
    player_ids = [player_id for team in teams for player_id in team.player_ids]
    if len(player_ids) != len(set(player_ids)) or any(player_id not in session.confirmed_player_ids for player_id in player_ids):
        return False
    scores = [team.score for team in teams]
    return max(scores) > 0 and (scores[0] != scores[1] or scores[0] > 0)


def _confirmed_competitive_results(sessions: list[Session]) -> list[tuple[Session, ChatPost]]:
    results: list[tuple[Session, ChatPost]] = []
    for session in sessions:
        if session.status not in {"awaiting_feedback", "completed"} or session.rating_mode != "competitive":
            continue
        confirmed = [
            post for post in repository.list_chat_posts(session.id)
            if post.post_type == "match_result"
            and post.result_status == "confirmed"
            and _is_valid_competitive_result(session, post.teams)
        ]
        if confirmed:
            # A corrected result is posted later in chat and therefore wins.
            results.append((session, max(confirmed, key=lambda post: post.created_at)))
    return sorted(results, key=lambda item: (item[0].session_date, item[0].start_time, item[1].created_at))


def _refresh_cmr_ratings() -> None:
    """Recompute CMR solely from confirmed, valid competitive game results."""
    players_by_id = {player.id: player for player in repository.list_players()}
    results = _confirmed_competitive_results(repository.list_sessions())
    ratings: dict[tuple[str, Sport], float] = {}
    game_counts: dict[tuple[str, Sport], int] = {}
    histories: dict[tuple[str, Sport], list[CMRHistoryPoint]] = {}

    for session, post in results:
        teams = post.teams
        team_ratings: list[float] = []
        for team in teams:
            member_ratings = []
            for player_id in team.player_ids:
                player = players_by_id.get(player_id)
                if not player:
                    member_ratings = []
                    break
                key = (player_id, session.sport)
                member_ratings.append(ratings.get(key, _cmr_seed_rating(player, session.sport)))
            if not member_ratings:
                team_ratings = []
                break
            team_ratings.append(sum(member_ratings) / len(member_ratings))
        if len(team_ratings) != 2:
            continue

        score_a, score_b = teams[0].score or 0, teams[1].score or 0
        expected_a = 1 / (1 + 10 ** ((team_ratings[1] - team_ratings[0]) / 1.8))
        result_a = 1.0 if score_a > score_b else 0.0 if score_a < score_b else 0.5
        score_factor = 1 + min(0.2, abs(score_a - score_b) / max(score_a, score_b, 1) * 0.2)

        for index, team in enumerate(teams):
            outcome = result_a if index == 0 else 1 - result_a if result_a != 0.5 else 0.5
            expected = expected_a if index == 0 else 1 - expected_a
            for player_id in team.player_ids:
                player = players_by_id[player_id]
                key = (player_id, session.sport)
                previous = ratings.get(key, _cmr_seed_rating(player, session.sport))
                games_before = game_counts.get(key, 0)
                confidence_before = _cmr_confidence_for_games(games_before)
                k_factor = 0.90 - 0.54 * (confidence_before / 100)
                delta = round(k_factor * (outcome - expected) * score_factor, 2)
                rating = round(max(1, min(10, previous + delta)), 2)
                games_after = games_before + 1
                confidence_after = _cmr_confidence_for_games(games_after)
                ratings[key] = rating
                game_counts[key] = games_after
                histories.setdefault(key, []).append(CMRHistoryPoint(
                    session_id=session.id,
                    session_date=session.session_date,
                    group_name=session.group_name,
                    game_rating=rating,
                    rating=rating,
                    delta=round(rating - previous, 2),
                    confidence=confidence_after,
                ))

    for player in players_by_id.values():
        cmr_ratings = dict(player.cmr_ratings)
        cmr_game_counts = dict(player.cmr_game_counts)
        cmr_confidence = dict(player.cmr_confidence)
        cmr_history = dict(player.cmr_history)
        for (player_id, sport), rating in ratings.items():
            if player_id != player.id:
                continue
            cmr_ratings[sport] = rating
            cmr_game_counts[sport] = game_counts[(player_id, sport)]
            cmr_confidence[sport] = _cmr_confidence_for_games(game_counts[(player_id, sport)])
            cmr_history[sport] = histories[(player_id, sport)]
        repository.save_player(player.model_copy(update={
            "cmr_ratings": cmr_ratings,
            "cmr_game_counts": cmr_game_counts,
            "cmr_confidence": cmr_confidence,
            "cmr_history": cmr_history,
            "cmr_scale": 10,
        }))
    _clear_social_feed_cache()


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
    if session.visibility == "private":
        return
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


def _ensure_upcoming_game_reminders() -> None:
    """Create one actionable court-booking reminder per confirmed participant."""
    now = datetime.now(local_timezone)
    reminder_horizon = now + timedelta(hours=24)
    affected_players: set[str] = set()
    existing_notification_ids = {item.id for item in repository.list_notifications()}

    for session in repository.list_sessions():
        if session.status in {"completed", "cancelled"} or not session.confirmed_player_ids:
            continue
        start, _ = _session_window(session)
        if not now < start <= reminder_horizon:
            continue

        for player_id in set(session.confirmed_player_ids):
            notification_id = f"game-reminder-{session.id}-{player_id}"
            if notification_id in existing_notification_ids:
                continue
            try:
                repository.save_notification(AppNotification(
                    id=notification_id,
                    player_id=player_id,
                    kind="game_reminder",
                    title="Game starts soon",
                    message=f"{session.group_name} starts soon. Book the court separately and coordinate final details in your Rally Circle.",
                    session_id=session.id,
                    created_at=datetime.now(timezone.utc),
                ))
                existing_notification_ids.add(notification_id)
                affected_players.add(player_id)
            except Exception:
                # A reminder must never make the notification endpoint fail.
                continue

    for player_id in affected_players:
        _read_view_cache.pop(_read_view_cache_key("notifications", player_id), None)


def _notify_confirmed_players_game_completed(session: Session, completed_by: Player) -> None:
    """Let every participant know when post-game ratings are ready."""
    for player_id in session.confirmed_player_ids:
        try:
            repository.save_notification(AppNotification(
                id=f"game-completed-{session.id}-{player_id}",
                player_id=player_id,
                kind="game_completed",
                title="Feedback is open",
                message=f"{completed_by.display_name} closed {session.group_name}. Rate every other player privately to update CMR.",
                session_id=session.id,
                actor_id=completed_by.id,
                created_at=datetime.now(timezone.utc),
            ))
        except Exception:
            # Notifications are helpful, but a persistence issue must not block completion.
            continue


def _query_group_name(query: str, intent: SearchIntent, style: str) -> str:
    ignored_words = {"find", "me", "a", "an", "the", "show", "looking", "for", "create", "group", "game", "games", "near", "in", "at", "on", "this", "around", "please", "morning", "afternoon", "evening", "tonight", "beginner", "intermediate", "advanced", "casual", "social", "competitive", "pickleball", "badminton", "tennis", "padel", "squash", "table", "ping", "pong"}
    words = [word for word in re.findall(r"[a-zA-Z0-9]+", query.lower()) if word not in ignored_words]
    phrase = " ".join(word.title() for word in words[:5])
    if not phrase:
        phrase = f"{intent.area} {style.title()}"
    return f"{phrase} {intent.sport.replace('_', ' ').title()}"[:64]


def _move_past_proposal_forward(intent: SearchIntent) -> SearchIntent:
    """Keep a conversationally proposed game in the future when today's slot has passed."""
    if intent.date is None or intent.start_time is None:
        return intent
    proposed_start = datetime.combine(intent.date, intent.start_time, tzinfo=local_timezone)
    if proposed_start <= datetime.now(local_timezone):
        return intent.model_copy(update={"date": intent.date + timedelta(days=7)})
    return intent


def _group_proposal(intent: SearchIntent, player_id: str, proposed_name: str | None = None, query: str = "") -> GroupProposal:
    intent = _move_past_proposal_forward(intent)
    player = repository.get_player(player_id)
    rating = rating_for_sport(player, intent.sport) if player else None
    rating = rating if rating is not None else 5.0
    skill_min = intent.skill_min if intent.skill_min is not None else max(1.0, round(rating - 1.8, 2))
    skill_max = intent.skill_max if intent.skill_max is not None else min(10.0, round(rating + 1.8, 2))
    style = intent.style if intent.style != "any" else player.style if player else "casual"
    game_format = "singles" if re.search(r"\bsingles?\b", query.lower()) else "doubles"
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
        game_format=game_format,
        capacity=2 if game_format == "singles" else 6,
        sport=intent.sport,
        explanation=f"No existing {intent.sport.replace('_', ' ')} group met every requirement. Start this group and CourtMate can invite nearby players in the same skill band.",
    )


@app.post("/v1/sessions/search", response_model=SearchResponse)
def search(request: ParseRequest, player: Player = Depends(get_current_player)) -> SearchResponse:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=422, detail="Search query is required")
    if intent_parser.is_general_sports_query(query, request.context):
        intent = SearchIntent(
            sport=request.sport or "pickleball",
            area=player.area,
            latitude=player.latitude,
            longitude=player.longitude,
        )
        return SearchResponse(
            intent=intent,
            recommendations=[],
            action="join_existing",
            message=intent_parser.general_sports_answer(query),
            scope="sports_general",
            retrieval=RetrievalTrace(mode="deterministic_fallback", fallback_reason="general_sports"),
        )
    if not intent_parser.is_in_scope(query, request.context):
        return SearchResponse(
            intent=SearchIntent(
                sport=request.sport or "pickleball",
                area=player.area,
                latitude=player.latitude,
                longitude=player.longitude,
            ),
            recommendations=[],
            action="join_existing",
            message="I can help you find racket-sport courts, games, groups, and players. Try: \"find an intermediate tennis game near Whitefield this Saturday\".",
            scope="out_of_scope",
            retrieval=RetrievalTrace(mode="deterministic_fallback", fallback_reason="out_of_scope"),
        )
    refreshed_sessions = _refresh_all_session_statuses()
    sessions_by_id = {session.id: session for session in refreshed_sessions}
    intent = _parse_intent(request.query, request.sport, player, request.context)
    retrieval_mode = "deterministic_fallback"
    fallback_reason = None
    candidate_sessions = None
    candidate_count = 0
    matched_circles: list[dict] = []
    is_circle_query = bool(re.search(r"\b(circles?|community|communities)\b", query.lower()))

    if vector_retriever.available:
        try:
            vector_results = vector_retriever.search(query, intent, "session")
            candidate_count = len(vector_results)
            candidate_sessions = [
                sessions_by_id.get(session.id, session)
                for session in repository.get_sessions([result.document.source_id for result in vector_results])
            ]
            if candidate_sessions:
                retrieval_mode = "vector"
            else:
                candidate_sessions = None
                fallback_reason = "vector_no_candidates"
        except Exception as error:
            fallback_reason = str(error)[:160]

    if is_circle_query:
        if vector_retriever.available:
            try:
                community_results = vector_retriever.search(query, intent, "community", limit=5)
                for res in community_results:
                    meta = res.document.metadata
                    matched_circles.append({
                        "id": res.document.source_id,
                        "name": res.document.content.split(" in ")[0].replace("Active community circle ", "").strip(),
                        "area": str(meta.get("area", intent.area)).title(),
                        "sport": str(meta.get("sport", intent.sport)),
                        "active_player_count": int(meta.get("active_player_count", 0)),
                        "upcoming_game_count": int(meta.get("upcoming_game_count", 0)),
                        "quality_score": float(meta.get("quality_score", 0.0)),
                    })
            except Exception:
                pass

        if not matched_circles:
            target_area = intent.area or player.area or "Whitefield"
            area_sessions = [s for s in refreshed_sessions if s.sport == intent.sport and (not target_area or s.area.casefold() == target_area.casefold())]
            confirmed_players = {pid for s in area_sessions for pid in s.confirmed_player_ids}
            matched_circles.append({
                "id": f"{intent.sport}_{target_area.lower()}",
                "name": f"{target_area} {intent.sport.replace('_', ' ').title()} Circle",
                "area": target_area,
                "sport": intent.sport,
                "active_player_count": max(len(confirmed_players), 6),
                "upcoming_game_count": len([s for s in area_sessions if s.status == "open"]),
                "quality_score": 88.0,
            })

    sessions = candidate_sessions if candidate_sessions is not None else refreshed_sessions
    sessions = [session for session in sessions if _session_visible_to_player(session, player)]
    players = repository.list_players()
    recommendations = search_sessions(sessions, intent, players, player, exact=request.mode == "exact")
    if not recommendations and retrieval_mode == "vector":
        fallback_reason = "vector_candidates_failed_validation"
        retrieval_mode = "deterministic_fallback"
        sessions = [session for session in refreshed_sessions if _session_visible_to_player(session, player)]
        recommendations = search_sessions(sessions, intent, players, player, exact=request.mode == "exact")
    decision = intent_parser.decide(request.query, intent, sessions, recommendations, player)
    proposal = _group_proposal(intent, player.id, decision.proposed_group_name, request.query) if not recommendations else None
    message = intent_parser.grounded_search_answer(query, intent, recommendations, matched_circles=matched_circles)
    return SearchResponse(intent=intent, recommendations=recommendations, action=decision.action, message=message, group_proposal=proposal, scope="court_discovery", retrieval=RetrievalTrace(mode=retrieval_mode, candidate_count=candidate_count, grounded_result_count=len(recommendations), embedding_version=vector_retriever.provider.version if retrieval_mode == "vector" else None, fallback_reason=fallback_reason))


@app.post("/v1/sessions/{session_id}/join", response_model=JoinRequest)
def join_session(session_id: str, player: Player = Depends(get_current_player)) -> JoinRequest:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_joinable_session(session)
    request_id = f"{session_id}_{player.id}"
    previous = next((candidate for candidate in repository.list_join_requests(session_id) if candidate.player_id == player.id and candidate.status in {"pending", "approved", "waitlisted"}), None)
    if previous:
        return previous
    if player.id in session.confirmed_player_ids:
        raise HTTPException(status_code=409, detail="Player is already confirmed for this session")
    status = "pending"
    mutually_connected = (
        repository.is_following(player.id, session.organizer_id)
        and repository.is_following(session.organizer_id, player.id)
    )
    if (session.visibility == "private" or mutually_connected) and session.open_slots > 0:
        session.confirmed_player_ids.append(player.id)
        saved_session = repository.save_session(session)
        _index_session_best_effort(saved_session)
        status = "approved"
    elif session.open_slots < 1:
        session.waitlist_player_ids.append(player.id)
        repository.save_session(session)
        _index_session_best_effort(session)
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


def _resolve_join_request_notification(join_request: JoinRequest, organizer_id: str) -> None:
    """Mark the organizer's action alert resolved wherever the decision was made."""
    for notification in repository.list_notifications_for_player(organizer_id):
        if notification.kind == "join_request" and notification.request_id == join_request.id:
            repository.mark_notification_read(notification.id, organizer_id)


def _notification_with_action_status(notification: AppNotification, player: Player) -> AppNotification:
    """Return action state from the source record so old alerts cannot look actionable."""
    action_status = None
    if notification.kind == "join_request" and notification.request_id:
        join_request = next(
            (item for item in repository.list_join_requests(notification.session_id) if item.id == notification.request_id),
            None,
        )
        action_status = join_request.status if join_request else "withdrawn"
    elif notification.kind == "follow" and notification.actor_id:
        if repository.is_following(notification.actor_id, player.id):
            action_status = "approved"
        elif repository.is_follow_request_pending(notification.actor_id, player.id):
            action_status = "pending"
        else:
            action_status = "declined"
    if action_status is None:
        return notification
    return notification.model_copy(update={
        "action_status": action_status,
        "read": notification.read or action_status != "pending",
    })


@app.post("/v1/sessions/{session_id}/leave", response_model=Session)
def leave_session(session_id: str, player: Player = Depends(get_current_player)) -> Session:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_joinable_session(session)
    if session.organizer_id == player.id:
        raise HTTPException(status_code=409, detail="The organizer cannot leave their own group")
    if player.id in session.confirmed_player_ids:
        starts_at, _ = _session_window(session)
        _save_player_reliability_event(player, withdrew_late=datetime.now(local_timezone) >= starts_at - timedelta(hours=12))
        session.confirmed_player_ids.remove(player.id)
        if player.id in session.checked_in_player_ids:
            session.checked_in_player_ids.remove(player.id)
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
            saved_request = repository.save_join_request(pending_request)
            _notify_request_update(saved_request, session)
            return session
        raise HTTPException(status_code=409, detail="You are not confirmed or waitlisted for this session")
    if session.open_slots > 0 and session.status == "full":
        session.status = "open"
    saved = repository.save_session(session)
    _index_session_best_effort(saved)
    return saved


@app.post("/v1/sessions/{session_id}/check-in", response_model=Session)
def check_in_to_session(session_id: str, player: Player = Depends(get_current_player)) -> Session:
    """Record a confirmed player's self check-in without exposing it publicly."""
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Game not found")
    if not session.time_finalized:
        raise HTTPException(status_code=409, detail="Finalize the time poll in the Rally Circle before checking in")
    _require_active_session(session)
    if player.id not in session.confirmed_player_ids:
        raise HTTPException(status_code=403, detail="Only confirmed players can check in")
    if player.id in session.checked_in_player_ids:
        return session

    starts_at, ends_at = _session_window(session)
    now = datetime.now(local_timezone)
    if now < starts_at - timedelta(hours=1):
        raise HTTPException(status_code=409, detail="Check-in opens one hour before the game")
    if now > ends_at:
        raise HTTPException(status_code=409, detail="This game has already ended")

    on_time = now <= starts_at + timedelta(minutes=15)
    _save_player_reliability_event(player, on_time=on_time)
    saved = repository.save_session(session.model_copy(update={"checked_in_player_ids": [*session.checked_in_player_ids, player.id]}))
    return saved


@app.post("/v1/me/requests/{request_id}/withdraw", response_model=JoinRequest)
def withdraw_join_request(request_id: str, player: Player = Depends(get_current_player)) -> JoinRequest:
    """Withdraw one of the current player's pending or waitlisted requests."""
    join_request = next(
        (
            candidate
            for candidate in repository.list_join_requests_for_player(player.id)
            if candidate.id == request_id
        ),
        None,
    )
    if not join_request:
        raise HTTPException(status_code=404, detail="Join request not found")
    if join_request.status not in {"pending", "waitlisted"}:
        raise HTTPException(status_code=409, detail=f"Join request is already {join_request.status}")

    session = _get_session(join_request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_active_session(session)

    if player.id in session.waitlist_player_ids:
        session.waitlist_player_ids.remove(player.id)
        saved_session = repository.save_session(session)
        _index_session_best_effort(saved_session)

    join_request.status = "withdrawn"
    saved_request = repository.save_join_request(join_request)
    return saved_request


@app.get("/v1/sessions/{session_id}/join-requests", response_model=JoinRequestsResponse)
def join_requests(session_id: str, player: Player = Depends(get_current_player)) -> JoinRequestsResponse:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.organizer_id != player.id:
        raise HTTPException(status_code=403, detail="Only the group organizer can view join requests")
    return JoinRequestsResponse(session=session, requests=repository.list_join_requests(session_id))


@app.post("/v1/sessions/{session_id}/join-requests/{request_id}/decision", response_model=JoinRequest)
def decide_join_request(session_id: str, request_id: str, request: JoinRequestDecisionRequest, background_tasks: BackgroundTasks, player: Player = Depends(get_current_player)) -> JoinRequest:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _require_joinable_session(session)
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
                background_tasks.add_task(_index_session_best_effort, session)
            join_request.status = "waitlisted"
            saved_request = repository.save_join_request(join_request)
            _notify_request_update(saved_request, session)
            _resolve_join_request_notification(saved_request, player.id)
            return saved_request
        if join_request.player_id not in session.confirmed_player_ids:
            session.confirmed_player_ids.append(join_request.player_id)
            repository.save_session(session)
            background_tasks.add_task(_index_session_best_effort, session)
    join_request.status = request.status
    saved_request = repository.save_join_request(join_request)
    _notify_request_update(saved_request, session)
    _resolve_join_request_notification(saved_request, player.id)
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
    _ensure_upcoming_game_reminders()
    cache_key = _read_view_cache_key("notifications", player.id)
    cached = _get_cached_read_view(cache_key)
    if cached is not None:
        return cached
    items = [_notification_with_action_status(notification, player) for notification in repository.list_notifications_for_player(player.id)]
    return _cache_read_view(cache_key, NotificationsResponse(notifications=items))


@app.post("/v1/me/notifications/{notification_id}/read", response_model=AppNotification)
def mark_notification_read(notification_id: str, player: Player = Depends(get_current_player)) -> AppNotification:
    notification = repository.mark_notification_read(notification_id, player.id)
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")
    return notification


@app.post("/v1/me/notifications/read-all", response_model=NotificationsResponse)
def mark_all_notifications_read(player: Player = Depends(get_current_player)) -> NotificationsResponse:
    """Mark the alerts visible to this player as seen when the panel opens."""
    for notification in repository.list_notifications_for_player(player.id):
        if not notification.read:
            repository.mark_notification_read(notification.id, player.id)
    items = [_notification_with_action_status(notification, player) for notification in repository.list_notifications_for_player(player.id)]
    return NotificationsResponse(notifications=items)


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
    submitted_feedback_session_ids = {
        item.session_id for item in repository.list_feedback() if item.player_id == player.id
    }
    games = [session for session in player_sessions if session.session_date >= _local_today() and session.status not in {"awaiting_feedback", "completed", "cancelled"} and player.id not in session.completed_player_ids]
    games.sort(key=lambda session: (session.session_date, session.start_time))
    past_games = []
    for session in player_sessions:
        if (session.status != "completed" and session.id not in submitted_feedback_session_ids) or player.id not in session.confirmed_player_ids:
            continue
        entries = _leaderboard(session.confirmed_player_ids, f"group:{session.id}", session.sport).entries
        player_entry = next((entry for entry in entries if entry.player.id == player.id), None)
        past_games.append(PastGame(session=session, rank=player_entry.rank if player_entry else None, score=player_entry.score if player_entry else None, ratings_count=player_entry.ratings_count if player_entry else 0, group_size=len(session.confirmed_player_ids)))
    past_games.sort(key=lambda item: (item.session.session_date, item.session.start_time), reverse=True)
    return MyGamesResponse(games=games, past_games=past_games)


@app.get("/v1/me/activity", response_model=MyActivityResponse)
def my_activity(player: Player = Depends(get_current_player), refresh: bool = Query(False)) -> MyActivityResponse:
    """Load all Games tabs from one shared snapshot instead of four separate reads."""
    cache_key = _read_view_cache_key("activity", player.id)
    if not refresh:
        cached = _get_cached_read_view(cache_key)
        if cached is not None:
            return cached

    sessions = _refresh_all_session_statuses()
    players = repository.list_players()
    sessions_by_id = {session.id: session for session in sessions}
    player_requests = repository.list_join_requests_for_player(player.id)
    request_views = [
        JoinRequestView(request=join_request, session=sessions_by_id[join_request.session_id])
        for join_request in player_requests
        if join_request.session_id in sessions_by_id
    ]
    request_views.sort(key=lambda item: item.request.created_at, reverse=True)

    groups = sorted(
        (session for session in sessions if session.organizer_id == player.id),
        key=lambda session: (session.session_date, session.start_time),
    )
    incoming_requests = []
    for session in groups:
        if session.status in {"completed", "cancelled"}:
            continue
        incoming_requests.extend(
            JoinRequestView(request=join_request, session=session)
            for join_request in repository.list_join_requests(session.id)
            if join_request.status == "pending"
        )
    incoming_requests.sort(key=lambda item: item.request.created_at, reverse=True)

    player_sessions = [session for session in sessions if player.id in session.confirmed_player_ids]
    games = [session for session in player_sessions if session.session_date >= _local_today() and session.status not in {"awaiting_feedback", "completed", "cancelled"} and player.id not in session.completed_player_ids]
    games.sort(key=lambda session: (session.session_date, session.start_time))
    submitted_feedback_session_ids = {
        item.session_id
        for item in repository.list_feedback()
        if item.player_id == player.id
    }
    awaiting_feedback = [
        session
        for session in player_sessions
        if (session.status == "awaiting_feedback" or player.id in session.completed_player_ids) and session.id not in submitted_feedback_session_ids
    ]
    awaiting_feedback.sort(key=lambda session: (session.session_date, session.start_time), reverse=True)
    past_games = []
    for session in player_sessions:
        if session.status != "completed" and session.id not in submitted_feedback_session_ids:
            continue
        entries = _leaderboard(session.confirmed_player_ids, f"group:{session.id}", session.sport, players=players, sessions=sessions).entries
        player_entry = next((entry for entry in entries if entry.player.id == player.id), None)
        past_games.append(PastGame(session=session, rank=player_entry.rank if player_entry else None, score=player_entry.score if player_entry else None, ratings_count=player_entry.ratings_count if player_entry else 0, group_size=len(session.confirmed_player_ids)))
    past_games.sort(key=lambda item: (item.session.session_date, item.session.start_time), reverse=True)

    return _cache_read_view(cache_key, MyActivityResponse(
        requests=request_views,
        incoming_requests=incoming_requests,
        groups=groups,
        games=games,
        awaiting_feedback=awaiting_feedback,
        past_games=past_games,
    ))


@app.get("/v1/me/explore", response_model=ExploreSessionsResponse)
def explore_sessions(player: Player = Depends(get_current_player)) -> ExploreSessionsResponse:
    """Return every visible game the player can still request, ranked by fit."""
    cache_key = _read_view_cache_key("explore", player.id)
    cached = _get_cached_read_view(cache_key)
    if cached is not None:
        return cached
    _refresh_all_session_statuses()
    active_request_session_ids = {
        request.session_id
        for request in repository.list_join_requests_for_player(player.id)
        if request.status in {"pending", "approved", "waitlisted"}
    }
    source_sessions = [
        session
        for session in repository.list_sessions()
        if session.organizer_id != player.id
        and player.id not in session.confirmed_player_ids
        and session.id not in active_request_session_ids
        and _session_visible_to_player(session, player)
        and session.status in {"open", "full"}
    ]
    players = repository.list_players()
    recommendations = []
    for sport in ("pickleball", "badminton", "tennis", "padel", "squash", "table_tennis"):
        intent = SearchIntent(
            sport=sport,
            area=player.area,
            latitude=player.latitude,
            longitude=player.longitude,
            open_slots_required=1,
        )
        recommendations.extend(search_sessions(source_sessions, intent, players, player, exact=False, strict=False))
    recommendations.sort(
        key=lambda item: (
            -item.score,
            item.reasons.distance_km if item.reasons.distance_km is not None else 9999,
            item.session.session_date,
            item.session.start_time,
        )
    )
    return _cache_read_view(cache_key, ExploreSessionsResponse(recommendations=recommendations))


def _player_cmr(player: Player, sport: Sport) -> float | None:
    return rating_for_sport(player, sport)


def _community_name(sport: Sport, area: str) -> str:
    return f"{area} {sport.replace('_', ' ').title()} Circle"


@app.get("/v1/me/player-density", response_model=PlayerDensityResponse)
def player_density(
    sport: MapSport = "all",
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    radius_km: float = Query(default=20, ge=1, le=100),
    cmr_min: float | None = Query(default=None, ge=1, le=10),
    cmr_max: float | None = Query(default=None, ge=1, le=10),
    player: Player = Depends(get_current_player),
) -> PlayerDensityResponse:
    """Return aggregated neighborhood demand, never individual player locations."""
    if cmr_min is not None and cmr_max is not None and cmr_min > cmr_max:
        raise HTTPException(status_code=422, detail="CMR minimum must not exceed maximum")
    origin_latitude = latitude if latitude is not None else player.latitude
    origin_longitude = longitude if longitude is not None else player.longitude
    buckets: dict[str, list[tuple[Player, float | None, float | None, float | None]]] = {}
    for candidate in repository.list_players():
        if candidate.is_profile_private:
            continue
        candidate_cmrs = (
            [rating_for_sport(candidate, candidate_sport) for candidate_sport in ("pickleball", "badminton", "tennis", "padel", "squash", "table_tennis")]
            if sport == "all"
            else [_player_cmr(candidate, sport)]
        )
        candidate_cmrs = [value for value in candidate_cmrs if value is not None]
        candidate_cmr = sum(candidate_cmrs) / len(candidate_cmrs) if candidate_cmrs else None
        if candidate_cmr is None:
            continue
        if cmr_min is not None and candidate_cmr is not None and candidate_cmr < cmr_min:
            continue
        if cmr_max is not None and candidate_cmr is not None and candidate_cmr > cmr_max:
            continue
        candidate_latitude, candidate_longitude = candidate.latitude, candidate.longitude
        if candidate_latitude is None or candidate_longitude is None:
            fallback_coordinates = _geocode_area(candidate.area)
            if fallback_coordinates:
                candidate_latitude, candidate_longitude = fallback_coordinates
        distance = None
        if origin_latitude is not None and origin_longitude is not None and candidate_latitude is not None and candidate_longitude is not None:
            distance = distance_km(origin_latitude, origin_longitude, candidate_latitude, candidate_longitude)
            if distance > radius_km:
                continue
        key = candidate.area.strip() or "Nearby"
        buckets.setdefault(key, []).append((candidate, candidate_cmr, candidate_latitude, candidate_longitude))

    points = []
    for area, entries in buckets.items():
        if len(entries) < 3:
            continue
        coordinates = [(entry[2], entry[3]) for entry in entries if entry[2] is not None and entry[3] is not None]
        latitude_average = round(sum(item[0] for item in coordinates) / len(coordinates), 3) if coordinates else None
        longitude_average = round(sum(item[1] for item in coordinates) / len(coordinates), 3) if coordinates else None
        cmrs = [entry[1] for entry in entries if entry[1] is not None]
        point_distance = distance_km(origin_latitude, origin_longitude, latitude_average, longitude_average) if origin_latitude is not None and origin_longitude is not None and latitude_average is not None and longitude_average is not None else None
        count = len(entries)
        intensity = "very_hot" if count >= 15 else "hot" if count >= 8 else "warm"
        points.append(PlayerDensityPoint(area=area, player_count=count, latitude=latitude_average, longitude=longitude_average, cmr_min=round(min(cmrs), 1) if cmrs else None, cmr_max=round(max(cmrs), 1) if cmrs else None, distance_km=round(point_distance, 1) if point_distance is not None else None, intensity=intensity))
    points.sort(key=lambda point: (point.distance_km if point.distance_km is not None else 9999, -point.player_count))
    return PlayerDensityResponse(sport=sport, radius_km=radius_km, points=points[:20])


def _map_time_matches(session: Session, time_of_day: str | None) -> bool:
    if not time_of_day:
        return True
    ranges = {"morning": (0, 9), "day": (9, 16), "evening": (16, 21), "night": (21, 24)}
    window = ranges.get(time_of_day.casefold())
    return window is None or window[0] <= session.start_time.hour < window[1]


def _map_coordinates(session: Session) -> tuple[float | None, float | None]:
    if session.latitude is not None and session.longitude is not None:
        return session.latitude, session.longitude
    coordinates = _geocode_area(session.area)
    return coordinates if coordinates is not None else (None, None)


def _public_map_viewer(area: str, latitude: float | None, longitude: float | None) -> Player:
    fallback_latitude, fallback_longitude = _geocode_area(area) or _fallback_area_coordinates["whitefield"]
    return Player(
        id="public-map-viewer",
        display_name="Guest",
        area=area,
        latitude=latitude if latitude is not None else fallback_latitude,
        longitude=longitude if longitude is not None else fallback_longitude,
        cmr_scale=10,
    )


@app.get("/v1/me/community-map", response_model=CommunityMapResponse)
def community_map(
    sport: MapSport = "all",
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    radius_km: float = Query(default=5, ge=1, le=100),
    cmr_min: float | None = Query(default=None, ge=1, le=10),
    cmr_max: float | None = Query(default=None, ge=1, le=10),
    date: date | None = Query(default=None),
    time_of_day: str | None = Query(default=None),
    activity_type: str = Query(default="all"),
    visibility_filter: str = Query(default="all"),
    player: Player = Depends(get_current_player),
) -> CommunityMapResponse:
    """Return one privacy-safe read model for all Communities map overlays."""
    if cmr_min is not None and cmr_max is not None and cmr_min > cmr_max:
        raise HTTPException(status_code=422, detail="CMR minimum must not exceed maximum")
    normalized_activity = activity_type.casefold()
    if normalized_activity not in {"all", "players", "communities", "games"}:
        raise HTTPException(status_code=422, detail="Activity type must be all, players, communities, or games")
    normalized_visibility = visibility_filter.casefold()
    if normalized_visibility not in {"all", "public", "friends"}:
        raise HTTPException(status_code=422, detail="Visibility filter must be all, public, or friends")
    origin_latitude = latitude if latitude is not None else player.latitude
    origin_longitude = longitude if longitude is not None else player.longitude
    cache_key = _read_view_cache_key(
        "community-map", player.id, sport, f"{(origin_latitude or 0):.2f}", f"{(origin_longitude or 0):.2f}",
        str(radius_km), str(cmr_min), str(cmr_max), str(date), (time_of_day or "").casefold(), normalized_activity, normalized_visibility,
    )
    cached = _get_cached_read_view(cache_key)
    if cached:
        return cached

    today = _local_today()
    all_sessions = repository.list_sessions()
    following_ids = {record.following_id for record in repository.list_following(player.id)}
    visible_upcoming = [
        session for session in all_sessions
        if (sport == "all" or session.sport == sport) and _map_session_visible_to_player(session, normalized_visibility, following_ids)
        and session.status in {"open", "full", "in_progress"} and session.session_date >= today
        and (date is None or session.session_date == date) and _map_time_matches(session, time_of_day)
    ]
    player_cmr = None if sport == "all" else rating_for_sport(player, sport)
    if player_cmr is not None and ((cmr_min is not None and player_cmr < cmr_min) or (cmr_max is not None and player_cmr > cmr_max)):
        visible_upcoming = []

    nearby_games: list[MapNearbyGame] = []
    for session in visible_upcoming:
        session_latitude, session_longitude = _map_coordinates(session)
        if session_latitude is None or session_longitude is None:
            continue
        distance = None
        if origin_latitude is not None and origin_longitude is not None and session_latitude is not None and session_longitude is not None:
            distance = distance_km(origin_latitude, origin_longitude, session_latitude, session_longitude)
            if distance > radius_km:
                continue
        skill_fit = 50.0
        if player_cmr is not None:
            session_min = session.skill_min
            session_max = session.skill_max
            if session_min <= player_cmr <= session_max:
                skill_fit = 100.0
            else:
                gap = min(abs(player_cmr - session_min), abs(player_cmr - session_max))
                skill_fit = max(0.0, 100.0 - gap * 2.0)
        distance_fit = max(0.0, 100.0 - (distance / radius_km * 100.0)) if distance is not None else 50.0
        nearby_games.append(MapNearbyGame(
            id=session.id, group_name=session.group_name, sport=session.sport, area=session.area,
            venue_name=session.venue_name, latitude=session_latitude, longitude=session_longitude,
            session_date=session.session_date, start_time=session.start_time, end_time=session.end_time,
            open_slots=session.open_slots, skill_min=session.skill_min,
            skill_max=session.skill_max, distance_km=round(distance, 1) if distance is not None else None,
            match_score=round(skill_fit * 0.65 + distance_fit * 0.35, 1),
            visibility=session.visibility,
            is_connection_game=session.organizer_id in following_ids,
        ))
    nearby_games.sort(key=lambda game: (-game.match_score, game.distance_km if game.distance_km is not None else 9999, game.session_date, game.start_time))

    cluster_buckets: dict[str, list[MapNearbyGame]] = {}
    for game in nearby_games:
        cluster_buckets.setdefault(f"{game.area.casefold()}::{(game.venue_name or game.area).casefold()}", []).append(game)
    game_clusters = []
    for cluster_key, games in cluster_buckets.items():
        coordinates = [(game.latitude, game.longitude) for game in games if game.latitude is not None and game.longitude is not None]
        cluster_latitude = round(sum(item[0] for item in coordinates) / len(coordinates), 5) if coordinates else None
        cluster_longitude = round(sum(item[1] for item in coordinates) / len(coordinates), 5) if coordinates else None
        game_clusters.append(GameCluster(
            cluster_id=f"game-cluster:{sport}:{cluster_key}", area=games[0].area, latitude=cluster_latitude,
            longitude=cluster_longitude, game_count=len(games), open_slot_count=sum(game.open_slots for game in games),
            game_ids=[game.id for game in games],
        ))
    game_clusters.sort(key=lambda cluster: (-cluster.game_count, cluster.area.casefold()))

    memberships = repository.list_community_memberships()
    membership_groups: dict[str, set[str]] = {}
    for membership in memberships:
        if sport == "all" or membership.sport == sport:
            membership_groups.setdefault(membership.area.casefold(), set()).add(membership.player_id)
    public_sessions = [session for session in all_sessions if (sport == "all" or session.sport == sport) and session.visibility == "public"]
    area_sessions: dict[str, list[Session]] = {}
    for session in public_sessions:
        area_sessions.setdefault(session.area.casefold(), []).append(session)
    community_activity: list[CommunityActivityPoint] = []
    for area_key, area_items in area_sessions.items():
        area = area_items[0].area
        upcoming = [session for session in area_items if session.status in {"open", "full", "in_progress"} and session.session_date >= today]
        recent_completed = [session for session in area_items if session.status == "completed" and (today - session.session_date).days <= 30]
        active_players = set(membership_groups.get(area_key, set())) | {player_id for session in upcoming for player_id in session.confirmed_player_ids}
        recent_joins = [membership for membership in memberships if (sport == "all" or membership.sport == sport) and membership.area.casefold() == area_key and (datetime.now(timezone.utc) - membership.joined_at).days <= 30]
        recency_signal = max((1 - min((datetime.now(timezone.utc) - item.joined_at).days, 30) / 30 for item in recent_joins), default=0.0)
        activity_score = round(min(100.0, len(active_players) * 6 + len(upcoming) * 18 + len(recent_completed) * 8 + recency_signal * 10), 1)
        coordinates = [_map_coordinates(session) for session in area_items]
        valid_coordinates = [(lat, lng) for lat, lng in coordinates if lat is not None and lng is not None]
        area_latitude = round(sum(item[0] for item in valid_coordinates) / len(valid_coordinates), 5) if valid_coordinates else None
        area_longitude = round(sum(item[1] for item in valid_coordinates) / len(valid_coordinates), 5) if valid_coordinates else None
        area_distance = distance_km(origin_latitude, origin_longitude, area_latitude, area_longitude) if origin_latitude is not None and origin_longitude is not None and area_latitude is not None and area_longitude is not None else None
        if area_distance is not None and area_distance > radius_km:
            continue
        if sport != "all":
            community_activity.append(CommunityActivityPoint(
                community_id=f"community:{sport}:{area_key.replace(' ', '-')}", name=_community_name(sport, area), sport=sport, area=area,
                latitude=area_latitude, longitude=area_longitude, active_player_count=len(active_players), upcoming_game_count=len(upcoming),
                activity_score=activity_score, quality_score=round(min(100.0, activity_score * 0.45 + len(recent_completed) * 8), 1),
            ))
    community_activity.sort(key=lambda item: (-item.activity_score, item.name.casefold()))

    density_response = player_density(sport=sport, latitude=latitude, longitude=longitude, radius_km=radius_km, cmr_min=cmr_min, cmr_max=cmr_max, player=player)
    activity_by_area = {item.area.casefold(): item for item in community_activity}
    density_points = [point.model_copy(update={
        "active_game_count": sum(1 for game in nearby_games if game.area.casefold() == point.area.casefold()),
        "community_count": 1 if point.area.casefold() in activity_by_area else 0,
        "activity_score": activity_by_area[point.area.casefold()].activity_score if point.area.casefold() in activity_by_area else 0,
    }) for point in density_response.points]
    response = CommunityMapResponse(
        sport=sport, center_latitude=origin_latitude, center_longitude=origin_longitude, radius_km=radius_km,
        player_density=density_points if normalized_activity in {"all", "players"} else [],
        community_activity=community_activity if normalized_activity in {"all", "communities"} else [],
        game_clusters=game_clusters if normalized_activity in {"all", "games"} else [],
        nearby_games=nearby_games if normalized_activity in {"all", "games"} else [],
        generated_at=datetime.now(timezone.utc),
    )
    return _cache_read_view(cache_key, response)


@app.get("/v1/public/community-map", response_model=CommunityMapResponse)
def public_community_map(
    sport: MapSport = "all",
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    radius_km: float = Query(default=5, ge=1, le=100),
    cmr_min: float | None = Query(default=None, ge=1, le=10),
    cmr_max: float | None = Query(default=None, ge=1, le=10),
    date: date | None = Query(default=None),
    time_of_day: str | None = Query(default=None),
    activity_type: str = Query(default="all"),
    area: str = Query(default="Whitefield", min_length=1, max_length=80),
) -> CommunityMapResponse:
    """Read-only public map: only aggregated player demand and public games."""
    return community_map(
        sport=sport,
        latitude=latitude,
        longitude=longitude,
        radius_km=radius_km,
        cmr_min=cmr_min,
        cmr_max=cmr_max,
        date=date,
        time_of_day=time_of_day,
        activity_type=activity_type,
        visibility_filter="public",
        player=_public_map_viewer(area, latitude, longitude),
    )


@app.get("/v1/me/community-leaderboard", response_model=CommunityLeaderboardResponse)
def community_leaderboard(sport: Sport = "pickleball", area: str | None = None, player: Player = Depends(get_current_player)) -> CommunityLeaderboardResponse:
    """Rank sufficiently active sport-area circles by quality, not popularity."""
    sessions = [session for session in repository.list_sessions() if session.sport == sport and session.status == "completed" and (not area or session.area.casefold() == area.casefold())]
    feedback_by_session = {session.id: repository.list_feedback(session.id) for session in sessions}
    players_by_id = {candidate.id: candidate for candidate in repository.list_players()}
    grouped: dict[str, list[Session]] = {}
    for session in sessions:
        grouped.setdefault(session.area.strip() or "Nearby", []).append(session)
    entries = []
    for community_area, community_sessions in grouped.items():
        feedback = [item for session in community_sessions for item in feedback_by_session[session.id]]
        submitted_pairs = {(item.session_id, item.player_id) for item in feedback}
        expected_pairs = {(session.id, player_id) for session in community_sessions for player_id in session.confirmed_player_ids}
        completion_rate = len(submitted_pairs & expected_pairs) / len(expected_pairs) if expected_pairs else 0
        rating_count = sum(len(item.ratings) for item in feedback)
        if len(community_sessions) < 3 or rating_count < 5:
            continue
        member_ids = {player_id for session in community_sessions for player_id in session.confirmed_player_ids}
        play_counts = {player_id: sum(player_id in session.confirmed_player_ids for session in community_sessions) for player_id in member_ids}
        repeat_rate = sum(count > 1 for count in play_counts.values()) / len(play_counts) if play_counts else 0
        match_quality = sum(item.match_quality for item in feedback) / len(feedback) if feedback else 1
        reliability = sum(players_by_id[player_id].reliability for player_id in member_ids if player_id in players_by_id) / max(len([player_id for player_id in member_ids if player_id in players_by_id]), 1)
        deltas = [point.delta for player_id in member_ids for point in players_by_id.get(player_id, Player(id="missing", display_name="", area="")).cmr_history.get(sport, []) if point.session_id in {session.id for session in community_sessions} and point.delta is not None]
        average_improvement = sum(deltas) / len(deltas) if deltas else 0
        improvement_signal = max(0, min(1, (average_improvement + 10) / 20))
        quality_score = round((match_quality / 5) * 35 + completion_rate * 20 + repeat_rate * 20 + reliability * 15 + improvement_signal * 10, 1)
        entries.append(CommunityLeaderboardEntry(rank=0, community_id=f"community:{sport}:{community_area.casefold().replace(' ', '-')}", name=_community_name(sport, community_area), sport=sport, area=community_area, quality_score=quality_score, completed_games=len(community_sessions), active_players=len(member_ids), average_match_quality=round(match_quality, 2), feedback_completion_rate=round(completion_rate, 3), repeat_play_rate=round(repeat_rate, 3), average_cmr_improvement=round(average_improvement, 2), average_reliability=round(reliability, 3)))
    entries.sort(key=lambda entry: (-entry.quality_score, -entry.completed_games, entry.name.casefold()))
    badges = {
        "best_quality": max(entries, key=lambda entry: entry.average_match_quality, default=None),
        "most_improved": max(entries, key=lambda entry: entry.average_cmr_improvement, default=None),
        "most_reliable": max(entries, key=lambda entry: entry.average_reliability, default=None),
        "fastest_growing": max(entries, key=lambda entry: (entry.repeat_play_rate, entry.completed_games), default=None),
    }
    for index, entry in enumerate(entries, start=1):
        entry.rank = index
        entry.badge = next((badge for badge, candidate in badges.items() if candidate and candidate.community_id == entry.community_id), None)
    return CommunityLeaderboardResponse(sport=sport, area=area, entries=entries[:20])


@app.get("/v1/public/community-leaderboard", response_model=CommunityLeaderboardResponse)
def public_community_leaderboard(sport: Sport = "pickleball", area: str | None = None) -> CommunityLeaderboardResponse:
    return community_leaderboard(sport=sport, area=area, player=_public_map_viewer(area or "Whitefield", None, None))


@app.get("/v1/me/venues", response_model=FacilityListResponse)
def nearby_facilities(
    sport: Sport = "pickleball",
    area: str | None = None,
    limit: int = Query(default=12, ge=1, le=50),
    player: Player = Depends(get_current_player),
) -> FacilityListResponse:
    """Return curated Bengaluru courts for the selected sport and locality."""
    requested_area = (area or player.area).strip().casefold()
    records = [record for record in BENGALURU_FACILITIES if record["sport"] == sport]
    records.sort(key=lambda record: (0 if requested_area and requested_area in str(record["area"]).casefold() else 1, str(record["name"]).casefold()))
    facilities = [Facility.model_validate(record) for record in records[:limit]]
    return FacilityListResponse(sport=sport, area=area or player.area, facilities=facilities)


@app.get("/v1/public/venues", response_model=FacilityListResponse)
def public_nearby_facilities(
    sport: Sport = "pickleball",
    area: str = Query(default="Whitefield", min_length=1, max_length=80),
    limit: int = Query(default=12, ge=1, le=50),
) -> FacilityListResponse:
    return nearby_facilities(sport=sport, area=area, limit=limit, player=_public_map_viewer(area, None, None))


def _community_id(sport: Sport, area: str) -> str:
    return f"community:{sport}:{area.casefold().replace(' ', '-')}"


@app.get("/v1/me/communities", response_model=CommunityMembershipResponse)
def my_communities(player: Player = Depends(get_current_player)) -> CommunityMembershipResponse:
    return CommunityMembershipResponse(memberships=repository.list_community_memberships_for_player(player.id))


@app.post("/v1/me/communities/join", response_model=CommunityMembership)
def join_community(request: CommunityJoinRequest, player: Player = Depends(get_current_player)) -> CommunityMembership:
    area = request.area.strip()
    community_id = _community_id(request.sport, area)
    existing = repository.get_community_membership(community_id, player.id)
    if existing:
        return existing
    membership = CommunityMembership(
        id=f"{community_id}:{player.id}",
        community_id=community_id,
        player_id=player.id,
        sport=request.sport,
        area=area,
        joined_at=datetime.now(timezone.utc),
    )
    return repository.save_community_membership(membership)


@app.get("/v1/sessions/{session_id}/group", response_model=GroupViewResponse)
def group_view(session_id: str, player: Player = Depends(get_current_player)) -> GroupViewResponse:
    cache_key = _read_view_cache_key("group", player.id, session_id)
    cached = _get_cached_read_view(cache_key)
    if cached is not None:
        return cached
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    players_by_id = {candidate.id: candidate for candidate in repository.list_players()}
    sessions = repository.list_sessions()
    members = [_public_profile(players_by_id[player_id], player.id, sessions) for player_id in session.confirmed_player_ids if player_id in players_by_id]
    waitlist = [_public_profile(players_by_id[player_id], player.id, sessions) for player_id in session.waitlist_player_ids if player_id in players_by_id]
    activity_proofs = repository.list_activity_proofs(session_id=session.id) if session.status == "completed" else []
    return _cache_read_view(cache_key, GroupViewResponse(session=session, members=members, waitlist=waitlist, activity_proofs=activity_proofs))


def _parse_chat_match_result(message: str, session: Session) -> list[MatchTeam]:
    """Extract two sides and a score from a natural group-chat update."""
    score_match = re.search(r"(?<!\d)(\d{1,3})\s*(?:-|:|to)\s*(\d{1,3})(?!\d)", message, re.IGNORECASE)
    if not score_match:
        return []
    without_score = f"{message[:score_match.start()]} {message[score_match.end():]}"
    connector = re.search(r"\b(?:beat|beats|won against|won over|defeated|versus|vs)\b", without_score, re.IGNORECASE)
    if connector:
        left_text = without_score[:connector.start()]
        right_text = without_score[connector.end():]
    else:
        left_text = message[:score_match.start()]
        right_text = message[score_match.end():]

    players = repository.list_players()

    def player_ids(text: str) -> list[str]:
        matches: list[tuple[int, str]] = []
        first_name_counts: dict[str, int] = {}
        for candidate in players:
            first_name = candidate.display_name.split()[0].lower()
            first_name_counts[first_name] = first_name_counts.get(first_name, 0) + 1
        for candidate in players:
            full_name_pattern = rf"(?<![\w]){re.escape(candidate.display_name)}(?![\w])"
            first_name = candidate.display_name.split()[0].lower()
            first_name_pattern = rf"(?<![\w]){re.escape(candidate.display_name.split()[0])}(?![\w])"
            name_match = re.search(full_name_pattern, text, re.IGNORECASE)
            if not name_match and first_name_counts[first_name] == 1:
                name_match = re.search(first_name_pattern, text, re.IGNORECASE)
            if name_match:
                matches.append((name_match.start(), candidate.id))
        return [player_id for _, player_id in sorted(matches)]

    left_ids = player_ids(left_text)
    right_ids = player_ids(right_text)
    if not left_ids or not right_ids or len(left_ids) > 2 or len(right_ids) > 2 or set(left_ids) & set(right_ids):
        return []
    if any(player_id not in session.confirmed_player_ids for player_id in [*left_ids, *right_ids]):
        return []
    return [
        MatchTeam(name="Pair A", player_ids=left_ids, score=int(score_match.group(1))),
        MatchTeam(name="Pair B", player_ids=right_ids, score=int(score_match.group(2))),
    ]


def _validate_chat_match_teams(teams: list[MatchTeam], session: Session) -> None:
    if len(teams) != 2:
        raise HTTPException(status_code=422, detail="Mention who played on both sides and include the score, for example: Rhea and Ananya beat Kavya and Meera 11-8")
    if any(len(team.player_ids) > 2 or not team.player_ids for team in teams):
        raise HTTPException(status_code=422, detail="Each side can include one or two confirmed players")
    if any(team.score is None for team in teams):
        raise HTTPException(status_code=422, detail="Include both scores, for example 11-8")
    seen_team_players: set[str] = set()
    for team in teams:
        for player_id in team.player_ids:
            if player_id not in session.confirmed_player_ids:
                raise HTTPException(status_code=422, detail="Scores can only include players from this group")
            if player_id in seen_team_players:
                raise HTTPException(status_code=422, detail="A player can only be on one side")
            seen_team_players.add(player_id)


@app.post("/v1/sessions/{session_id}/booking", response_model=Session)
def update_booking(session_id: str, request: BookingUpdateRequest, player: Player = Depends(get_current_player)) -> Session:
    session = _member_session(session_id, player)
    if session.organizer_id != player.id:
        raise HTTPException(status_code=403, detail="Only the organizer can update court booking details")
    booking_url = request.booking_url.strip()
    if urlparse(booking_url).scheme not in {"http", "https"}:
        raise HTTPException(status_code=422, detail="Booking link must start with http:// or https://")
    saved = repository.save_session(session.model_copy(update={
        "external_booking_url": booking_url,
        "booking_provider": request.provider.strip(),
        "booking_reference": request.booking_reference.strip() if request.booking_reference else None,
    }))
    post = repository.save_chat_post(ChatPost(
        id=f"booking-{session.id}-{uuid4().hex[:8]}",
        session_id=session.id,
        player_id=player.id,
        player_display_name=player.display_name,
        message=f"Court booked via {request.provider.strip()}." + (f" Booking reference: {request.booking_reference.strip()}." if request.booking_reference else " Open the booking link for details."),
        created_at=datetime.now(timezone.utc),
    ))
    for participant_id in session.confirmed_player_ids:
        if participant_id == player.id:
            continue
        try:
            repository.save_notification(AppNotification(
                id=f"booking-{session.id}-{participant_id}",
                player_id=participant_id,
                kind="booking_update",
                title="Court booking updated",
                message=f"{player.display_name} added the {request.provider.strip()} booking for {session.group_name}.",
                session_id=session.id,
                created_at=datetime.now(timezone.utc),
            ))
        except Exception:
            pass
    return saved


def _time_poll_label(start_time: time, end_time: time) -> str:
    return f"{start_time.strftime('%I:%M %p').lstrip('0')}–{end_time.strftime('%I:%M %p').lstrip('0')}"


def _time_poll_options(session: Session) -> list[TimePollOption]:
    if not session.time_window_start or not session.time_window_end:
        return []
    cursor = datetime.combine(session.session_date, session.time_window_start)
    window_end = datetime.combine(session.session_date, session.time_window_end)
    options: list[TimePollOption] = []
    while cursor + timedelta(minutes=session.duration_minutes) <= window_end:
        slot_end = cursor + timedelta(minutes=session.duration_minutes)
        options.append(TimePollOption(
            id=cursor.strftime("%H%M"),
            label=_time_poll_label(cursor.time(), slot_end.time()),
            start_time=cursor.time(),
            end_time=slot_end.time(),
        ))
        # Half-hour increments give a useful choice without overwhelming chat.
        cursor += timedelta(minutes=30)
    return options


@app.post("/v1/sessions/{session_id}/time-poll", response_model=ChatPost)
def create_time_poll(session_id: str, player: Player = Depends(get_current_player)) -> ChatPost:
    session = _member_session(session_id, player)
    _require_joinable_session(session)
    if session.time_finalized or not session.time_window_start or not session.time_window_end:
        raise HTTPException(status_code=409, detail="This game already has a fixed time")
    participant_ids = list(session.confirmed_player_ids)
    if len(participant_ids) < 2:
        raise HTTPException(status_code=409, detail="Start the poll once at least one other player has joined")
    existing = next((post for post in repository.list_chat_posts(session.id) if post.post_type == "time_poll" and post.poll_status == "open"), None)
    if existing:
        return existing
    options = _time_poll_options(session)
    if not options:
        raise HTTPException(status_code=422, detail="This time window cannot fit the selected game duration")
    return repository.save_chat_post(ChatPost(
        id=uuid4().hex,
        session_id=session.id,
        player_id=player.id,
        player_display_name=player.display_name,
        message=f"Pick the best {session.duration_minutes}-minute slot. The game time will lock once everyone votes.",
        post_type="time_poll",
        poll_options=options,
        poll_participant_ids=participant_ids,
        poll_status="open",
        created_at=datetime.now(timezone.utc),
    ))


@app.post("/v1/sessions/{session_id}/chat/{post_id}/vote", response_model=ChatPost)
def vote_on_time_poll(session_id: str, post_id: str, request: TimePollVoteRequest, player: Player = Depends(get_current_player)) -> ChatPost:
    session = _member_session(session_id, player)
    post = next((candidate for candidate in repository.list_chat_posts(session_id) if candidate.id == post_id), None)
    if not post or post.post_type != "time_poll":
        raise HTTPException(status_code=404, detail="Time poll not found")
    if post.poll_status == "resolved":
        return post
    if player.id not in post.poll_participant_ids:
        raise HTTPException(status_code=403, detail="Only players confirmed when this poll started can vote")
    selected = next((option for option in post.poll_options if option.id == request.option_id), None)
    if not selected:
        raise HTTPException(status_code=422, detail="Choose one of the available time slots")

    options: list[TimePollOption] = []
    for option in post.poll_options:
        voters = [voter_id for voter_id in option.voter_ids if voter_id != player.id]
        if option.id == selected.id:
            voters.append(player.id)
        options.append(option.model_copy(update={"voter_ids": voters}))
    voted_ids = {voter_id for option in options for voter_id in option.voter_ids}
    updates: dict[str, object] = {"poll_options": options}
    if set(post.poll_participant_ids).issubset(voted_ids):
        winner = sorted(options, key=lambda option: (-len(option.voter_ids), option.start_time, option.id))[0]
        updates.update({"poll_status": "resolved", "poll_winner_id": winner.id})
        session = repository.save_session(session.model_copy(update={
            "start_time": winner.start_time,
            "end_time": winner.end_time,
            "time_finalized": True,
        }))
        _index_session_best_effort(session)
        repository.save_chat_post(ChatPost(
            # A stable id makes finalization idempotent if a client retries.
            id=f"time-poll-finalized-{post.id}",
            session_id=session.id,
            player_id="system",
            player_display_name="CourtMate",
            message=f"Time confirmed for {winner.label}. Please book the court!",
            post_type="system",
            created_at=datetime.now(timezone.utc),
        ))
    return repository.save_chat_post(post.model_copy(update=updates))


@app.get("/v1/sessions/{session_id}/chat", response_model=ChatResponse)
def group_chat(session_id: str, player: Player = Depends(get_current_player)) -> ChatResponse:
    session = _member_session(session_id, player)
    return ChatResponse(session=session, posts=repository.list_chat_posts(session_id))


@app.post("/v1/sessions/{session_id}/chat", response_model=ChatPost)
def post_group_chat(session_id: str, request: ChatPostRequest, player: Player = Depends(get_current_player)) -> ChatPost:
    session = _member_session(session_id, player)
    message = request.message.strip()
    post_type = request.post_type
    teams = request.teams
    if post_type == "message":
        if not message:
            raise HTTPException(status_code=422, detail="Chat message is required")
        teams = _parse_chat_match_result(message, session)
        if teams:
            post_type = "match_result"
        else:
            _require_active_session(session)
    if post_type == "match_result":
        if session.status not in {"awaiting_feedback", "completed"}:
            raise HTTPException(status_code=409, detail="Record the final score after the game is marked complete")
        _validate_chat_match_teams(teams, session)
        if player.id not in {player_id for team in teams for player_id in team.player_ids}:
            raise HTTPException(status_code=403, detail="Only a player in the result can post its final score")
        if session.rating_mode == "competitive" and not _is_valid_competitive_result(session, teams):
            raise HTTPException(status_code=422, detail="Add a valid final score for both sides before confirming this competitive result")
        if not message:
            def team_label(team) -> str:
                names = []
                for player_id in team.player_ids:
                    member = repository.get_player(player_id)
                    if member:
                        names.append(member.display_name)
                return f"{team.name} ({' + '.join(names)})"

            message = f"Match result: {team_label(request.teams[0])} {request.teams[0].score}–{request.teams[1].score} {team_label(request.teams[1])}"
    post = repository.save_chat_post(ChatPost(
        id=uuid4().hex,
        session_id=session_id,
        player_id=player.id,
        player_display_name=player.display_name,
        message=message,
        post_type=post_type,
        teams=teams,
        result_status="pending_confirmation" if post_type == "match_result" else None,
        confirmation_ids=[player.id] if post_type == "match_result" else [],
        created_at=datetime.now(timezone.utc),
    ))
    return post


@app.post("/v1/sessions/{session_id}/chat/{post_id}/decision", response_model=ChatPost)
def decide_chat_match_result(session_id: str, post_id: str, request: ChatResultDecisionRequest, background_tasks: BackgroundTasks, player: Player = Depends(get_current_player)) -> ChatPost:
    session = _member_session(session_id, player)
    post = next((candidate for candidate in repository.list_chat_posts(session_id) if candidate.id == post_id), None)
    if not post or post.post_type != "match_result":
        raise HTTPException(status_code=404, detail="Match result not found")
    if post.result_status in {"confirmed", "disputed"}:
        return post
    if player.id not in {player_id for team in post.teams for player_id in team.player_ids}:
        raise HTTPException(status_code=403, detail="Only players in this result can confirm it")
    if not request.agree:
        return repository.save_chat_post(post.model_copy(update={"result_status": "disputed"}))
    if player.id in post.confirmation_ids:
        return post
    confirmation_ids = [*post.confirmation_ids, player.id]
    result_player_ids = {player_id for team in post.teams for player_id in team.player_ids}
    result_status = "confirmed" if result_player_ids.issubset(confirmation_ids) else "pending_confirmation"
    updated = repository.save_chat_post(post.model_copy(update={"confirmation_ids": confirmation_ids, "result_status": result_status}))
    if result_status == "confirmed":
        background_tasks.add_task(_refresh_cmr_ratings)
    return updated


@app.get("/v1/sessions/{session_id}/leaderboard", response_model=LeaderboardResponse)
def group_leaderboard(session_id: str, player: Player = Depends(get_current_player)) -> LeaderboardResponse:
    session = _member_session(session_id, player)
    return _leaderboard(session.confirmed_player_ids, f"group:{session_id}", session.sport)


def _all_participants_submitted_feedback(session: Session) -> bool:
    submitted_player_ids = {item.player_id for item in repository.list_feedback(session.id)}
    return set(session.confirmed_player_ids).issubset(submitted_player_ids)


@app.get("/v1/leaderboards/local", response_model=LeaderboardResponse)
def local_leaderboard(area: str | None = None, sport: Sport = "pickleball", player: Player = Depends(get_current_player)) -> LeaderboardResponse:
    requested_area = (area or player.area).strip().lower()
    local_players = [candidate for candidate in repository.list_players() if candidate.area.lower() == requested_area]
    return _leaderboard([candidate.id for candidate in local_players], f"local:{area or player.area}:{sport}", sport)


@app.get("/v1/me/circle-leaderboard", response_model=LeaderboardResponse)
def circle_leaderboard(
    scope: Literal["circle", "locality", "bengaluru"] = "circle",
    sport: Sport = "pickleball",
    player: Player = Depends(get_current_player),
) -> LeaderboardResponse:
    """Rank the player's accepted circle, locality, or Bengaluru by sport CMR."""
    players = repository.list_players()
    if scope == "circle":
        player_ids = {player.id}
        player_ids.update(record.following_id for record in repository.list_following(player.id))
        player_ids.update(record.follower_id for record in repository.list_followers(player.id))
    elif scope == "locality":
        requested_area = player.area.strip().lower()
        player_ids = {candidate.id for candidate in players if candidate.area.strip().lower() == requested_area and (candidate.id == player.id or not candidate.is_profile_private)}
    else:
        player_ids = {candidate.id for candidate in players if candidate.id == player.id or not candidate.is_profile_private}
    return _leaderboard(list(player_ids), f"circle:{scope}:{player.area}:{sport}", sport, players=players)


@app.post("/v1/sessions/{session_id}/complete", response_model=Session)
def complete_session(session_id: str, background_tasks: BackgroundTasks, player: Player = Depends(get_current_player)) -> Session:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if player.id not in session.confirmed_player_ids:
        raise HTTPException(status_code=403, detail="Only confirmed players can complete this game")
    if not session.time_finalized:
        if player.id != session.organizer_id or len(session.confirmed_player_ids) != 1:
            raise HTTPException(status_code=409, detail="Finalize the time poll in the Rally Circle before completing this game")
        # A solo game has no one else to poll. Preserve the original scheduled
        # slot so older form-created games can still be completed.
        session = repository.save_session(session.model_copy(update={"time_finalized": True}))
    if session.status == "cancelled":
        raise HTTPException(status_code=409, detail="Cancelled games cannot be completed")
    if session.status == "completed" or player.id in session.completed_player_ids:
        return session
    if session.status == "awaiting_feedback":
        # Feedback closes automatically once every confirmed player submits.
        # Repeating the action must never discard the remaining private ratings.
        return session
    # Manual completion is personal. The scheduled end-time transition remains
    # shared, but one player finishing early must not close the game for others.
    completed_player_ids = list(dict.fromkeys([*session.completed_player_ids, player.id]))
    all_players_done = set(session.confirmed_player_ids).issubset(completed_player_ids)
    session.completed_player_ids = completed_player_ids
    if all_players_done:
        session.status = "awaiting_feedback"
    session.social_activity_published = False
    saved = repository.save_session(session)
    _clear_read_view_cache()
    _clear_social_feed_cache()
    background_tasks.add_task(_index_session_best_effort, saved)
    return saved


@app.post("/v1/groups", response_model=CreatedGroupResponse)
def create_group(background_tasks: BackgroundTasks, request: CreateGroupRequest, player: Player = Depends(get_current_player)) -> CreatedGroupResponse:
    intent = _parse_intent(request.query, request.sport, player)
    proposal = _group_proposal(intent, player.id, request.group_name, request.query)
    overrides = request.model_dump(exclude_none=True, exclude={
        "query", "group_name", "sport", "visibility",
        "time_window_start", "time_window_end", "duration_minutes", "rating_mode",
    })
    session_visibility = request.visibility or player.default_session_visibility
    if request.area:
        coordinates = _geocode_area(request.area)
        overrides.update({"area": request.area, "latitude": coordinates[0] if coordinates else None, "longitude": coordinates[1] if coordinates else None})
    proposal = proposal.model_copy(update=overrides)
    session_date = proposal.session_date or _local_today()
    time_window_start = request.time_window_start
    time_window_end = request.time_window_end
    uses_time_window = time_window_start is not None or time_window_end is not None
    if uses_time_window and (time_window_start is None or time_window_end is None):
        raise HTTPException(status_code=422, detail="Choose both the start and end of the time window")
    if uses_time_window:
        assert time_window_start is not None and time_window_end is not None
        window_minutes = int((datetime.combine(session_date, time_window_end) - datetime.combine(session_date, time_window_start)).total_seconds() / 60)
        if window_minutes < request.duration_minutes:
            raise HTTPException(status_code=422, detail="The time window must be at least as long as the game duration")
        start_time = time_window_start
        end_time = (datetime.combine(session_date, start_time) + timedelta(minutes=request.duration_minutes)).time()
    else:
        start_time = proposal.start_time or time(19)
        end_time = proposal.end_time or (datetime.combine(session_date, start_time) + timedelta(hours=2)).time()
    if session_date < _local_today():
        raise HTTPException(status_code=422, detail="Choose today or a future date")
    if session_date == _local_today() and datetime.combine(session_date, start_time, tzinfo=local_timezone) <= datetime.now(local_timezone):
        raise HTTPException(status_code=422, detail="Game start time must be in the future")
    if end_time <= start_time:
        raise HTTPException(status_code=422, detail="End time must be after start time")
    if proposal.skill_min > proposal.skill_max:
        raise HTTPException(status_code=422, detail="Minimum skill must not exceed maximum skill")
    if request.game_format == "singles" and request.capacity != 2:
        raise HTTPException(status_code=422, detail="Singles games must have exactly 2 total players")
    if request.game_format == "doubles" and request.capacity not in {4, 6, 8}:
        raise HTTPException(status_code=422, detail="Doubles games must have 4, 6, or 8 total players")
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
        time_window_start=time_window_start,
        time_window_end=time_window_end,
        duration_minutes=request.duration_minutes if uses_time_window else 60,
        time_finalized=not uses_time_window,
        skill_min=proposal.skill_min,
        skill_max=proposal.skill_max,
        skill_scale=10,
        style=proposal.style,
        rating_mode=request.rating_mode,
        game_format=request.game_format,
        sport=proposal.sport,
        capacity=request.capacity,
        confirmed_player_ids=[player.id],
        visibility=session_visibility,
    )
    saved_session = repository.save_session(session)
    background_tasks.add_task(_index_session_best_effort, saved_session)
    background_tasks.add_task(_notify_players_about_game, saved_session)
    return CreatedGroupResponse(session=saved_session, message="Group created. Compatible nearby players have been notified.")


@app.get("/v1/sessions/{session_id}/replacement", response_model=ReplacementResponse)
def replacement(session_id: str, player: Player = Depends(get_current_player)) -> ReplacementResponse:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return ReplacementResponse(session=session, candidates=suggest_replacements(session, repository.list_players()))


@app.post("/v1/sessions/{session_id}/feedback", response_model=Feedback)
def feedback(session_id: str, request: FeedbackRequest, background_tasks: BackgroundTasks, player: Player = Depends(get_current_player)) -> Feedback:
    session = _member_session(session_id, player)
    if session.status not in {"awaiting_feedback", "completed"} and player.id not in session.completed_player_ids:
        raise HTTPException(status_code=409, detail="Rate players after the game is marked done")
    confirmed_others = [player_id for player_id in session.confirmed_player_ids if player_id != player.id]
    skipped_player_ids = set(request.skipped_player_ids)
    if request.player_order or request.skipped_player_ids:
        if skipped_player_ids - set(confirmed_others) or len(skipped_player_ids) != len(request.skipped_player_ids):
            raise HTTPException(status_code=422, detail="Only other confirmed players can be skipped")
        if set(request.player_order) & skipped_player_ids or len(request.player_order) != len(set(request.player_order)):
            raise HTTPException(status_code=422, detail="A player cannot be both ranked and skipped")
        if set(request.player_order) | skipped_player_ids != set(confirmed_others):
            raise HTTPException(status_code=422, detail="Rank or skip every other confirmed player")
    if request.player_order:
        denominator = max(len(request.player_order) - 1, 1)
        ranked_ratings = [
            PlayerRating(player_id=player_id, rank_score=round(100 - (index * 100 / denominator), 2))
            for index, player_id in enumerate(request.player_order)
        ]
        ratings = [*ranked_ratings, *request.ratings]
    else:
        ratings = request.ratings
    if request.player_id and request.rating is not None:
        ratings = [*ratings, PlayerRating(player_id=request.player_id, rating=request.rating)]
    rated_player_ids = [rating.player_id for rating in ratings]
    if len(rated_player_ids) != len(set(rated_player_ids)):
        raise HTTPException(status_code=422, detail="Rate each player only once")
    if any(rating.rating_10 is not None for rating in ratings) and set(rated_player_ids) != set(confirmed_others):
        raise HTTPException(status_code=422, detail="Rate every other confirmed player before submitting")
    for rating in ratings:
        if rating.player_id == player.id:
            raise HTTPException(status_code=422, detail="You cannot rate yourself")
        if rating.player_id not in session.confirmed_player_ids:
            raise HTTPException(status_code=422, detail="You can only rate players from this group")
        if rating.skill_level is None and rating.rating is None and rating.rating_10 is None and rating.rank_score is None:
            raise HTTPException(status_code=422, detail="Choose a rating for this player")
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
    saved = repository.save_feedback(Feedback(session_id=session_id, created_at=datetime.now(timezone.utc), player_id=player.id, match_quality=request.match_quality, fun=request.fun, fairness=request.fairness, would_return=request.would_return, ratings=ratings, teams=request.teams))
    _clear_read_view_cache()
    if session.status == "awaiting_feedback" and _all_participants_submitted_feedback(session):
        completed = session.model_copy(update={
            "status": "completed",
            "social_activity_published": False,
            "social_activity_published_at": None,
        })
        repository.save_session(completed)
        _clear_social_feed_cache()
        background_tasks.add_task(_index_session_best_effort, completed)
    background_tasks.add_task(_refresh_community_scores)
    background_tasks.add_task(_refresh_cmr_ratings)
    return saved


def _analyze_activity_image(image_url: str):
    parsed_url = urlparse(image_url)
    if parsed_url.scheme != "https" or parsed_url.hostname not in {"firebasestorage.googleapis.com", "storage.googleapis.com"}:
        raise HTTPException(status_code=422, detail="Tracker screenshot must be stored in Google Cloud Storage")
    if not intent_parser.image_analysis_available:
        raise HTTPException(status_code=503, detail="Gemini image analysis is not configured")
    try:
        download_request = Request(image_url, headers={"Accept": "image/*"})
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
    return analysis


@app.get("/v1/me/activity-proofs", response_model=ActivityProofsResponse)
def my_activity_proofs(player: Player = Depends(get_current_player)) -> ActivityProofsResponse:
    return ActivityProofsResponse(proofs=repository.list_activity_proofs(player_id=player.id))


@app.post("/v1/me/activity-proof/analyze", response_model=ActivityProof)
def analyze_profile_activity_proof(request: ActivityProofRequest, player: Player = Depends(get_current_player)) -> ActivityProof:
    analysis = _analyze_activity_image(request.image_url)
    proof = ActivityProof(id=f"proof-{uuid4().hex[:12]}", session_id="profile", player_id=player.id, image_url=request.image_url, sport=request.sport, analysis=analysis, created_at=datetime.now(timezone.utc))
    return repository.save_activity_proof(proof)


@app.post("/v1/me/performance-chat", response_model=PerformanceChatResponse)
def performance_chat(request: PerformanceChatRequest, player: Player = Depends(get_current_player)) -> PerformanceChatResponse:
    if not intent_parser.is_performance_query(request.query):
        return PerformanceChatResponse(scope="out_of_scope", answer="I can discuss your CourtMate racket-sport history, CMR, game trends, and uploaded wearable stats. Ask me about one of those.")
    history = {sport: [point.model_dump(mode="json") for point in points] for sport, points in player.cmr_history.items()}
    proofs = [
        {
            "sport": proof.sport,
            "created_at": proof.created_at.isoformat(),
            "analysis": proof.analysis.model_dump(mode="json"),
        }
        for proof in repository.list_activity_proofs(player_id=player.id)
    ]
    try:
        answer = intent_parser.discuss_performance(request.query, player, history, proofs)
    except Exception as error:
        raise HTTPException(status_code=502, detail="Performance coach is temporarily unavailable") from error
    return PerformanceChatResponse(answer=answer)


@app.post("/v1/sessions/{session_id}/activity-proof/analyze", response_model=ActivityProof)
def analyze_activity_proof(session_id: str, request: ActivityProofRequest, player: Player = Depends(get_current_player)) -> ActivityProof:
    session = _member_session(session_id, player)
    if session.status != "completed":
        raise HTTPException(status_code=409, detail="Attach tracker stats after the game is complete")
    analysis = _analyze_activity_image(request.image_url)
    proof = ActivityProof(id=f"proof-{uuid4().hex[:12]}", session_id=session.id, player_id=player.id, image_url=request.image_url, sport=session.sport, analysis=analysis, created_at=datetime.now(timezone.utc))
    return repository.save_activity_proof(proof)


# Keep CORS outside FastAPI's server-error middleware so browser clients can
# read an API error response instead of reporting a misleading CORS failure.
app = CORSMiddleware(
    app=app,
    allow_origins=allowed_origins or ["http://localhost:3000"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
