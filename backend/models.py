from datetime import date as date_type, datetime, time
from typing import Literal

from pydantic import BaseModel, Field

Sport = Literal["pickleball", "badminton", "tennis", "padel", "squash", "table_tennis"]
RatingSource = Literal["dupr", "organizer_confirmed", "synthetic", "self_reported", "unrated"]
SkillLevel = Literal["beginner", "intermediate", "advanced"]
Gender = Literal["woman", "man", "non_binary", "prefer_not_to_say"]
AgeRange = Literal["any", "18_24", "25_34", "35_44", "45_plus"]


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
    follows_you: bool = False
    recent_games: list["ProfileGameSummary"] = Field(default_factory=list)
    activity_by_date: dict[str, int] = Field(default_factory=dict)


class FollowRecord(BaseModel):
    id: str
    follower_id: str
    following_id: str
    created_at: datetime


class PublicPlayerProfilesResponse(BaseModel):
    profiles: list[PublicPlayerProfile]


class ProfileUpdateRequest(BaseModel):
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
    capacity: int = Field(ge=2, le=16)
    confirmed_player_ids: list[str] = Field(default_factory=list)
    waitlist_player_ids: list[str] = Field(default_factory=list)
    external_booking_url: str | None = None
    status: Literal["open", "full", "in_progress", "completed", "cancelled"] = "open"
    sport: Sport = "pickleball"

    @property
    def open_slots(self) -> int:
        return max(self.capacity - len(self.confirmed_player_ids), 0)


class TournamentRules(BaseModel):
    score_label: str = "Points"
    point_target: int = Field(ge=1, le=999, default=11)
    win_by: int = Field(ge=1, le=99, default=2)
    best_of: int = Field(ge=1, le=7, default=1)


class Tournament(BaseModel):
    id: str
    name: str = Field(min_length=2, max_length=80)
    sport: Sport = "pickleball"
    organizer_id: str
    area: str
    venue_name: str | None = None
    tournament_date: date_type
    format: Literal["round_robin"] = "round_robin"
    capacity: int = Field(ge=2, le=16)
    status: Literal["registration", "in_progress", "completed", "cancelled"] = "registration"
    registration_ids: list[str] = Field(default_factory=list)
    created_at: datetime
    rules: TournamentRules = Field(default_factory=TournamentRules)


class TournamentListItem(Tournament):
    my_registration_status: Literal["pending", "registered", "waitlisted", "declined", "withdrawn"] | None = None


class TournamentRegistration(BaseModel):
    id: str
    tournament_id: str
    player_id: str
    display_name: str
    status: Literal["pending", "registered", "waitlisted", "declined", "withdrawn"] = "pending"
    cmr_rating: float | None = Field(default=None, ge=0, le=100)
    created_at: datetime


class TournamentMatch(BaseModel):
    id: str
    tournament_id: str
    round_number: int = Field(ge=1)
    match_number: int = Field(ge=1)
    player_a_id: str
    player_b_id: str
    status: Literal["scheduled", "pending_confirmation", "completed"] = "scheduled"
    score_a: int | None = Field(default=None, ge=0, le=999)
    score_b: int | None = Field(default=None, ge=0, le=999)
    winner_id: str | None = None
    score_entered_by: str | None = None
    confirmed_by: str | None = None


class TournamentStanding(BaseModel):
    rank: int
    player_id: str
    display_name: str
    cmr_rating: float | None = Field(default=None, ge=0, le=100)
    played: int = 0
    wins: int = 0
    losses: int = 0
    draws: int = 0
    points_for: int = 0
    points_against: int = 0
    table_points: int = 0


class TournamentDetailsResponse(BaseModel):
    tournament: Tournament
    registrations: list[TournamentRegistration] = Field(default_factory=list)
    matches: list[TournamentMatch] = Field(default_factory=list)
    standings: list[TournamentStanding] = Field(default_factory=list)


class TournamentListResponse(BaseModel):
    tournaments: list[TournamentListItem]


class CreateTournamentRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    sport: Sport = "pickleball"
    area: str = Field(min_length=2, max_length=80)
    venue_name: str | None = Field(default=None, max_length=120)
    tournament_date: date_type
    capacity: int = Field(ge=2, le=16, default=8)
    format: Literal["round_robin"] = "round_robin"


class TournamentScoreRequest(BaseModel):
    score_a: int = Field(ge=0, le=999)
    score_b: int = Field(ge=0, le=999)
    confirm: bool = False


class TournamentRegistrationDecisionRequest(BaseModel):
    status: Literal["approved", "declined"]


class TournamentFixtureUpdateRequest(BaseModel):
    round_number: int = Field(ge=1)
    match_number: int = Field(ge=1)
    player_a_id: str = Field(min_length=1, max_length=120)
    player_b_id: str = Field(min_length=1, max_length=120)


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
    capacity: int = Field(default=8, ge=2, le=16)
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
    tournaments: list[TournamentListItem] = Field(default_factory=list)
    action: Literal["join_existing", "create_group"] = "join_existing"
    message: str = ""
    group_proposal: GroupProposal | None = None
    scope: Literal["court_discovery", "out_of_scope"] = "court_discovery"
    retrieval: "RetrievalTrace | None" = None


class SearchDocument(BaseModel):
    """A sanitized, searchable projection of an operational record."""

    id: str
    source_type: Literal["session", "tournament", "player", "venue", "faq"]
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
    kind: Literal["game_match", "join_request", "request_update", "tournament_request", "tournament_update", "follow"] = "game_match"
    title: str
    message: str
    session_id: str
    request_id: str | None = None
    tournament_id: str | None = None
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
    like_count: int = Field(default=0, ge=0)
    comment_count: int = Field(default=0, ge=0)
    share_count: int = Field(default=0, ge=0)
    liked_by_me: bool = False
    created_at: datetime


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


class CreatedGroupResponse(BaseModel):
    session: Session
    message: str


class FeedbackRequest(BaseModel):
    player_id: str | None = None
    rating: int | None = Field(default=None, ge=1, le=5)
    fun: int = Field(ge=1, le=5)
    fairness: int = Field(ge=1, le=5)
    would_return: bool
    ratings: list["PlayerRating"] = Field(default_factory=list)
    teams: list["MatchTeam"] = Field(default_factory=list, max_length=4)


class PlayerRating(BaseModel):
    player_id: str
    skill_level: SkillLevel | None = None
    # Kept for old feedback documents and API clients. New feedback uses skill_level.
    rating: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = Field(default=None, max_length=300)


class MatchTeam(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    player_ids: list[str] = Field(min_length=1, max_length=8)
    score: int | None = Field(default=None, ge=0, le=999)


class Feedback(BaseModel):
    session_id: str
    player_id: str
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
