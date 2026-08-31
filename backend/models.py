from datetime import date as date_type, datetime, time
from typing import Literal

from pydantic import BaseModel, Field

Sport = Literal["pickleball", "badminton", "tennis", "padel", "squash", "table_tennis"]
RatingSource = Literal["dupr", "organizer_confirmed", "synthetic", "self_reported", "unrated"]
SkillLevel = Literal["beginner", "intermediate", "advanced"]
Gender = Literal["woman", "man", "non_binary", "prefer_not_to_say"]
AgeRange = Literal["any", "18_24", "25_34", "35_44", "45_plus"]
SessionVisibility = Literal["public", "followers", "private"]


class CMRHistoryPoint(BaseModel):
    session_id: str
    session_date: date_type
    group_name: str
    game_rating: float | None = Field(default=None, ge=0, le=100)
    rating: float | None = Field(default=None, ge=0, le=100)
    delta: float | None = None


class SearchIntent(BaseModel):
    sport: Sport = "pickleball"
    area: str = "Whitefield"
    date: date_type | None = None
    start_time: time | None = None
    end_time: time | None = None
    skill_min: float | None = Field(default=None, ge=1, le=8)
    skill_max: float | None = Field(default=None, ge=1, le=8)
    style: Literal["casual", "social", "competitive", "any"] = "any"
    open_slots_required: int = Field(default=1, ge=1, le=8)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class Player(BaseModel):
    id: str
    display_name: str
    bio: str = Field(default="", max_length=240)
    is_profile_private: bool = False
    default_session_visibility: SessionVisibility = "public"
    profile_image_url: str | None = None
    area: str
    age: int | None = Field(default=None, ge=13, le=100)
    gender: Gender | None = None
    preferred_age_range: AgeRange = "any"
    preferred_genders: list[Gender] = Field(default_factory=list)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    travel_radius_km: float = Field(default=10.0, ge=1, le=100)
    skill_levels: dict[str, SkillLevel] = Field(default_factory=dict)
    dupr_rating: float | None = Field(default=None, ge=1, le=8)
    rating_source: RatingSource = "unrated"
    rating_confidence: float = Field(default=0.0, ge=0, le=1)
    sport_ratings: dict[str, float] = Field(default_factory=dict)
    rating_sources: dict[str, RatingSource] = Field(default_factory=dict)
    availability: list[str] = Field(default_factory=list)
    style: Literal["casual", "social", "competitive"] = "casual"
    reliability: float = Field(default=0.75, ge=0, le=1)
    community_score: float | None = Field(default=None, ge=1, le=5)
    community_rating_count: int = Field(default=0, ge=0)
    community_scores: dict[str, float] = Field(default_factory=dict)
    community_rating_counts: dict[str, int] = Field(default_factory=dict)
    cmr_ratings: dict[str, float] = Field(default_factory=dict)
    cmr_game_counts: dict[str, int] = Field(default_factory=dict)
    cmr_history: dict[str, list[CMRHistoryPoint]] = Field(default_factory=dict)
    cmr_scale: Literal[8, 100] = 8
    friends: list[str] = Field(default_factory=list)
    opted_into_replacement_pool: bool = True


def rating_for_sport(player: Player, sport: Sport) -> float | None:
    """Return a rating in the legacy 1-8 compatibility scale for matching."""
    if sport in player.cmr_ratings:
        value = player.cmr_ratings[sport]
        return round(1 + value * 7 / 100, 2) if player.cmr_scale == 100 else value
    if sport in player.sport_ratings:
        return player.sport_ratings[sport]
    if sport == "pickleball" and player.dupr_rating is not None:
        return player.dupr_rating
    return None


def cmr_from_legacy_rating(rating: float) -> float:
    """Convert the former 1-8 CMR scale to the new 0-100 display scale."""
    return round(max(0.0, min(100.0, (rating - 1) * 100 / 7)), 2)


def normalize_cmr_player(player: Player) -> Player:
    """Upgrade old persisted CMR values without changing DUPR or skill bands."""
    if player.cmr_scale == 100:
        return player
    cmr_ratings = {sport: cmr_from_legacy_rating(rating) for sport, rating in player.cmr_ratings.items()}
    cmr_history = {
        sport: [
            point.model_copy(
                update={
                    "game_rating": cmr_from_legacy_rating(point.game_rating) if point.game_rating is not None else None,
                    "rating": cmr_from_legacy_rating(point.rating) if point.rating is not None else None,
                    "delta": round(point.delta * 100 / 7, 2) if point.delta is not None else None,
                }
            )
            for point in history
        ]
        for sport, history in player.cmr_history.items()
    }
    return player.model_copy(update={"cmr_ratings": cmr_ratings, "cmr_history": cmr_history, "cmr_scale": 100})


def baseline_rating_for_sport(player: Player, sport: Sport) -> float | None:
    """Return only an external rating used to seed the first CMR calculation."""
    if sport in player.sport_ratings:
        return player.sport_ratings[sport]
    if sport == "pickleball" and player.dupr_rating is not None:
        return player.dupr_rating
    return None


class ProfileGameSummary(BaseModel):
    id: str
    group_name: str
    sport: Sport
    area: str
    session_date: date_type
    start_time: time
    status: str


class PublicPlayerProfile(BaseModel):
    id: str
    display_name: str
    bio: str = ""
    profile_image_url: str | None = None
    area: str
    dupr_rating: float | None = Field(default=None, ge=1, le=8)
    rating_source: RatingSource = "unrated"
    rating_confidence: float = Field(default=0.0, ge=0, le=1)
    sport_ratings: dict[str, float] = Field(default_factory=dict)
    rating_sources: dict[str, RatingSource] = Field(default_factory=dict)
    style: Literal["casual", "social", "competitive"] = "casual"
    reliability: float = Field(default=0.75, ge=0, le=1)
    community_score: float | None = Field(default=None, ge=1, le=5)
    community_rating_count: int = Field(default=0, ge=0)
    community_scores: dict[str, float] = Field(default_factory=dict)
    community_rating_counts: dict[str, int] = Field(default_factory=dict)
    cmr_ratings: dict[str, float] = Field(default_factory=dict)
    cmr_game_counts: dict[str, int] = Field(default_factory=dict)
    followers_count: int = Field(default=0, ge=0)
    following_count: int = Field(default=0, ge=0)
    is_following: bool = False
    follow_request_pending: bool = False
    follows_you: bool = False
    recent_games: list["ProfileGameSummary"] = Field(default_factory=list)
    activity_by_date: dict[str, int] = Field(default_factory=dict)
    weekly_streak: int = Field(default=0, ge=0)
    weekly_streak_active: bool = False


class FollowRecord(BaseModel):
    id: str
    follower_id: str
    following_id: str
    status: Literal["pending", "accepted"] = "accepted"
    created_at: datetime


class PublicPlayerProfilesResponse(BaseModel):
    profiles: list[PublicPlayerProfile]


class ProfileUpdateRequest(BaseModel):
    bio: str | None = Field(default=None, max_length=240)
    is_profile_private: bool | None = None
    default_session_visibility: SessionVisibility | None = None
    area: str | None = None
    age: int | None = Field(default=None, ge=13, le=100)
    gender: Gender | None = None
    preferred_age_range: AgeRange | None = None
    preferred_genders: list[Gender] | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    travel_radius_km: float | None = Field(default=None, ge=1, le=100)
    dupr_rating: float | None = Field(default=None, ge=1, le=8)
    sport: Sport | None = None
    skill_level: SkillLevel | None = None
    # Kept for backwards-compatible API clients; the frontend no longer asks for it.
    skill_rating: float | None = Field(default=None, ge=1, le=8)
    style: Literal["casual", "social", "competitive"] | None = None
    availability: list[str] | None = None


class ProfileImageUpdateRequest(BaseModel):
    profile_image_url: str | None = Field(default=None, max_length=2048)


class ProfileImageUploadRequest(BaseModel):
    content_type: Literal["image/jpeg", "image/png", "image/webp"]


class ProfileImageUploadResponse(BaseModel):
    upload_url: str
    image_url: str
    object_name: str
    expires_in: int


class SportyAvatarRequest(BaseModel):
    sport: Sport
    source_image_url: str = Field(min_length=1, max_length=2048)


class SportyAvatarResponse(BaseModel):
    options: list[str] = Field(default_factory=list, max_length=3)


class Session(BaseModel):
    id: str
    group_name: str
    organizer_id: str
    area: str
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    venue_name: str | None = None
    session_date: date_type
    start_time: time
    end_time: time
    skill_min: float = Field(ge=1, le=8)
    skill_max: float = Field(ge=1, le=8)
    style: Literal["casual", "social", "competitive"]
    game_format: Literal["singles", "doubles"] = "doubles"
    capacity: int = Field(ge=2, le=16)
    confirmed_player_ids: list[str] = Field(default_factory=list)
    waitlist_player_ids: list[str] = Field(default_factory=list)
    external_booking_url: str | None = None
    booking_provider: str | None = None
    booking_reference: str | None = None
    status: Literal["open", "full", "in_progress", "awaiting_feedback", "completed", "cancelled"] = "open"
    sport: Sport = "pickleball"
    visibility: SessionVisibility = "public"
    social_activity_published: bool = False
    social_activity_published_at: datetime | None = None

    @property
    def open_slots(self) -> int:
        return max(self.capacity - len(self.confirmed_player_ids), 0)


class RecommendationReason(BaseModel):
    skill_fit: float
    availability_fit: float
    area_fit: float
    style_fit: float
    reliability: float
    familiarity: float
    distance_km: float | None = None
    explanation: str


class SessionRecommendation(BaseModel):
    session: Session
    score: float
    reasons: RecommendationReason


class ExploreSessionsResponse(BaseModel):
    recommendations: list[SessionRecommendation] = Field(default_factory=list)


class PlayerDensityPoint(BaseModel):
    area: str
    player_count: int = Field(ge=3)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    cmr_min: float | None = Field(default=None, ge=0, le=100)
    cmr_max: float | None = Field(default=None, ge=0, le=100)
    distance_km: float | None = Field(default=None, ge=0)
    intensity: Literal["warm", "hot", "very_hot"]
    activity_score: float = Field(default=0, ge=0, le=100)
    active_game_count: int = Field(default=0, ge=0)
    community_count: int = Field(default=0, ge=0)


class PlayerDensityResponse(BaseModel):
    sport: Sport
    radius_km: float
    points: list[PlayerDensityPoint] = Field(default_factory=list)


class CommunityActivityPoint(BaseModel):
    community_id: str
    name: str
    sport: Sport
    area: str
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    active_player_count: int = Field(ge=0)
    upcoming_game_count: int = Field(ge=0)
    activity_score: float = Field(ge=0, le=100)
    quality_score: float = Field(ge=0, le=100)


class MapNearbyGame(BaseModel):
    id: str
    group_name: str
    sport: Sport
    area: str
    venue_name: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    session_date: date_type
    start_time: time
    end_time: time
    open_slots: int = Field(ge=0)
    skill_min: float = Field(ge=0, le=100)
    skill_max: float = Field(ge=0, le=100)
    distance_km: float | None = Field(default=None, ge=0)
    match_score: float = Field(default=0, ge=0, le=100)


class GameCluster(BaseModel):
    cluster_id: str
    area: str
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    game_count: int = Field(ge=1)
    open_slot_count: int = Field(ge=0)
    game_ids: list[str] = Field(default_factory=list, max_length=50)


class CommunityMapResponse(BaseModel):
    sport: Sport
    center_latitude: float | None = Field(default=None, ge=-90, le=90)
    center_longitude: float | None = Field(default=None, ge=-180, le=180)
    radius_km: float
    player_density: list[PlayerDensityPoint] = Field(default_factory=list)
    community_activity: list[CommunityActivityPoint] = Field(default_factory=list)
    game_clusters: list[GameCluster] = Field(default_factory=list)
    nearby_games: list[MapNearbyGame] = Field(default_factory=list)
    generated_at: datetime


class CommunityLeaderboardEntry(BaseModel):
    rank: int
    community_id: str
    name: str
    sport: Sport
    area: str
    quality_score: float = Field(ge=0, le=100)
    completed_games: int = Field(ge=3)
    active_players: int = Field(ge=0)
    average_match_quality: float = Field(ge=1, le=5)
    feedback_completion_rate: float = Field(ge=0, le=1)
    repeat_play_rate: float = Field(ge=0, le=1)
    average_cmr_improvement: float
    average_reliability: float = Field(ge=0, le=1)
    badge: Literal["best_quality", "most_improved", "most_reliable", "fastest_growing"] | None = None


class CommunityLeaderboardResponse(BaseModel):
    sport: Sport
    area: str | None = None
    entries: list[CommunityLeaderboardEntry] = Field(default_factory=list)


class Facility(BaseModel):
    id: str
    name: str
    sport: Sport
    area: str
    phone: str | None = None
    booking_method: str
    booking_url: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    distance_km: float | None = Field(default=None, ge=0)


class FacilityListResponse(BaseModel):
    sport: Sport
    area: str | None = None
    facilities: list[Facility] = Field(default_factory=list)


class CommunityMembership(BaseModel):
    id: str
    community_id: str
    player_id: str
    sport: Sport
    area: str
    joined_at: datetime


class CommunityJoinRequest(BaseModel):
    sport: Sport
    area: str = Field(min_length=1, max_length=100)


class CommunityMembershipResponse(BaseModel):
    memberships: list[CommunityMembership] = Field(default_factory=list)


class GroupProposal(BaseModel):
    group_name: str
    area: str
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    venue_name: str | None = None
    session_date: date_type | None = None
    start_time: time | None = None
    end_time: time | None = None
    skill_min: float
    skill_max: float
    style: Literal["casual", "social", "competitive"]
    game_format: Literal["singles", "doubles"] = "doubles"
    capacity: int = Field(default=6, ge=2, le=16)
    sport: Sport = "pickleball"
    explanation: str


class SearchDecision(BaseModel):
    action: Literal["join_existing", "create_group"]
    summary: str
    ranked_session_ids: list[str] = Field(default_factory=list)
    proposed_group_name: str | None = None


class PlayerRecommendation(BaseModel):
    player: Player
    score: float
    explanation: str


class SearchResponse(BaseModel):
    intent: SearchIntent
    recommendations: list[SessionRecommendation]
    action: Literal["join_existing", "create_group"] = "join_existing"
    message: str = ""
    group_proposal: GroupProposal | None = None
    scope: Literal["court_discovery", "sports_general", "out_of_scope"] = "court_discovery"
    retrieval: "RetrievalTrace | None" = None


class SearchDocument(BaseModel):
    """A sanitized, searchable projection of an operational record."""

    id: str
    source_type: Literal["session", "player", "venue", "faq"]
    source_id: str
    content: str
    embedding: list[float] = Field(default_factory=list)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    embedding_model: str
    embedding_version: str = "v1"


class VectorSearchResult(BaseModel):
    document: SearchDocument
    distance: float | None = None


class RetrievalTrace(BaseModel):
    mode: Literal["vector", "deterministic_fallback"]
    candidate_count: int = 0
    grounded_result_count: int = 0
    embedding_version: str | None = None
    fallback_reason: str | None = None


SearchResponse.model_rebuild()


class ReplacementResponse(BaseModel):
    session: Session
    candidates: list[PlayerRecommendation]


class ParseRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    player_id: str | None = None
    sport: Sport | None = None
    mode: Literal["exact", "profile"] = "exact"
    context: str | None = Field(default=None, max_length=500)


class JoinRequestRequest(BaseModel):
    pass


class JoinRequestDecisionRequest(BaseModel):
    status: Literal["approved", "declined"]


class JoinRequest(BaseModel):
    id: str
    session_id: str
    player_id: str
    player_display_name: str | None = None
    status: Literal["pending", "approved", "declined", "waitlisted", "withdrawn"] = "pending"
    created_at: datetime


class AppNotification(BaseModel):
    id: str
    player_id: str
    kind: Literal["game_match", "game_reminder", "game_completed", "join_request", "request_update", "follow"] = "game_match"
    title: str
    message: str
    session_id: str
    request_id: str | None = None
    actor_id: str | None = None
    read: bool = False
    created_at: datetime


class JoinRequestsResponse(BaseModel):
    session: Session
    requests: list[JoinRequest]


class JoinRequestView(BaseModel):
    request: JoinRequest
    session: Session


class MyRequestsResponse(BaseModel):
    requests: list[JoinRequestView]


class NotificationsResponse(BaseModel):
    notifications: list[AppNotification]


class IncomingRequestsResponse(BaseModel):
    requests: list[JoinRequestView]


class MyGroupsResponse(BaseModel):
    groups: list[Session]


class PastGame(BaseModel):
    session: Session
    rank: int | None = None
    score: float | None = None
    ratings_count: int = 0
    group_size: int


class MyGamesResponse(BaseModel):
    games: list[Session]
    past_games: list[PastGame] = Field(default_factory=list)


class MyActivityResponse(BaseModel):
    """The data needed to render every Games tab in one authenticated read."""

    requests: list[JoinRequestView] = Field(default_factory=list)
    incoming_requests: list[JoinRequestView] = Field(default_factory=list)
    groups: list[Session] = Field(default_factory=list)
    games: list[Session] = Field(default_factory=list)
    awaiting_feedback: list[Session] = Field(default_factory=list)
    past_games: list[PastGame] = Field(default_factory=list)


class ActivityProofAnalysis(BaseModel):
    calories_burned: float | None = Field(default=None, ge=0, le=10000)
    duration_minutes: float | None = Field(default=None, ge=0, le=1440)
    active_minutes: float | None = Field(default=None, ge=0, le=1440)
    distance_km: float | None = Field(default=None, ge=0, le=1000)
    steps: int | None = Field(default=None, ge=0, le=200000)
    average_heart_rate: int | None = Field(default=None, ge=0, le=250)
    summary: str = Field(default="Tracker stats extracted from the uploaded screenshot.", max_length=240)
    confidence: float = Field(default=0.0, ge=0, le=1)


class ActivityProof(BaseModel):
    id: str
    session_id: str
    player_id: str
    image_url: str
    sport: Sport = "pickleball"
    analysis: ActivityProofAnalysis
    created_at: datetime


class ActivityProofRequest(BaseModel):
    image_url: str = Field(min_length=1, max_length=2048)
    sport: Sport = "pickleball"


class ActivityProofsResponse(BaseModel):
    proofs: list[ActivityProof] = Field(default_factory=list)


class PerformanceChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)


class PerformanceChatResponse(BaseModel):
    answer: str
    scope: Literal["performance", "out_of_scope"] = "performance"


class GroupViewResponse(BaseModel):
    session: Session
    members: list[PublicPlayerProfile]
    waitlist: list[PublicPlayerProfile] = Field(default_factory=list)
    activity_proofs: list[ActivityProof] = Field(default_factory=list)


class ChatPostRequest(BaseModel):
    message: str = Field(default="", max_length=500)
    post_type: Literal["message", "match_result"] = "message"
    teams: list["MatchTeam"] = Field(default_factory=list, max_length=2)


class BookingUpdateRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    booking_url: str = Field(min_length=1, max_length=2048)
    booking_reference: str | None = Field(default=None, max_length=120)


class ChatResultDecisionRequest(BaseModel):
    agree: bool


class ChatPost(BaseModel):
    id: str
    session_id: str
    player_id: str
    player_display_name: str
    message: str
    post_type: Literal["message", "match_result"] = "message"
    teams: list["MatchTeam"] = Field(default_factory=list)
    result_status: Literal["pending_confirmation", "confirmed", "disputed"] | None = None
    confirmation_ids: list[str] = Field(default_factory=list)
    created_at: datetime


class SocialPostCreateRequest(BaseModel):
    caption: str = Field(min_length=1, max_length=500)
    sport: Sport = "pickleball"
    session_id: str | None = None
    media_url: str | None = Field(default=None, max_length=2048)
    media_type: Literal["image", "video"] | None = None


class SocialPost(BaseModel):
    id: str
    player_id: str
    player_display_name: str
    profile_image_url: str | None = None
    sport: Sport = "pickleball"
    session_id: str | None = None
    caption: str
    media_url: str | None = None
    media_type: Literal["image", "video"] | None = None
    liked_by: list[str] = Field(default_factory=list)
    comment_count: int = Field(default=0, ge=0)
    share_count: int = Field(default=0, ge=0)
    created_at: datetime


class SocialCommentCreateRequest(BaseModel):
    message: str = Field(min_length=1, max_length=300)


class SocialComment(BaseModel):
    id: str
    post_id: str
    player_id: str
    player_display_name: str
    profile_image_url: str | None = None
    message: str
    created_at: datetime


class SocialPostView(BaseModel):
    id: str
    player_id: str
    player_display_name: str
    profile_image_url: str | None = None
    sport: Sport = "pickleball"
    session_id: str | None = None
    session_name: str | None = None
    session_date: date_type | None = None
    session_area: str | None = None
    caption: str
    media_url: str | None = None
    media_type: Literal["image", "video"] | None = None
    media_urls: list[str] = Field(default_factory=list, max_length=6)
    like_count: int = Field(default=0, ge=0)
    comment_count: int = Field(default=0, ge=0)
    share_count: int = Field(default=0, ge=0)
    liked_by_me: bool = False
    created_at: datetime
    activity_type: Literal["post", "session"] = "post"
    session_status: str | None = None
    session_players: list["SocialSessionPlayer"] = Field(default_factory=list)
    session_leaderboard: list["SocialLeaderboardEntry"] = Field(default_factory=list)


class SocialSessionPlayer(BaseModel):
    id: str
    display_name: str
    profile_image_url: str | None = None
    cmr_rating: float | None = Field(default=None, ge=0, le=100)


class SocialLeaderboardEntry(BaseModel):
    rank: int
    player_id: str
    display_name: str
    profile_image_url: str | None = None
    cmr_rating: float | None = Field(default=None, ge=0, le=100)
    cmr_delta: float | None = None
    wins: int = 0
    losses: int = 0
    table_points: int = 0


SocialPostView.model_rebuild()


class SocialFeedResponse(BaseModel):
    posts: list[SocialPostView] = Field(default_factory=list)


class SocialCommentsResponse(BaseModel):
    comments: list[SocialComment] = Field(default_factory=list)


class ChatResponse(BaseModel):
    session: Session
    posts: list[ChatPost]


class CreateGroupRequest(BaseModel):
    query: str
    group_name: str | None = None
    sport: Sport | None = None
    area: str | None = None
    session_date: date_type | None = None
    start_time: time | None = None
    end_time: time | None = None
    skill_min: float | None = Field(default=None, ge=1, le=8)
    skill_max: float | None = Field(default=None, ge=1, le=8)
    style: Literal["casual", "social", "competitive"] | None = None
    game_format: Literal["singles", "doubles"] = "doubles"
    capacity: int = Field(default=6, ge=2, le=16)
    visibility: SessionVisibility | None = None


class CreatedGroupResponse(BaseModel):
    session: Session
    message: str


class FeedbackRequest(BaseModel):
    player_id: str | None = None
    rating: int | None = Field(default=None, ge=1, le=5)
    match_quality: int = Field(default=5, ge=1, le=5)
    fun: int = Field(ge=1, le=5)
    fairness: int = Field(ge=1, le=5)
    would_return: bool
    ratings: list["PlayerRating"] = Field(default_factory=list)
    # Ordered from strongest to weakest for this session. The server converts
    # the order into a bounded CMR signal so clients do not submit raw scores.
    player_order: list[str] = Field(default_factory=list, max_length=16)
    skipped_player_ids: list[str] = Field(default_factory=list, max_length=16)
    teams: list["MatchTeam"] = Field(default_factory=list, max_length=4)
    photo_urls: list[str] = Field(default_factory=list, max_length=6)


class PlayerRating(BaseModel):
    player_id: str
    skill_level: SkillLevel | None = None
    rank_score: float | None = Field(default=None, ge=0, le=100)
    # New post-game feedback uses a simple 1-10 player performance rating.
    rating_10: int | None = Field(default=None, ge=1, le=10)
    # Kept for old feedback documents and API clients.
    rating: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = Field(default=None, max_length=300)


class MatchTeam(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    player_ids: list[str] = Field(min_length=1, max_length=8)
    score: int | None = Field(default=None, ge=0, le=999)


class Feedback(BaseModel):
    session_id: str
    player_id: str
    match_quality: int = Field(default=5, ge=1, le=5)
    fun: int
    fairness: int
    would_return: bool
    ratings: list[PlayerRating] = Field(default_factory=list)
    teams: list[MatchTeam] = Field(default_factory=list)
    created_at: datetime


class LeaderboardEntry(BaseModel):
    rank: int
    player: PublicPlayerProfile
    score: float
    ratings_count: int


class LeaderboardResponse(BaseModel):
    scope: str
    entries: list[LeaderboardEntry]
