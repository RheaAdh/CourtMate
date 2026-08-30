from datetime import date, time

from backend.models import Player, Session
from backend.repository import InMemoryRepository


def load_repository_fixture(repository: InMemoryRepository) -> None:
    """Load isolated records for unit tests without shipping sample data in the app."""
    coordinates = {
        "Whitefield": (12.9698, 77.7499),
        "Brookefield": (12.9665, 77.7168),
        "Kadugodi": (13.0068, 77.7585),
        "Varthur": (12.9408, 77.7460),
    }
    player_specs = [
        ("p1", "Ananya", "Whitefield", 3.2, "casual", .94),
        ("p2", "Kavya", "Whitefield", 3.4, "casual", .88),
        ("p3", "Rohit", "Whitefield", 3.1, "social", .91),
        ("p4", "Meera", "Brookefield", 3.5, "competitive", .96),
        ("p5", "Vikram", "Kadugodi", None, "casual", .80),
        ("p6", "Sana", "Whitefield", 3.3, "casual", .86),
        ("p7", "Arjun", "Whitefield", 2.4, "social", .82),
        ("p8", "Nisha", "Brookefield", 2.6, "casual", .89),
        ("p9", "Dev", "Whitefield", 3.8, "competitive", .95),
        ("p10", "Ishaan", "Kadugodi", 4.1, "competitive", .90),
        ("p11", "Pooja", "Whitefield", 3.0, "social", .84),
        ("p12", "Kabir", "Varthur", 2.1, "casual", .78),
        ("p13", "Tara", "Whitefield", 3.6, "competitive", .93),
        ("p14", "Neil", "Brookefield", 3.4, "social", .87),
    ]
    players = {}
    for player_id, name, area, rating, style, reliability in player_specs:
        latitude, longitude = coordinates[area]
        player = Player(
            id=player_id,
            display_name=name,
            area=area,
            latitude=latitude,
            longitude=longitude,
            dupr_rating=rating,
            rating_source="dupr" if rating is not None else "unrated",
            rating_confidence=.9 if rating is not None else .25,
            style=style,
            reliability=reliability,
        )
        if rating is not None:
            player.sport_ratings = {
                "pickleball": rating,
                "badminton": round(min(8, rating + .4), 1),
                "tennis": round(max(1, rating - .2), 1),
                "padel": round(rating, 1),
                "squash": round(min(8, rating + .1), 1),
            }
            player.rating_sources = {sport: "dupr" for sport in player.sport_ratings}
        players[player_id] = player

    sessions = [
        Session(
            id="s1", sport="pickleball", group_name="Sunday Rally Crew", organizer_id="p1", area="Whitefield",
            latitude=12.9698, longitude=77.7499, session_date=date(2026, 8, 30), start_time=time(8), end_time=time(10),
            skill_min=3.0, skill_max=3.5, style="casual", capacity=8, confirmed_player_ids=["p1", "p2", "p3", "p6"],
            social_activity_published=True,
        ),
        Session(
            id="s2", sport="pickleball", group_name="East Bengaluru Social", organizer_id="p3", area="Brookefield",
            latitude=12.9665, longitude=77.7168, session_date=date(2026, 8, 30), start_time=time(9), end_time=time(11),
            skill_min=2.8, skill_max=3.4, style="social", capacity=8, confirmed_player_ids=["p3", "p5"],
        ),
        Session(
            id="s4", sport="pickleball", group_name="Whitefield Beginner Rally", organizer_id="p7", area="Whitefield",
            latitude=12.9698, longitude=77.7499, session_date=date(2026, 8, 29), start_time=time(8), end_time=time(10),
            skill_min=1.8, skill_max=2.8, style="social", capacity=8, confirmed_player_ids=["p7", "p8", "p12"],
        ),
        Session(
            id="s7", sport="pickleball", group_name="Whitefield Full Court Social", organizer_id="p3", area="Whitefield",
            latitude=12.9698, longitude=77.7499, session_date=date(2026, 8, 30), start_time=time(11), end_time=time(13),
            skill_min=2.8, skill_max=3.4, style="social", capacity=8,
            confirmed_player_ids=["p1", "p2", "p3", "p6", "p7", "p8", "p11", "p14"], status="full",
        ),
        Session(
            id="s9", sport="badminton", group_name="Whitefield Evening Badminton", organizer_id="p6", area="Whitefield",
            latitude=12.9698, longitude=77.7499, session_date=date(2026, 9, 2), start_time=time(19), end_time=time(21),
            skill_min=3.2, skill_max=4.0, style="casual", capacity=8, confirmed_player_ids=["p1", "p2", "p6", "p11"],
        ),
    ]
    repository.players = players
    repository.sessions = {session.id: session for session in sessions}
    repository.feedback.clear()
    repository.activity_proofs.clear()
    repository.chat_posts.clear()
    repository.social_posts.clear()
    repository.social_comments.clear()
    repository.join_requests.clear()
    repository.notifications.clear()
    repository.follows.clear()
    repository.tournaments.clear()
    repository.tournament_registrations.clear()
    repository.tournament_matches.clear()
