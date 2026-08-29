"""Populate Firestore with clearly marked synthetic CourtMate demo data.

This script only upserts records whose IDs start with ``demo-``. It never
touches Firebase Authentication or non-CourtMate collections.
"""

from datetime import date, datetime, time, timedelta, timezone
import os

from .models import ChatPost, Feedback, FollowRecord, JoinRequest, Player, PlayerRating, Session, cmr_from_legacy_rating
from .repository import FirestoreRepository


COORDINATES = {
    "Whitefield": (12.9698, 77.7499),
    "Brookefield": (12.9665, 77.7168),
    "Varthur": (12.9408, 77.7460),
    "Marathahalli": (12.9569, 77.7011),
}


def make_player(player_id: str, name: str, area: str, ratings: dict[str, float], style: str, reliability: float) -> Player:
    return Player(
        id=player_id,
        display_name=name,
        area=area,
        latitude=COORDINATES[area][0],
        longitude=COORDINATES[area][1],
        travel_radius_km=12,
        sport_ratings=ratings,
        rating_sources={sport: "synthetic" for sport in ratings},
        cmr_ratings={sport: cmr_from_legacy_rating(rating) for sport, rating in ratings.items()},
        cmr_game_counts={sport: 4 for sport in ratings},
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


def seed() -> None:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    repository = FirestoreRepository(project=project)
    today = date.today()
    now = datetime.now(timezone.utc)

    players = [
        make_player("demo-organizer-wf", "Demo Ananya", "Whitefield", {"pickleball": 3.4, "tennis": 3.8}, "casual", 0.96),
        make_player("demo-kavya", "Demo Kavya", "Whitefield", {"pickleball": 3.2, "tennis": 3.5}, "casual", 0.91),
        make_player("demo-rohit", "Demo Rohit", "Brookefield", {"pickleball": 3.5, "badminton": 4.1}, "social", 0.88),
        make_player("demo-meera", "Demo Meera", "Varthur", {"pickleball": 3.8, "tennis": 4.2}, "competitive", 0.94),
        make_player("demo-sana", "Demo Sana", "Whitefield", {"pickleball": 2.9, "badminton": 3.6}, "social", 0.86),
        make_player("demo-vikram", "Demo Vikram", "Marathahalli", {"pickleball": 4.4, "tennis": 4.6}, "competitive", 0.90),
        make_player("demo-pooja", "Demo Pooja", "Whitefield", {"pickleball": 2.5, "badminton": 2.8}, "casual", 0.82),
        make_player("demo-neil", "Demo Neil", "Brookefield", {"tennis": 3.2, "padel": 3.0}, "social", 0.84),
    ]
    for player in players:
        repository.save_player(player)

    follows = [
        FollowRecord(id="demo-organizer-wf_demo-kavya", follower_id="demo-organizer-wf", following_id="demo-kavya", created_at=now - timedelta(days=9)),
        FollowRecord(id="demo-kavya_demo-organizer-wf", follower_id="demo-kavya", following_id="demo-organizer-wf", created_at=now - timedelta(days=8)),
        FollowRecord(id="demo-rohit_demo-sana", follower_id="demo-rohit", following_id="demo-sana", created_at=now - timedelta(days=6)),
        FollowRecord(id="demo-meera_demo-vikram", follower_id="demo-meera", following_id="demo-vikram", created_at=now - timedelta(days=4)),
    ]
    for follow in follows:
        repository.save_follow(follow)

    sessions = [
        make_session("demo-pb-sat-evening", "Whitefield Sunset Rally", "demo-organizer-wf", "pickleball", "Whitefield", today, time(18), time(20), 3.0, 3.8, "casual", ["demo-organizer-wf", "demo-kavya", "demo-sana"], ["demo-pooja"]),
        make_session("demo-pb-sun-morning", "Sunday Any Rally", "demo-rohit", "pickleball", "Brookefield", today + timedelta(days=1), time(8), time(10), 3.0, 3.7, "social", ["demo-rohit", "demo-meera", "demo-sana", "demo-pooja"]),
        make_session("demo-pb-sun-competitive", "East Bengaluru Ladder", "demo-meera", "pickleball", "Varthur", today + timedelta(days=2), time(7), time(9), 3.6, 4.8, "competitive", ["demo-meera", "demo-vikram", "demo-organizer-wf"]),
        make_session("demo-pb-full", "Whitefield Full Court Social", "demo-organizer-wf", "pickleball", "Whitefield", today + timedelta(days=3), time(19), time(21), 2.8, 3.6, "social", ["demo-organizer-wf", "demo-kavya", "demo-rohit", "demo-meera", "demo-sana", "demo-pooja", "demo-neil", "demo-vikram"], status="full"),
        make_session("demo-tennis-evening", "Whitefield Tennis Doubles", "demo-neil", "tennis", "Whitefield", today + timedelta(days=1), time(19), time(21), 3.0, 4.2, "casual", ["demo-neil", "demo-organizer-wf", "demo-vikram"]),
        make_session("demo-badminton-evening", "Brookefield Badminton Mix", "demo-rohit", "badminton", "Brookefield", today + timedelta(days=2), time(20), time(22), 2.8, 4.2, "social", ["demo-rohit", "demo-sana", "demo-pooja"]),
        make_session("demo-padel-sunday", "Varthur Padel Pairs", "demo-vikram", "padel", "Varthur", today + timedelta(days=4), time(9), time(11), 3.0, 4.5, "competitive", ["demo-vikram", "demo-meera"]),
        make_session("demo-pb-completed", "Past Sunday Rally", "demo-organizer-wf", "pickleball", "Whitefield", today - timedelta(days=7), time(8), time(10), 3.0, 3.8, "casual", ["demo-organizer-wf", "demo-kavya", "demo-rohit", "demo-sana"], status="completed"),
    ]
    for session in sessions:
        repository.save_session(session)

    requests = [
        JoinRequest(id="demo-pb-sat-evening:demo-rohit", session_id="demo-pb-sat-evening", player_id="demo-rohit", player_display_name="Demo Rohit", status="pending", created_at=now - timedelta(hours=2)),
        JoinRequest(id="demo-pb-sat-evening:demo-pooja", session_id="demo-pb-sat-evening", player_id="demo-pooja", player_display_name="Demo Pooja", status="waitlisted", created_at=now - timedelta(hours=5)),
        JoinRequest(id="demo-pb-sun-morning:demo-kavya", session_id="demo-pb-sun-morning", player_id="demo-kavya", player_display_name="Demo Kavya", status="approved", created_at=now - timedelta(days=1)),
        JoinRequest(id="demo-tennis-evening:demo-meera", session_id="demo-tennis-evening", player_id="demo-meera", player_display_name="Demo Meera", status="pending", created_at=now - timedelta(hours=1)),
    ]
    for request in requests:
        repository.save_join_request(request)

    posts = [
        ChatPost(id="demo-chat-pb-sat-1", session_id="demo-pb-sat-evening", player_id="demo-organizer-wf", player_display_name="Demo Ananya", message="Court is pencilled in at 6 PM. Please confirm by lunch.", created_at=now - timedelta(hours=4)),
        ChatPost(id="demo-chat-pb-sat-2", session_id="demo-pb-sat-evening", player_id="demo-kavya", player_display_name="Demo Kavya", message="I can bring a spare set of balls.", created_at=now - timedelta(hours=3)),
        ChatPost(id="demo-chat-pb-sun-1", session_id="demo-pb-sun-morning", player_id="demo-rohit", player_display_name="Demo Rohit", message="Let us keep this social and rotate partners every game.", created_at=now - timedelta(days=1)),
    ]
    for post in posts:
        repository.save_chat_post(post)

    feedback = [
        Feedback(session_id="demo-pb-completed", player_id="demo-organizer-wf", fun=5, fairness=5, would_return=True, ratings=[PlayerRating(player_id="demo-kavya", rating=5), PlayerRating(player_id="demo-rohit", rating=4), PlayerRating(player_id="demo-sana", rating=5)], created_at=now - timedelta(days=6)),
        Feedback(session_id="demo-pb-completed", player_id="demo-kavya", fun=5, fairness=4, would_return=True, ratings=[PlayerRating(player_id="demo-organizer-wf", rating=5), PlayerRating(player_id="demo-rohit", rating=4), PlayerRating(player_id="demo-sana", rating=4)], created_at=now - timedelta(days=6)),
    ]
    for item in feedback:
        repository.client.collection("feedback").document(f"demo-feedback-{item.player_id}").set(item.model_dump(mode="json"))

    print(f"Seeded synthetic CourtMate data into {project}: {len(players)} players, {len(sessions)} sessions, {len(requests)} requests, {len(posts)} chat posts, {len(feedback)} feedback records, {len(follows)} follows.")


if __name__ == "__main__":
    seed()
