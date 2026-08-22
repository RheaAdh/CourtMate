from datetime import date as date_type, datetime, time
from typing import Literal

from pydantic import BaseModel, Field

Sport = Literal["pickleball", "badminton", "tennis", "padel", "squash", "table_tennis", "basketball", "volleyball"]
RatingSource = Literal["dupr", "organizer_confirmed", "synthetic", "self_reported", "unrated"]
SkillLevel = Literal["beginner", "intermediate", "advanced"]


class CMRHistoryPoint(BaseModel):
    session_id: str
    session_date: date_type
    group_name: str
    game_rating: float | None = Field(default=None, ge=1, le=8)
    rating: float | None = Field(default=None, ge=1, le=8)
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
    area: str
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
    friends: list[str] = Field(default_factory=list)
    opted_into_replacement_pool: bool = True


def rating_for_sport(player: Player, sport: Sport) -> float | None:
    """Return a computed or externally verified rating, never a profile skill label."""
    if sport in player.cmr_ratings:
        return player.cmr_ratings[sport]
    if sport in player.sport_ratings:
        return player.sport_ratings[sport]
    if sport == "pickleball" and player.dupr_rating is not None:
        return player.dupr_rating
    return None


def baseline_rating_for_sport(player: Player, sport: Sport) -> float | None:
    """Return only an external rating used to seed the first CMR calculation."""
    if sport in player.sport_ratings:
        return player.sport_ratings[sport]
    if sport == "pickleball" and player.dupr_rating is not None:
        return player.dupr_rating
    return None


class PublicPlayerProfile(BaseModel):
    id: str
    display_name: str
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


class ProfileUpdateRequest(BaseModel):
    area: str | None = None
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
    action: Literal["join_existing", "create_group"] = "join_existing"
    message: str = ""
    group_proposal: GroupProposal | None = None


class ReplacementResponse(BaseModel):
    session: Session
    candidates: list[PlayerRecommendation]


class ParseRequest(BaseModel):
    query: str
    player_id: str | None = None
    sport: Sport | None = None


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


class JoinRequestsResponse(BaseModel):
    session: Session
    requests: list[JoinRequest]


class JoinRequestView(BaseModel):
    request: JoinRequest
    session: Session


class MyRequestsResponse(BaseModel):
    requests: list[JoinRequestView]


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


class GroupViewResponse(BaseModel):
    session: Session
    members: list[PublicPlayerProfile]


class ChatPostRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)


class ChatPost(BaseModel):
    id: str
    session_id: str
    player_id: str
    player_display_name: str
    message: str
    created_at: datetime


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


class PlayerRating(BaseModel):
    player_id: str
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=300)


class Feedback(BaseModel):
    session_id: str
    player_id: str
    fun: int
    fairness: int
    would_return: bool
    ratings: list[PlayerRating] = Field(default_factory=list)
    created_at: datetime


class LeaderboardEntry(BaseModel):
    rank: int
    player: PublicPlayerProfile
    score: float
    ratings_count: int


class LeaderboardResponse(BaseModel):
    scope: str
    entries: list[LeaderboardEntry]
