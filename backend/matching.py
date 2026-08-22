from datetime import date, datetime

from .models import Player, PlayerRecommendation, RecommendationReason, SearchIntent, Session, SessionRecommendation


def _area_fit(query_area: str, player_area: str) -> float:
    return 1.0 if query_area.lower() in player_area.lower() or player_area.lower() in query_area.lower() else 0.45


def _skill_fit(rating: float | None, minimum: float, maximum: float) -> float:
    if rating is None:
        return 0.35
    if minimum <= rating <= maximum:
        return 1.0
    distance = minimum - rating if rating < minimum else rating - maximum
    return max(0.0, 1.0 - distance / 1.5)


def _time_fit(start, end, query: SearchIntent) -> float:
    if query.start_time is None:
        return 0.7
    overlaps = start <= query.start_time <= end or (query.end_time and start <= query.end_time <= end)
    return 1.0 if overlaps else 0.0


def search_sessions(sessions: list[Session], query: SearchIntent) -> list[SessionRecommendation]:
    results: list[SessionRecommendation] = []
    for session in sessions:
        if session.status not in {"open", "full"} or session.open_slots < query.open_slots_required:
            continue
        if query.date and session.session_date != query.date:
            continue
        time_fit = _time_fit(session.start_time, session.end_time, query)
        if time_fit == 0:
            continue
        area_fit = _area_fit(query.area, session.area)
        if area_fit < 0.45:
            continue
        skill_min = query.skill_min if query.skill_min is not None else session.skill_min
        skill_max = query.skill_max if query.skill_max is not None else session.skill_max
        skill_fit = 1.0 if session.skill_min <= skill_max and session.skill_max >= skill_min else 0.25
        style_fit = 1.0 if query.style in {"any", session.style} else 0.45
        score = .4 * skill_fit + .25 * time_fit + .2 * area_fit + .15 * style_fit
        reasons = RecommendationReason(skill_fit=skill_fit, availability_fit=time_fit, area_fit=area_fit, style_fit=style_fit, reliability=0.0, familiarity=0.0, explanation=f"{session.group_name} matches the requested area, time, and skill band with {session.open_slots} open slot(s).")
        results.append(SessionRecommendation(session=session, score=round(score, 3), reasons=reasons))
    return sorted(results, key=lambda item: item.score, reverse=True)


def suggest_replacements(session: Session, players: list[Player]) -> list[PlayerRecommendation]:
    candidates = []
    for player in players:
        if player.id in session.confirmed_player_ids or not player.opted_into_replacement_pool:
            continue
        skill_fit = _skill_fit(player.dupr_rating, session.skill_min, session.skill_max)
        area_fit = _area_fit(session.area, player.area)
        style_fit = 1.0 if player.style == session.style else 0.55
        score = .5 * skill_fit + .2 * area_fit + .2 * player.reliability + .1 * style_fit
        rating_label = f"DUPR {player.dupr_rating:.1f}" if player.dupr_rating else "unrated / provisional"
        candidates.append(PlayerRecommendation(player=player, score=round(score, 3), explanation=f"{rating_label}; {player.area}; {int(player.reliability * 100)}% attendance reliability; {player.style} style."))
    return sorted(candidates, key=lambda item: item.score, reverse=True)
