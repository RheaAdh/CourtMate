"""Populate Firestore with clearly marked synthetic CourtMate demo data.

This script only upserts records whose IDs start with ``demo-``, plus the
optional player ID supplied through ``COURTMATE_DEMO_RHEA_UID``. It never
touches Firebase Authentication or non-CourtMate collections.
"""

from datetime import date, datetime, time, timedelta, timezone
import os
import re

from .models import (
    AppNotification,
    CMRHistoryPoint,
    ChatPost,
    Feedback,
    FollowRecord,
    JoinRequest,
    Player,
    PlayerRating,
    Session,
    Tournament,
    TournamentRegistration,
    cmr_from_legacy_rating,
)
from .repository import FirestoreRepository
from .tournaments import generate_round_robin_matches, rules_for_sport


COORDINATES = {
    "Whitefield": (12.9698, 77.7499),
    "Brookefield": (12.9665, 77.7168),
    "Varthur": (12.9408, 77.7460),
    "Marathahalli": (12.9569, 77.7011),
    "Indiranagar": (12.9784, 77.6408),
    "Koramangala": (12.9352, 77.6245),
    "HSR Layout": (12.9116, 77.6389),
    "Sarjapur": (12.9279, 77.6271),
    "Bellandur": (12.9255, 77.6762),
    "Kadubeesanahalli": (12.9358, 77.6900),
}


def make_history(player_id: str, ratings: dict[str, float], games: int) -> dict[str, list[CMRHistoryPoint]]:
    history: dict[str, list[CMRHistoryPoint]] = {}
    for sport, legacy_rating in ratings.items():
        target = cmr_from_legacy_rating(legacy_rating)
        points: list[CMRHistoryPoint] = []
        previous = max(0.0, target - 8.0)
        for index in range(games):
            progress = (index + 1) / games
            current = round(max(0.0, min(100.0, target - 8.0 + progress * 8.0)), 2)
            points.append(CMRHistoryPoint(
                session_id=f"demo-history-{player_id}-{sport}-{index + 1}",
                session_date=date.today() - timedelta(days=(games - index) * 9),
                group_name=f"{sport.replace('_', ' ').title()} Demo Rally {index + 1}",
                game_rating=round(max(0.0, min(100.0, current + (2.0 if index % 2 == 0 else -1.0))), 2),
                rating=current,
                delta=round(current - previous, 2),
            ))
            previous = current
        history[sport] = points
    return history


def make_player(player_id: str, name: str, area: str, ratings: dict[str, float], style: str, reliability: float, history_games: int = 4, avatar_number: int | None = None, age: int | None = None, gender: str | None = None) -> Player:
    return Player(
        id=player_id,
        display_name=name,
        profile_image_url=f"https://i.pravatar.cc/160?img={avatar_number}" if avatar_number else None,
        area=area,
        age=age,
        gender=gender,
        latitude=COORDINATES[area][0],
        longitude=COORDINATES[area][1],
        travel_radius_km=12,
        sport_ratings=ratings,
        rating_sources={sport: "synthetic" for sport in ratings},
        cmr_ratings={sport: cmr_from_legacy_rating(rating) for sport, rating in ratings.items()},
        cmr_game_counts={sport: history_games for sport in ratings},
        cmr_history=make_history(player_id, ratings, history_games),
        cmr_scale=100,
        rating_source="synthetic",
        rating_confidence=0.8,
        style=style,
        reliability=reliability,
        availability=["weekday evenings", "weekend mornings"],
    )


def make_session(session_id: str, name: str, organizer_id: str, sport: str, area: str, session_date: date, start: time, end: time, minimum: float, maximum: float, style: str, confirmed: list[str], waitlist: list[str] | None = None, status: str = "open") -> Session:
    return Session(
        id=session_id,
        group_name=name,
        organizer_id=organizer_id,
        sport=sport,
        area=area,
        latitude=COORDINATES[area][0],
        longitude=COORDINATES[area][1],
        venue_name=f"Demo {area} Courts",
        session_date=session_date,
        start_time=start,
        end_time=end,
        skill_min=minimum,
        skill_max=maximum,
        style=style,
        capacity=8,
        confirmed_player_ids=confirmed,
        waitlist_player_ids=waitlist or [],
        external_booking_url="https://playo.co/",
        status=status,
    )


def seed_additional_sessions(repository: FirestoreRepository, players: list[Player], today: date) -> int:
    """Create a broad, stable discovery corpus for demos and vector retrieval."""
    areas = ["Whitefield", "Brookefield", "Varthur", "Marathahalli", "Indiranagar", "Koramangala", "HSR Layout", "Sarjapur", "Bellandur", "Kadubeesanahalli"]
    session_templates = [
        ("pickleball", "Rally", time(7), time(9), 2.6, 3.6, "casual"),
        ("badminton", "Shuttle", time(19), time(21), 2.4, 3.5, "social"),
        ("tennis", "Doubles", time(6, 30), time(8, 30), 3.0, 4.4, "casual"),
        ("padel", "Pairs", time(20), time(22), 3.2, 4.7, "competitive"),
        ("squash", "Ladder", time(18), time(20), 3.5, 4.8, "competitive"),
        ("table_tennis", "Spin", time(8), time(10), 2.0, 3.4, "social"),
    ]
    seeded = 0
    for area_index, area in enumerate(areas):
        for sport_index, (sport, format_name, start_hour, end_hour, minimum, maximum, style) in enumerate(session_templates):
            date_offset = 1 + ((area_index * 3 + sport_index * 2) % 20)
            slug = re.sub(r"[^a-z0-9]+", "-", area.lower()).strip("-")
            session_id = f"demo-generated-{slug}-{sport}"
            organizer = players[(area_index + sport_index) % len(players)]
            confirmed = [organizer.id]
            for step in range(1, 4):
                member = players[(area_index + sport_index + step) % len(players)]
                if member.id not in confirmed:
                    confirmed.append(member.id)
            waitlist = [players[(area_index + sport_index + 5) % len(players)].id]
            session = make_session(
                session_id,
                f"{area} {format_name} {sport.replace('_', ' ').title()}",
                organizer.id,
                sport,
                area,
                today + timedelta(days=date_offset),
                start_hour,
                end_hour,
                minimum,
                maximum,
                style,
                confirmed,
                waitlist,
            )
            repository.save_session(session)
            seeded += 1
    return seeded


def make_notification(notification_id: str, player_id: str, kind: str, title: str, message: str, session_id: str, now: datetime, request_id: str | None = None, actor_id: str | None = None, read: bool = False) -> AppNotification:
    return AppNotification(
        id=notification_id,
        player_id=player_id,
        kind=kind,
        title=title,
        message=message,
        session_id=session_id,
        request_id=request_id,
        actor_id=actor_id,
        read=read,
        created_at=now,
    )


def seed_tournaments(repository: FirestoreRepository, players: list[Player], organizer_id: str, today: date, now: datetime) -> int:
    """Create registration, live, and completed events across racket sports."""
    players_by_id = {player.id: player for player in players}
    events = [
        Tournament(
            id="demo-tournament-registration",
            name="Whitefield Rally Cup",
            sport="pickleball",
            organizer_id=organizer_id,
            area="Whitefield",
            venue_name="Demo Whitefield Courts",
            tournament_date=today + timedelta(days=10),
            capacity=8,
            status="registration",
            created_at=now - timedelta(days=2),
            rules=rules_for_sport("pickleball"),
        ),
        Tournament(
            id="demo-tournament-live",
            name="East Bengaluru Paddle League",
            sport="pickleball",
            organizer_id="demo-meera",
            area="Brookefield",
            venue_name="Demo Brookefield Courts",
            tournament_date=today - timedelta(days=1),
            capacity=6,
            status="in_progress",
            created_at=now - timedelta(days=12),
            rules=rules_for_sport("pickleball"),
        ),
        Tournament(
            id="demo-tournament-tennis",
            name="Whitefield Tennis Social Draw",
            sport="tennis",
            organizer_id="demo-neil",
            area="Whitefield",
            venue_name="Demo Whitefield Courts",
            tournament_date=today - timedelta(days=15),
            capacity=4,
            status="completed",
            created_at=now - timedelta(days=24),
            rules=rules_for_sport("tennis"),
        ),
        Tournament(
            id="demo-tournament-badminton",
            name="HSR Shuttle Cup",
            sport="badminton",
            organizer_id="demo-rohit",
            area="HSR Layout",
            venue_name="Demo HSR Courts",
            tournament_date=today + timedelta(days=14),
            capacity=8,
            status="registration",
            created_at=now - timedelta(days=1),
            rules=rules_for_sport("badminton"),
        ),
        Tournament(
            id="demo-tournament-padel",
            name="Bellandur Padel Pairs",
            sport="padel",
            organizer_id="demo-vikram",
            area="Bellandur",
            venue_name="Demo Bellandur Courts",
            tournament_date=today + timedelta(days=9),
            capacity=6,
            status="registration",
            created_at=now - timedelta(days=3),
            rules=rules_for_sport("padel"),
        ),
        Tournament(
            id="demo-tournament-squash",
            name="Koramangala Squash Ladder",
            sport="squash",
            organizer_id="demo-meera",
            area="Koramangala",
            venue_name="Demo Koramangala Courts",
            tournament_date=today + timedelta(days=18),
            capacity=8,
            status="registration",
            created_at=now - timedelta(days=4),
            rules=rules_for_sport("squash"),
        ),
        Tournament(
            id="demo-tournament-table-tennis",
            name="Indiranagar Table Tennis Open",
            sport="table_tennis",
            organizer_id="demo-neil",
            area="Indiranagar",
            venue_name="Demo Indiranagar Courts",
            tournament_date=today + timedelta(days=11),
            capacity=8,
            status="registration",
            created_at=now - timedelta(days=2),
            rules=rules_for_sport("table_tennis"),
        ),
    ]
    registration_specs = {
        "demo-tournament-registration": [organizer_id, "demo-kavya", "demo-rohit", "demo-sana", "demo-pooja", "demo-meera"],
        "demo-tournament-live": ["demo-meera", "demo-vikram", organizer_id, "demo-kavya", "demo-rohit", "demo-sana"],
        "demo-tournament-tennis": ["demo-neil", organizer_id, "demo-vikram", "demo-meera"],
        "demo-tournament-badminton": ["demo-rohit", "demo-sana", "demo-pooja", "demo-isha", "demo-kavya"],
        "demo-tournament-padel": ["demo-vikram", "demo-meera", "demo-neil", "demo-isha"],
        "demo-tournament-squash": ["demo-meera", "demo-vikram", "demo-isha", "demo-arjun"],
        "demo-tournament-table-tennis": ["demo-neil", "demo-isha", "demo-arjun", "demo-pooja"],
    }

    for event in events:
        registration_ids: list[str] = []
        registrations: list[TournamentRegistration] = []
        for index, player_id in enumerate(registration_specs[event.id]):
            player = players_by_id[player_id]
            registration = TournamentRegistration(
                id=f"{event.id}_{player_id}",
                tournament_id=event.id,
                player_id=player_id,
                display_name=player.display_name,
                status="registered",
                cmr_rating=player.cmr_ratings.get(event.sport),
                created_at=event.created_at + timedelta(minutes=index * 7),
            )
            registrations.append(registration)
            registration_ids.append(registration.id)
            repository.save_tournament_registration(registration)
        event.registration_ids = registration_ids
        repository.save_tournament(event)

        if event.status == "registration":
            continue

        matches = generate_round_robin_matches(event.id, registrations)
        for index, match in enumerate(matches):
            if event.id == "demo-tournament-live" and index < 4:
                match.score_a = 11 if index % 2 == 0 else 8
                match.score_b = 8 if index % 2 == 0 else 11
                match.winner_id = match.player_a_id if match.score_a > match.score_b else match.player_b_id
                match.status = "completed" if index < 3 else "pending_confirmation"
                match.score_entered_by = organizer_id if index == 3 else match.player_a_id
                match.confirmed_by = organizer_id if index < 3 else None
            elif event.id == "demo-tournament-tennis":
                match.score_a = 2 if index % 2 == 0 else 1
                match.score_b = 1 if index % 2 == 0 else 2
                match.winner_id = match.player_a_id if match.score_a > match.score_b else match.player_b_id
                match.status = "completed"
                match.score_entered_by = event.organizer_id
                match.confirmed_by = event.organizer_id
            else:
                match.status = "scheduled"
            repository.save_tournament_match(match)
    return len(events)


def seed() -> None:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    rhea_id = os.getenv("COURTMATE_DEMO_RHEA_UID", "demo-rhea-adhikari").strip() or "demo-rhea-adhikari"
    repository = FirestoreRepository(project=project)
    today = date.today()
    now = datetime.now(timezone.utc)

    players = [
        make_player(rhea_id, "Rhea Adhikari", "Whitefield", {"pickleball": 3.9, "tennis": 4.3, "badminton": 3.6, "padel": 3.2}, "casual", 0.95, history_games=8, age=29, gender="woman"),
        make_player("demo-organizer-wf", "Demo Ananya", "Whitefield", {"pickleball": 3.4, "tennis": 3.8}, "casual", 0.96, avatar_number=44, age=31, gender="woman"),
        make_player("demo-kavya", "Demo Kavya", "Whitefield", {"pickleball": 3.2, "tennis": 3.5}, "casual", 0.91, avatar_number=45, age=27, gender="woman"),
        make_player("demo-rohit", "Demo Rohit", "Brookefield", {"pickleball": 3.5, "badminton": 4.1}, "social", 0.88, avatar_number=12, age=34, gender="man"),
        make_player("demo-meera", "Demo Meera", "Varthur", {"pickleball": 3.8, "tennis": 4.2}, "competitive", 0.94, avatar_number=32, age=30, gender="woman"),
        make_player("demo-sana", "Demo Sana", "Whitefield", {"pickleball": 2.9, "badminton": 3.6}, "social", 0.86, avatar_number=25, age=24, gender="woman"),
        make_player("demo-vikram", "Demo Vikram", "Marathahalli", {"pickleball": 4.4, "tennis": 4.6}, "competitive", 0.90, avatar_number=13, age=38, gender="man"),
        make_player("demo-pooja", "Demo Pooja", "Whitefield", {"pickleball": 2.5, "badminton": 2.8}, "casual", 0.82, avatar_number=5, age=42, gender="woman"),
        make_player("demo-neil", "Demo Neil", "Brookefield", {"tennis": 3.2, "padel": 3.0}, "social", 0.84, avatar_number=11, age=46, gender="man"),
        make_player("demo-isha", "Demo Isha", "HSR Layout", {"badminton": 3.8, "padel": 3.6, "squash": 3.5, "table_tennis": 3.3}, "casual", 0.89, avatar_number=18, age=28, gender="woman"),
        make_player("demo-arjun", "Demo Arjun", "Koramangala", {"tennis": 4.1, "squash": 4.2, "table_tennis": 3.9}, "competitive", 0.92, avatar_number=20, age=32, gender="man"),
        make_player("demo-nisha", "Demo Nisha", "Sarjapur", {"pickleball": 3.1, "badminton": 3.2, "tennis": 3.4, "table_tennis": 2.9}, "social", 0.87, avatar_number=23, age=26, gender="woman"),
        make_player("demo-kabir", "Demo Kabir", "Bellandur", {"pickleball": 4.0, "padel": 4.2, "tennis": 4.4}, "competitive", 0.93, avatar_number=27, age=35, gender="man"),
        make_player("demo-tara", "Demo Tara", "Indiranagar", {"badminton": 2.7, "tennis": 3.0, "squash": 2.8}, "casual", 0.81, avatar_number=29, age=30, gender="woman"),
        make_player("demo-dev", "Demo Dev", "Kadubeesanahalli", {"pickleball": 3.7, "badminton": 4.0, "padel": 3.8, "table_tennis": 4.1}, "social", 0.90, avatar_number=31, age=37, gender="man"),
    ]
    for player in players:
        repository.save_player(player)

    follows = [
        FollowRecord(id=f"{rhea_id}_demo-kavya", follower_id=rhea_id, following_id="demo-kavya", created_at=now - timedelta(days=9)),
        FollowRecord(id=f"demo-kavya_{rhea_id}", follower_id="demo-kavya", following_id=rhea_id, created_at=now - timedelta(days=8)),
        FollowRecord(id="demo-rohit_demo-sana", follower_id="demo-rohit", following_id="demo-sana", created_at=now - timedelta(days=6)),
        FollowRecord(id="demo-meera_demo-vikram", follower_id="demo-meera", following_id="demo-vikram", created_at=now - timedelta(days=4)),
    ]
    for follow in follows:
        repository.save_follow(follow)

    sessions = [
        make_session("demo-pb-sat-evening", "Whitefield Sunset Rally", rhea_id, "pickleball", "Whitefield", today, time(18), time(20), 3.0, 4.1, "casual", [rhea_id, "demo-kavya", "demo-sana"], ["demo-pooja"]),
        make_session("demo-pb-sun-morning", "Sunday Any Rally", "demo-rohit", "pickleball", "Brookefield", today + timedelta(days=1), time(8), time(10), 3.0, 3.7, "social", ["demo-rohit", "demo-meera", "demo-sana", "demo-pooja"]),
        make_session("demo-pb-sun-competitive", "East Bengaluru Ladder", "demo-meera", "pickleball", "Varthur", today + timedelta(days=2), time(7), time(9), 3.6, 4.8, "competitive", ["demo-meera", "demo-vikram", rhea_id]),
        make_session("demo-pb-full", "Whitefield Full Court Social", rhea_id, "pickleball", "Whitefield", today + timedelta(days=3), time(19), time(21), 2.8, 4.1, "social", [rhea_id, "demo-kavya", "demo-rohit", "demo-meera", "demo-sana", "demo-pooja", "demo-neil", "demo-vikram"], status="full"),
        make_session("demo-tennis-evening", "Whitefield Tennis Doubles", "demo-neil", "tennis", "Whitefield", today + timedelta(days=1), time(19), time(21), 3.0, 4.6, "casual", ["demo-neil", rhea_id, "demo-vikram"]),
        make_session("demo-badminton-evening", "Brookefield Badminton Mix", "demo-rohit", "badminton", "Brookefield", today + timedelta(days=2), time(20), time(22), 2.8, 4.2, "social", ["demo-rohit", "demo-sana", "demo-pooja"]),
        make_session("demo-padel-sunday", "Varthur Padel Pairs", "demo-vikram", "padel", "Varthur", today + timedelta(days=4), time(9), time(11), 3.0, 4.5, "competitive", ["demo-vikram", "demo-meera"]),
        make_session("demo-pb-completed", "Past Sunday Rally", rhea_id, "pickleball", "Whitefield", today - timedelta(days=7), time(8), time(10), 3.0, 4.1, "casual", [rhea_id, "demo-kavya", "demo-rohit", "demo-sana"], status="completed"),
    ]
    for session in sessions:
        repository.save_session(session)
    generated_sessions = seed_additional_sessions(repository, players, today)

    requests = [
        JoinRequest(id="demo-pb-sat-evening:demo-rohit", session_id="demo-pb-sat-evening", player_id="demo-rohit", player_display_name="Demo Rohit", status="pending", created_at=now - timedelta(hours=2)),
        JoinRequest(id="demo-pb-sat-evening:demo-pooja:waitlist", session_id="demo-pb-sat-evening", player_id="demo-pooja", player_display_name="Demo Pooja", status="waitlisted", created_at=now - timedelta(hours=5)),
        JoinRequest(id="demo-pb-sun-morning:demo-kavya", session_id="demo-pb-sun-morning", player_id="demo-kavya", player_display_name="Demo Kavya", status="approved", created_at=now - timedelta(days=1)),
        JoinRequest(id="demo-tennis-evening:demo-meera", session_id="demo-tennis-evening", player_id="demo-meera", player_display_name="Demo Meera", status="pending", created_at=now - timedelta(hours=1)),
        JoinRequest(id=f"demo-pb-sun-competitive:{rhea_id}", session_id="demo-pb-sun-competitive", player_id=rhea_id, player_display_name="Rhea Adhikari", status="approved", created_at=now - timedelta(days=2)),
        JoinRequest(id=f"demo-badminton-evening:{rhea_id}", session_id="demo-badminton-evening", player_id=rhea_id, player_display_name="Rhea Adhikari", status="pending", created_at=now - timedelta(hours=7)),
        JoinRequest(id="demo-pb-full:demo-neil", session_id="demo-pb-full", player_id="demo-neil", player_display_name="Demo Neil", status="declined", created_at=now - timedelta(days=3)),
    ]
    for request in requests:
        repository.save_join_request(request)

    posts = [
        ChatPost(id="demo-chat-pb-sat-1", session_id="demo-pb-sat-evening", player_id=rhea_id, player_display_name="Rhea Adhikari", message="Court is pencilled in at 6 PM. Please confirm by lunch.", created_at=now - timedelta(hours=4)),
        ChatPost(id="demo-chat-pb-sat-2", session_id="demo-pb-sat-evening", player_id="demo-kavya", player_display_name="Demo Kavya", message="I can bring a spare set of balls.", created_at=now - timedelta(hours=3)),
        ChatPost(id="demo-chat-pb-sun-1", session_id="demo-pb-sun-morning", player_id="demo-rohit", player_display_name="Demo Rohit", message="Let us keep this social and rotate partners every game.", created_at=now - timedelta(days=1)),
    ]
    for post in posts:
        repository.save_chat_post(post)

    feedback = [
        Feedback(session_id="demo-pb-completed", player_id=rhea_id, fun=5, fairness=5, would_return=True, ratings=[PlayerRating(player_id="demo-kavya", rating=5), PlayerRating(player_id="demo-rohit", rating=4), PlayerRating(player_id="demo-sana", rating=5)], created_at=now - timedelta(days=6)),
        Feedback(session_id="demo-pb-completed", player_id="demo-kavya", fun=5, fairness=4, would_return=True, ratings=[PlayerRating(player_id=rhea_id, rating=5), PlayerRating(player_id="demo-rohit", rating=4), PlayerRating(player_id="demo-sana", rating=4)], created_at=now - timedelta(days=6)),
    ]
    for item in feedback:
        repository.client.collection("feedback").document(f"demo-feedback-{item.player_id}").set(item.model_dump(mode="json"))

    notifications = [
        make_notification("demo-notification-rhea-match", rhea_id, "game_match", "A game fits your profile", "East Bengaluru Ladder has a competitive spot near your usual area.", "demo-pb-sun-competitive", now - timedelta(hours=1)),
        make_notification("demo-notification-rhea-follow", rhea_id, "follow", "Demo Meera followed you", "You have a new follower from the Varthur pickleball community.", "", now - timedelta(hours=3), actor_id="demo-meera"),
        make_notification("demo-notification-rhea-update", rhea_id, "request_update", "Your game request was approved", "You are confirmed for East Bengaluru Ladder.", "demo-pb-sun-competitive", now - timedelta(days=2), request_id=f"demo-pb-sun-competitive:{rhea_id}"),
        make_notification("demo-notification-rhea-pending", rhea_id, "request_update", "Your request is waiting", "The organizer is reviewing your Brookefield Badminton Mix request.", "demo-badminton-evening", now - timedelta(hours=7), request_id=f"demo-badminton-evening:{rhea_id}"),
        make_notification("demo-notification-organizer-request", rhea_id, "join_request", "Demo Rohit wants to join", "Review the request for Whitefield Sunset Rally.", "demo-pb-sat-evening", now - timedelta(hours=2), request_id="demo-pb-sat-evening:demo-rohit", actor_id="demo-rohit"),
    ]
    for notification in notifications:
        repository.save_notification(notification)

    tournament_count = seed_tournaments(repository, players, rhea_id, today, now)

    print(f"Seeded synthetic CourtMate data into {project}: {len(players)} players, {len(sessions) + generated_sessions} sessions, {len(requests)} requests, {len(posts)} chat posts, {len(feedback)} feedback records, {len(follows)} follows, {len(notifications)} notifications, {tournament_count} tournaments.")


if __name__ == "__main__":
    seed()
