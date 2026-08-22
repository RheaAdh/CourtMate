from datetime import date as date_type, datetime, time
from typing import Literal

from pydantic import BaseModel, Field


class SearchIntent(BaseModel):
    sport: Literal["pickleball"] = "pickleball"
    area: str = "Whitefield"
    date: date_type | None = None
    start_time: time | None = None
    end_time: time | None = None
    skill_min: float | None = Field(default=None, ge=1, le=8)
    skill_max: float | None = Field(default=None, ge=1, le=8)
    style: Literal["casual", "social", "competitive", "any"] = "any"
    open_slots_required: int = Field(default=1, ge=1, le=8)


class Player(BaseModel):
    id: str
    display_name: str
    area: str
    dupr_rating: float | None = Field(default=None, ge=1, le=8)
    rating_source: Literal["dupr", "organizer_confirmed", "synthetic", "unrated"] = "unrated"
    rating_confidence: float = Field(default=0.0, ge=0, le=1)
    availability: list[str] = Field(default_factory=list)
    style: Literal["casual", "social", "competitive"] = "casual"
    reliability: float = Field(default=0.75, ge=0, le=1)
    friends: list[str] = Field(default_factory=list)
    opted_into_replacement_pool: bool = True


class ProfileUpdateRequest(BaseModel):
    area: str | None = None
    dupr_rating: float | None = Field(default=None, ge=1, le=8)
    style: Literal["casual", "social", "competitive"] | None = None


class Session(BaseModel):
    id: str
    group_name: str
    organizer_id: str
    area: str
    session_date: date_type
    start_time: time
    end_time: time
    skill_min: float = Field(ge=1, le=8)
    skill_max: float = Field(ge=1, le=8)
    style: Literal["casual", "social", "competitive"]
    capacity: int = Field(ge=2, le=16)
    confirmed_player_ids: list[str] = Field(default_factory=list)
    external_booking_url: str | None = None
    status: Literal["open", "full", "in_progress", "completed", "cancelled"] = "open"

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
    explanation: str


class SessionRecommendation(BaseModel):
    session: Session
    score: float
    reasons: RecommendationReason


class GroupProposal(BaseModel):
    group_name: str
    area: str
    session_date: date_type | None = None
    start_time: time | None = None
    end_time: time | None = None
    skill_min: float
    skill_max: float
    style: Literal["casual", "social", "competitive"]
    capacity: int = Field(default=8, ge=2, le=16)
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


class JoinRequestRequest(BaseModel):
    pass


class JoinRequest(BaseModel):
    id: str
    session_id: str
    player_id: str
    player_display_name: str | None = None
    status: Literal["pending", "approved", "declined"] = "pending"
    created_at: datetime


class JoinRequestsResponse(BaseModel):
    session: Session
    requests: list[JoinRequest]


class CreateGroupRequest(BaseModel):
    query: str


class CreatedGroupResponse(BaseModel):
    session: Session
    message: str


class FeedbackRequest(BaseModel):
    player_id: str
    fun: int = Field(ge=1, le=5)
    fairness: int = Field(ge=1, le=5)
    would_return: bool


class Feedback(BaseModel):
    session_id: str
    player_id: str
    fun: int
    fairness: int
    would_return: bool
    created_at: datetime
