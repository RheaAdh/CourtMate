"""Add an explicitly synthetic CMR trajectory to one existing demo profile.

This utility preserves a player's identity and preferences. It is intended for
hackathon demos only, where a profile needs representative chart data before
enough competitive match results have accumulated.
"""

from __future__ import annotations

import argparse
import os
from datetime import date, timedelta

from .models import CMRHistoryPoint, clamp_cmr, rating_for_sport
from .repository import FirestoreRepository


def make_trajectory(player_id: str, sport: str, target: float, games: int) -> list[CMRHistoryPoint]:
    """Create a gradual, plausible 12-week trajectory ending at the current rating."""
    start = clamp_cmr(target - 0.58)
    pattern = (-0.04, 0.13, 0.07, -0.03, 0.11, 0.08, 0.09, 0.17)
    ratings: list[float] = []
    rating = start
    for index in range(games):
        if index == games - 1:
            rating = target
        else:
            remaining_steps = games - index
            direct_step = (target - rating) / remaining_steps
            rating = clamp_cmr(rating + direct_step + pattern[index % len(pattern)])
        ratings.append(rating)

    previous = start
    return [
        CMRHistoryPoint(
            session_id=f"synthetic-trajectory-{player_id}-{sport}-{index + 1}",
            session_date=date.today() - timedelta(days=(games - index) * 10),
            group_name=f"{sport.replace('_', ' ').title()} demo rally {index + 1}",
            game_rating=clamp_cmr(rating + (0.12 if index % 3 else -0.06)),
            rating=rating,
            delta=round(rating - (ratings[index - 1] if index else previous), 2),
            confidence=round(min(100, 18 + (index + 1) * 9.5), 1),
        )
        for index, rating in enumerate(ratings)
    ]


def seed(player_id: str, sport: str, games: int, project: str) -> None:
    repository = FirestoreRepository(project=project)
    player = repository.get_player(player_id)
    if not player:
        raise SystemExit(f"Player {player_id!r} was not found in project {project!r}.")

    target = rating_for_sport(player, sport) or 4.5
    history = make_trajectory(player.id, sport, target, games)
    starting_rating = history[0].rating or target

    ratings = dict(player.cmr_ratings)
    ratings[sport] = target
    starting_ratings = dict(player.cmr_starting_ratings)
    starting_ratings[sport] = starting_rating
    game_counts = dict(player.cmr_game_counts)
    game_counts[sport] = games
    confidence = dict(player.cmr_confidence)
    confidence[sport] = history[-1].confidence or 0
    cmr_history = dict(player.cmr_history)
    cmr_history[sport] = history
    self_assessed = dict(player.self_assessed_levels)
    self_assessed.setdefault(sport, int(round(starting_rating)))
    sources = dict(player.rating_sources)
    sources[sport] = "synthetic"

    repository.save_player(player.model_copy(update={
        "primary_sport": player.primary_sport or sport,
        "self_assessed_levels": self_assessed,
        "rating_source": "synthetic",
        "rating_confidence": max(player.rating_confidence, (history[-1].confidence or 0) / 100),
        "rating_sources": sources,
        "cmr_ratings": ratings,
        "cmr_starting_ratings": starting_ratings,
        "cmr_game_counts": game_counts,
        "cmr_confidence": confidence,
        "cmr_history": cmr_history,
        "cmr_scale": 10,
    }))
    print(f"Seeded {games} synthetic {sport} CMR points for {player.display_name} ({player.id}).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed synthetic CMR chart data for one existing demo profile.")
    parser.add_argument("--player-id", required=True, help="Existing Firestore player ID to update.")
    parser.add_argument("--sport", default="badminton", choices=["pickleball", "badminton", "tennis", "padel", "squash", "table_tennis"])
    parser.add_argument("--games", type=int, default=8, choices=range(3, 13), metavar="3..12")
    parser.add_argument("--project", default=os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal"))
    args = parser.parse_args()
    seed(args.player_id, args.sport, args.games, args.project)


if __name__ == "__main__":
    main()
