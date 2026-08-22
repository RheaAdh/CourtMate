from .models import Player, PlayerRecommendation, RecommendationReason, SearchIntent, Session, SessionRecommendation, rating_for_sport


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


def search_sessions(sessions: list[Session], query: SearchIntent, players: list[Player] | None = None, player: Player | None = None) -> list[SessionRecommendation]:
    results: list[SessionRecommendation] = []
    for session in sessions:
        if session.sport != query.sport:
            continue
        if session.status not in {"open", "full"} or session.open_slots < query.open_slots_required:
            continue
        if query.date and session.session_date != query.date:
            continue
        if query.area and session.area.lower() != query.area.lower():
            continue
        time_fit = _time_fit(session.start_time, session.end_time, query)
        if time_fit == 0:
            continue
        area_fit = _area_fit(query.area, session.area)
        skill_min = query.skill_min if query.skill_min is not None else session.skill_min
        skill_max = query.skill_max if query.skill_max is not None else session.skill_max
        skill_fit = 1.0 if session.skill_min <= skill_max and session.skill_max >= skill_min else 0.25
        if skill_fit < 1.0:
            continue
        player_rating = rating_for_sport(player, query.sport) if player else None
        if player and player_rating is not None and not session.skill_min <= player_rating <= session.skill_max:
            continue
        style_fit = 1.0 if query.style in {"any", session.style} else 0.45
        member_reliability = 0.0
        familiarity = 0.0
        if players:
            members = [candidate for candidate in players if candidate.id in session.confirmed_player_ids]
            member_reliability = round(sum(member.reliability for member in members) / len(members), 3) if members else 0.0
            if player:
                familiarity = 1.0 if any(player.id in member.friends for member in members) else 0.0
        score = .35 * skill_fit + .25 * time_fit + .2 * area_fit + .1 * style_fit + .1 * member_reliability
        rating_label = "DUPR" if query.sport == "pickleball" else "skill rating"
        reasons = RecommendationReason(skill_fit=skill_fit, availability_fit=time_fit, area_fit=area_fit, style_fit=style_fit, reliability=member_reliability, familiarity=familiarity, explanation=f"{session.group_name} matches your requested area, time, and {rating_label} band with {session.open_slots} open slot(s).")
        results.append(SessionRecommendation(session=session, score=round(score, 3), reasons=reasons))
    return sorted(results, key=lambda item: item.score, reverse=True)


def suggest_replacements(session: Session, players: list[Player]) -> list[PlayerRecommendation]:
    candidates = []
    for player in players:
        if player.id in session.confirmed_player_ids or not player.opted_into_replacement_pool:
            continue
        player_rating = rating_for_sport(player, session.sport)
        skill_fit = _skill_fit(player_rating, session.skill_min, session.skill_max)
        area_fit = _area_fit(session.area, player.area)
        style_fit = 1.0 if player.style == session.style else 0.55
        score = .5 * skill_fit + .2 * area_fit + .2 * player.reliability + .1 * style_fit
        rating_label = f"{session.sport.replace('_', ' ').title()} {player_rating:.1f}" if player_rating else "unrated / provisional"
        candidates.append(PlayerRecommendation(player=player, score=round(score, 3), explanation=f"{rating_label}; {player.area}; {int(player.reliability * 100)}% attendance reliability; {player.style} style."))
    return sorted(candidates, key=lambda item: item.score, reverse=True)
