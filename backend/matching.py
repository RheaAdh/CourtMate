from math import asin, cos, radians, sin, sqrt

from .models import Player, PlayerRecommendation, RecommendationReason, SearchIntent, Session, SessionRecommendation, rating_for_sport


def _area_fit(query_area: str, player_area: str) -> float:
    if not query_area:
        return 0.7
    return 1.0 if query_area.lower() in player_area.lower() or player_area.lower() in query_area.lower() else 0.45


def distance_km(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    """Return the great-circle distance between two coordinates."""
    earth_radius_km = 6371.0
    delta_latitude = radians(latitude_b - latitude_a)
    delta_longitude = radians(longitude_b - longitude_a)
    haversine = sin(delta_latitude / 2) ** 2 + cos(radians(latitude_a)) * cos(radians(latitude_b)) * sin(delta_longitude / 2) ** 2
    return earth_radius_km * 2 * asin(sqrt(haversine))


def _location_match(session: Session, query: SearchIntent, player: Player | None) -> tuple[bool, float, float | None]:
    origin = (query.latitude, query.longitude)
    if origin[0] is None or origin[1] is None:
        origin = (player.latitude, player.longitude) if player else (None, None)
    if origin[0] is not None and origin[1] is not None and session.latitude is not None and session.longitude is not None:
        radius_km = player.travel_radius_km if player else 10.0
        distance = distance_km(origin[0], origin[1], session.latitude, session.longitude)
        return distance <= radius_km, max(0.0, 1.0 - distance / radius_km), distance
    if query.area:
        area_fit = _area_fit(query.area, session.area)
        return area_fit >= 1.0, area_fit, None
    return True, 0.7, None


def _skill_fit(rating: float | None, minimum: float, maximum: float) -> float:
    if rating is None:
        return 0.35
    if minimum <= rating <= maximum:
        return 1.0
    distance = minimum - rating if rating < minimum else rating - maximum
    return max(0.0, 1.0 - distance / 1.5)


def _in_band_skill_fit(rating: float, minimum: float, maximum: float) -> float:
    """Prefer players near a group's CMR midpoint while keeping the band as a hard gate."""
    midpoint = (minimum + maximum) / 2
    half_width = max((maximum - minimum) / 2, 0.25)
    midpoint_distance = min(abs(rating - midpoint) / half_width, 1.0)
    return round(1.0 - midpoint_distance * 0.25, 3)


def _time_fit(start, end, query: SearchIntent) -> float:
    if query.start_time is None:
        return 0.7
    overlaps = start <= query.start_time <= end or (query.end_time and start <= query.end_time <= end)
    return 1.0 if overlaps else 0.0


def _profile_availability_fit(session: Session, player: Player | None) -> float:
    """Use saved availability as a ranking signal when the search has no time."""
    if not player or not player.availability:
        return 0.7
    day_type = "weekend" if session.session_date.weekday() >= 5 else "weekday"
    if session.start_time.hour < 12:
        day_part = "mornings"
    elif session.start_time.hour >= 16:
        day_part = "evenings"
    else:
        return 0.45
    return 1.0 if f"{day_type} {day_part}" in player.availability else 0.25


_AGE_RANGE_BOUNDS = {
    "18_24": (18, 24),
    "25_34": (25, 34),
    "35_44": (35, 44),
    "45_plus": (45, 100),
}


def preference_fit(player: Player | None, members: list[Player]) -> float:
    """Score a group's fit with the player's optional age and gender preferences."""
    if not player:
        return 0.7
    signals: list[float] = []
    if player.preferred_age_range != "any":
        minimum, maximum = _AGE_RANGE_BOUNDS[player.preferred_age_range]
        ages = [member.age for member in members if member.age is not None]
        if ages:
            signals.append(sum(minimum <= age <= maximum for age in ages) / len(ages))
    if player.preferred_genders:
        genders = [member.gender for member in members if member.gender is not None]
        if genders:
            signals.append(sum(gender in player.preferred_genders for gender in genders) / len(genders))
    return round(sum(signals) / len(signals), 3) if signals else 0.7


def search_sessions(sessions: list[Session], query: SearchIntent, players: list[Player] | None = None, player: Player | None = None, exact: bool = False) -> list[SessionRecommendation]:
    results: list[SessionRecommendation] = []
    for session in sessions:
        if session.sport != query.sport:
            continue
        if session.status not in {"open", "full"} or session.open_slots < query.open_slots_required:
            continue
        if query.date and session.session_date != query.date:
            continue
        location_matches, area_fit, distance = _location_match(session, query, player)
        if not location_matches:
            continue
        time_fit = _time_fit(session.start_time, session.end_time, query) if query.start_time is not None else _profile_availability_fit(session, player)
        if time_fit == 0:
            continue
        skill_min = query.skill_min if query.skill_min is not None else session.skill_min
        skill_max = query.skill_max if query.skill_max is not None else session.skill_max
        skill_fit = 1.0 if session.skill_min <= skill_max and session.skill_max >= skill_min else 0.25
        if skill_fit < 1.0:
            continue
        if exact and query.style != "any" and session.style != query.style:
            continue
        # An explicit level in the search describes this game; otherwise only a
        # computed or externally verified rating should constrain the player.
        player_rating = rating_for_sport(player, query.sport) if player and query.skill_min is None and query.skill_max is None else None
        if player and player_rating is not None and not session.skill_min <= player_rating <= session.skill_max:
            continue
        if player_rating is not None:
            skill_fit = _in_band_skill_fit(player_rating, session.skill_min, session.skill_max)
        style_fit = 1.0 if query.style == session.style else 0.45
        if query.style == "any" and player:
            style_fit = 1.0 if player.style == session.style else 0.55
        member_reliability = 0.0
        familiarity = 0.0
        if players:
            members = [candidate for candidate in players if candidate.id in session.confirmed_player_ids]
            member_reliability = round(sum(member.reliability for member in members) / len(members), 3) if members else 0.0
            if player:
                familiarity = 1.0 if any(player.id in member.friends for member in members) else 0.0
        demographic_fit = preference_fit(player, members if players else [])
        score = .30 * skill_fit + .22 * time_fit + .18 * area_fit + .1 * style_fit + .1 * member_reliability + .1 * demographic_fit
        rating_label = "DUPR" if query.sport == "pickleball" else "skill rating"
        location_message = f"about {distance:.1f} km away" if distance is not None else f"in {session.area}"
        reasons = RecommendationReason(skill_fit=skill_fit, availability_fit=time_fit, area_fit=area_fit, style_fit=style_fit, reliability=member_reliability, familiarity=familiarity, distance_km=round(distance, 1) if distance is not None else None, explanation=f"{session.group_name} is {location_message} and matches your requested time and {rating_label} band with {session.open_slots} open slot(s).")
        results.append(SessionRecommendation(session=session, score=round(score, 3), reasons=reasons))
    return sorted(results, key=lambda item: item.score, reverse=True)


def suggest_replacements(session: Session, players: list[Player]) -> list[PlayerRecommendation]:
    candidates = []
    for player in players:
        if player.id in session.confirmed_player_ids or not player.opted_into_replacement_pool:
            continue
        player_rating = rating_for_sport(player, session.sport)
        skill_fit = _skill_fit(player_rating, session.skill_min, session.skill_max)
        distance = None
        if session.latitude is not None and session.longitude is not None and player.latitude is not None and player.longitude is not None:
            distance = distance_km(player.latitude, player.longitude, session.latitude, session.longitude)
            area_fit = max(0.0, 1.0 - distance / player.travel_radius_km)
        else:
            area_fit = _area_fit(session.area, player.area)
        style_fit = 1.0 if player.style == session.style else 0.55
        members = [candidate for candidate in players if candidate.id in session.confirmed_player_ids]
        demographic_fit = preference_fit(player, members)
        score = .45 * skill_fit + .18 * area_fit + .17 * player.reliability + .1 * style_fit + .1 * demographic_fit
        rating_label = f"{session.sport.replace('_', ' ').title()} {player_rating:.1f}" if player_rating else "unrated / provisional"
        candidates.append(PlayerRecommendation(player=player, score=round(score, 3), explanation=f"{rating_label}; {player.area}; {int(player.reliability * 100)}% attendance reliability; {player.style} style."))
    return sorted(candidates, key=lambda item: item.score, reverse=True)
