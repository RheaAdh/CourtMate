from .models import Sport, TournamentMatch, TournamentRegistration, TournamentRules, TournamentStanding


_SPORT_RULES: dict[Sport, TournamentRules] = {
    "pickleball": TournamentRules(score_label="Points", point_target=11, win_by=2, best_of=1),
    "badminton": TournamentRules(score_label="Points", point_target=21, win_by=2, best_of=3),
    "table_tennis": TournamentRules(score_label="Points", point_target=11, win_by=2, best_of=5),
    "squash": TournamentRules(score_label="Points", point_target=11, win_by=2, best_of=5),
    "tennis": TournamentRules(score_label="Sets", point_target=2, win_by=1, best_of=3),
    "padel": TournamentRules(score_label="Sets", point_target=2, win_by=1, best_of=3),
}


def rules_for_sport(sport: Sport) -> TournamentRules:
    try:
        return _SPORT_RULES[sport]
    except KeyError as error:
        raise ValueError("Tournaments support racket sports only") from error


def generate_round_robin_matches(tournament_id: str, registrations: list[TournamentRegistration]) -> list[TournamentMatch]:
    players = [registration for registration in registrations if registration.status == "registered"]
    if len(players) < 2:
        raise ValueError("At least two registered players are needed to generate fixtures")
    slots: list[TournamentRegistration | None] = players[:]
    if len(slots) % 2:
        slots.append(None)
    fixed = slots[0]
    rotating = slots[1:]
    matches: list[TournamentMatch] = []
    for round_number in range(1, len(slots)):
        round_match_number = 1
        pairs = [(fixed, rotating[-1])]
        pairs.extend((rotating[index], rotating[-index - 2]) for index in range(len(rotating) // 2))
        for player_a, player_b in pairs:
            if player_a is None or player_b is None:
                continue
            matches.append(TournamentMatch(
                id=f"{tournament_id}-r{round_number}-m{round_match_number}",
                tournament_id=tournament_id,
                round_number=round_number,
                match_number=round_match_number,
                player_a_id=player_a.player_id,
                player_b_id=player_b.player_id,
            ))
            round_match_number += 1
        rotating = [rotating[-1], *rotating[:-1]]
    return matches


def _bracket_seed_positions(size: int) -> list[int]:
    positions = [1, 2]
    while len(positions) < size:
        next_size = len(positions) * 2
        positions = [position for seed in positions for position in (seed, next_size + 1 - seed)]
    return positions


def generate_knockout_matches(tournament_id: str, registrations: list[TournamentRegistration]) -> list[TournamentMatch]:
    """Build a seeded single-elimination bracket with future slots left open."""
    players = [registration for registration in registrations if registration.status == "registered"]
    if len(players) < 2:
        raise ValueError("At least two registered players are needed to generate fixtures")
    bracket_size = 1
    while bracket_size < len(players):
        bracket_size *= 2
    seed_slots: list[TournamentRegistration | None] = [*players, *([None] * (bracket_size - len(players)))]
    seed_positions = _bracket_seed_positions(bracket_size)
    matches: list[TournamentMatch] = []
    round_match_count = bracket_size // 2
    for match_number in range(round_match_count):
        player_a = seed_slots[seed_positions[match_number * 2] - 1]
        player_b = seed_slots[seed_positions[match_number * 2 + 1] - 1]
        if player_a is None and player_b is None:
            continue
        if player_a is None or player_b is None:
            winner_id = (player_a or player_b).player_id
            status = "bye"
        else:
            winner_id = None
            status = "scheduled"
        matches.append(TournamentMatch(
            id=f"{tournament_id}-r1-m{match_number + 1}",
            tournament_id=tournament_id,
            round_number=1,
            match_number=match_number + 1,
            player_a_id=player_a.player_id if player_a else None,
            player_b_id=player_b.player_id if player_b else None,
            status=status,
            winner_id=winner_id,
        ))
    round_number = 2
    previous_match_count = round_match_count
    while previous_match_count > 1:
        current_match_count = previous_match_count // 2
        for match_number in range(current_match_count):
            matches.append(TournamentMatch(
                id=f"{tournament_id}-r{round_number}-m{match_number + 1}",
                tournament_id=tournament_id,
                round_number=round_number,
                match_number=match_number + 1,
            ))
        previous_match_count = current_match_count
        round_number += 1
    return matches


def validate_score(score_a: int, score_b: int, rules: TournamentRules) -> None:
    if score_a == score_b:
        raise ValueError("A completed match cannot be a tie")
    winner_score = max(score_a, score_b)
    margin = abs(score_a - score_b)
    if winner_score < rules.point_target or margin < rules.win_by:
        raise ValueError(f"Winner must reach {rules.point_target} with a {rules.win_by}-point advantage")


def validate_set_scores(set_scores_a: list[int], set_scores_b: list[int], rules: TournamentRules) -> tuple[int, int]:
    """Validate an optional best-of result and return sets won by each side."""
    if not set_scores_a and not set_scores_b:
        return (0, 0)
    if not set_scores_a or len(set_scores_a) != len(set_scores_b):
        raise ValueError("Enter both sides of every set score")
    if len(set_scores_a) > rules.best_of:
        raise ValueError(f"A best-of-{rules.best_of} match cannot have more than {rules.best_of} sets")
    if any(score < 0 or score > 999 for score in [*set_scores_a, *set_scores_b]):
        raise ValueError("Set scores must be between 0 and 999")
    for score_a, score_b in zip(set_scores_a, set_scores_b):
        if score_a == score_b:
            raise ValueError("A set score cannot be tied")
        if rules.score_label != "Sets":
            try:
                validate_score(score_a, score_b, rules.model_copy(update={"best_of": 1}))
            except ValueError as error:
                raise ValueError(f"Invalid set score {score_a}-{score_b}: {error}") from error
    sets_won_a = sum(score_a > score_b for score_a, score_b in zip(set_scores_a, set_scores_b))
    sets_won_b = len(set_scores_a) - sets_won_a
    required = rules.best_of // 2 + 1
    if max(sets_won_a, sets_won_b) != required:
        raise ValueError(f"Enter enough sets to complete the best-of-{rules.best_of} match")
    return (sets_won_a, sets_won_b)


def calculate_standings(
    registrations: list[TournamentRegistration],
    matches: list[TournamentMatch],
) -> list[TournamentStanding]:
    entries = {
        registration.player_id: TournamentStanding(
            rank=0,
            player_id=registration.player_id,
            display_name=registration.display_name,
            cmr_rating=registration.cmr_rating,
        )
        for registration in registrations
        if registration.status == "registered"
    }
    for match in matches:
        if match.status != "completed" or not match.player_a_id or not match.player_b_id:
            continue
        player_a = entries.get(match.player_a_id)
        player_b = entries.get(match.player_b_id)
        if not player_a or not player_b:
            continue
        player_a.played += 1
        player_b.played += 1
        if match.score_a is not None and match.score_b is not None:
            player_a.points_for += match.score_a
            player_a.points_against += match.score_b
            player_b.points_for += match.score_b
            player_b.points_against += match.score_a
        if match.winner_id == match.player_a_id:
            player_a.wins += 1
            player_b.losses += 1
            player_a.table_points += 3
        elif match.winner_id == match.player_b_id:
            player_b.wins += 1
            player_a.losses += 1
            player_b.table_points += 3
        elif match.score_a is not None and match.score_b is not None:
            player_a.draws += 1
            player_b.draws += 1
            player_a.table_points += 1
            player_b.table_points += 1
    ordered = sorted(entries.values(), key=lambda entry: (
        -entry.table_points,
        -entry.wins,
        -(entry.points_for - entry.points_against),
        -entry.points_for,
        -(entry.cmr_rating or 0),
        entry.display_name.lower(),
    ))
    for rank, entry in enumerate(ordered, start=1):
        entry.rank = rank
    return ordered
