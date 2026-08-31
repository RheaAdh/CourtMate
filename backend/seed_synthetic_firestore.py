"""Populate Firestore with clearly marked synthetic CourtMate demo data.

By default this script only upserts synthetic ``demo-`` records, stable
``session-activity-demo-*`` engagement records, plus the optional player ID
supplied through ``COURTMATE_DEMO_RHEA_UID``. The optional
``--reset-synthetic`` mode clears only this script's records across CourtMate
collections before rebuilding them. It never touches Firebase Authentication
or unrelated user records. Demo player and carousel media use generated
avatars, not photographs of real people.
"""

from datetime import date, datetime, time, timedelta, timezone
import argparse
import os
import re
from urllib.parse import quote

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
    SocialComment,
    SocialPost,
    cmr_from_legacy_rating,
)
from .repository import FirestoreRepository


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


def avatar_url(name: str, variant: str = "initials") -> str:
    """Use generated avatars in demo data instead of photos of real people."""
    return f"https://api.dicebear.com/9.x/{variant}/svg?seed={quote(name)}&backgroundColor=c9e86b&textColor=1b2b24"


def make_player(player_id: str, name: str, area: str, ratings: dict[str, float], style: str, reliability: float, history_games: int = 4, avatar_number: int | None = None, age: int | None = None, gender: str | None = None) -> Player:
    return Player(
        id=player_id,
        display_name=name,
        profile_image_url=avatar_url(name, "initials" if avatar_number is None else "bottts-neutral"),
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
        social_activity_published=status == "completed",
    )


def delete_firestore_collection(repository: FirestoreRepository, collection_name: str, batch_size: int = 250) -> int:
    """Delete one collection in bounded batches for an explicit social reset."""
    deleted = 0
    while True:
        documents = list(repository.client.collection(collection_name).limit(batch_size).stream())
        if not documents:
            return deleted
        batch = repository.client.batch()
        for document in documents:
            batch.delete(document.reference)
        batch.commit()
        deleted += len(documents)


SYNTHETIC_COLLECTIONS = (
    "players", "sessions", "join_requests", "chat_posts", "feedback", "notifications",
    "follows",
    "social_posts", "social_comments", "activity_proofs", "search_documents",
)


def delete_synthetic_data(repository: FirestoreRepository, rhea_id: str, batch_size: int = 250) -> dict[str, int]:
    """Delete only records belonging to this script, leaving user data intact."""
    deleted: dict[str, int] = {}
    for collection_name in SYNTHETIC_COLLECTIONS:
        documents = list(repository.client.collection(collection_name).stream())
        candidates = []
        for document in documents:
            data = document.to_dict() or {}
            document_id = document.id
            if collection_name == "players":
                is_synthetic = document_id.startswith("demo-") or document_id == rhea_id
            elif collection_name == "feedback":
                is_synthetic = document_id.startswith("demo-feedback-") or str(data.get("session_id", "")).startswith("demo-")
            elif collection_name == "search_documents":
                is_synthetic = str(data.get("source_id", "")).startswith("demo-") or str(data.get("session_id", "")).startswith("demo-")
            else:
                is_synthetic = document_id.startswith("demo-") or "demo-" in document_id or str(data.get("session_id", "")).startswith("demo-")
            if is_synthetic:
                candidates.append(document)
        count = 0
        for offset in range(0, len(candidates), batch_size):
            batch_documents = candidates[offset:offset + batch_size]
            batch = repository.client.batch()
            for document in batch_documents:
                batch.delete(document.reference)
            batch.commit()
            count += len(batch_documents)
        deleted[collection_name] = count
    return deleted


def seed_activity_history(repository: FirestoreRepository, players: list[Player], sessions: list[Session]) -> None:
    """Attach realistic CMR movement points to completed synthetic activities."""
    players_by_id = {player.id: player for player in players}
    movement_by_rank = (2.4, 1.2, -0.6, -1.4, 0.8, -0.9, 1.6, -0.4)
    for session in sessions:
        if session.status != "completed":
            continue
        for rank, player_id in enumerate(session.confirmed_player_ids):
            player = players_by_id.get(player_id)
            if not player or session.sport not in player.cmr_ratings:
                continue
            current = round(player.cmr_ratings[session.sport], 2)
            delta = movement_by_rank[(rank + len(session.id)) % len(movement_by_rank)]
            history = [point for point in player.cmr_history.get(session.sport, []) if point.session_id != session.id]
            history.append(CMRHistoryPoint(
                session_id=session.id,
                session_date=session.session_date,
                group_name=session.group_name,
                game_rating=round(max(0.0, min(100.0, current + delta)), 2),
                rating=current,
                delta=delta,
            ))
            updated_history = dict(player.cmr_history)
            updated_history[session.sport] = history
            players_by_id[player_id] = player.model_copy(update={"cmr_history": updated_history})
    for index, player in enumerate(players):
        players[index] = players_by_id[player.id]
        repository.save_player(players[index])


def seed_social_content(repository: FirestoreRepository, players: list[Player], sessions: list[Session], rhea_id: str, now: datetime) -> tuple[int, int]:
    """Create engagement records for completed session activity cards only."""
    players_by_id = {player.id: player for player in players}
    completed_sessions = [session for session in sessions if session.status == "completed" and session.social_activity_published]
    engagement_specs = {
        "demo-pb-completed": ([rhea_id, "demo-kavya", "demo-rohit"], 2, [("demo-kavya", "That final rally was a great one."), ("demo-rohit", "Good rotation and a really balanced group.")]),
        "demo-tennis-completed": (["demo-neil", rhea_id, "demo-vikram"], 1, [(rhea_id, "The doubles format worked really well.")]),
        "demo-badminton-completed": (["demo-rohit", "demo-isha", "demo-dev"], 3, [("demo-isha", "Fast games and smooth partner changes."), ("demo-dev", "Would happily play this format again.")]),
        "demo-padel-completed": (["demo-meera", "demo-isha", "demo-kabir"], 1, [("demo-kabir", "The lobs were getting serious by the last game.")]),
    }

    post_count = 0
    comment_count = 0
    for session in completed_sessions:
        player = players_by_id.get(session.organizer_id)
        if not player:
            continue
        liked_by, share_count, comments = engagement_specs.get(session.id, ([], 0, []))
        post_id = f"session-activity-{session.id}"
        created_at = datetime.combine(session.session_date, session.start_time, tzinfo=now.tzinfo)
        repository.save_social_post(SocialPost(
            id=post_id,
            player_id=session.organizer_id,
            player_display_name=player.display_name,
            profile_image_url=player.profile_image_url,
            sport=session.sport,
            session_id=session.id,
            caption=f"{player.display_name} completed {session.group_name}.",
            liked_by=[item for item in liked_by if item in players_by_id],
            comment_count=0,
            share_count=share_count,
            created_at=created_at,
        ))
        post_count += 1

        # Give the Home carousel seeded media without using human photographs.
        if session.id == "demo-pb-completed":
            for photo_index in range(1, 3):
                repository.save_social_post(SocialPost(
                    id=f"demo-photo-{session.id}-{photo_index}",
                    player_id=session.organizer_id,
                    player_display_name=player.display_name,
                    profile_image_url=player.profile_image_url,
                    sport=session.sport,
                    session_id=session.id,
                    caption=f"Generated rally moment {photo_index} from {session.group_name}.",
                    media_url=avatar_url(f"{session.group_name} rally moment {photo_index}", "shapes"),
                    media_type="image",
                    created_at=created_at + timedelta(minutes=photo_index),
                ))

        for index, (commenter_id, message) in enumerate(comments, start=1):
            commenter = players_by_id.get(commenter_id)
            if not commenter:
                continue
            repository.save_social_comment(SocialComment(
                id=f"{post_id}-comment-{index}",
                post_id=post_id,
                player_id=commenter_id,
                player_display_name=commenter.display_name,
                profile_image_url=commenter.profile_image_url,
                message=message,
                created_at=created_at + timedelta(minutes=index * 6),
            ))
            comment_count += 1

    return post_count, comment_count


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


def seed(replace_social: bool = False, social_only: bool = False, reset_synthetic: bool = False) -> None:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    rhea_id = os.getenv("COURTMATE_DEMO_RHEA_UID", "demo-rhea-adhikari").strip() or "demo-rhea-adhikari"
    repository = FirestoreRepository(project=project)
    today = date.today()
    now = datetime.now(timezone.utc)
    deleted_synthetic: dict[str, int] = {}
    if reset_synthetic:
        deleted_synthetic = delete_synthetic_data(repository, rhea_id)
    deleted_social_posts = 0
    deleted_social_comments = 0
    if replace_social:
        deleted_social_comments = delete_firestore_collection(repository, "social_comments")
        deleted_social_posts = delete_firestore_collection(repository, "social_posts")

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
        make_session("demo-tennis-completed", "Whitefield Doubles Recap", "demo-neil", "tennis", "Whitefield", today - timedelta(days=5), time(19), time(21), 3.0, 4.6, "casual", ["demo-neil", rhea_id, "demo-vikram", "demo-meera"], status="completed"),
        make_session("demo-tennis-completed-2", "Whitefield Tennis Social", rhea_id, "tennis", "Whitefield", today - timedelta(days=12), time(7), time(9), 3.0, 4.5, "social", [rhea_id, "demo-neil", "demo-arjun", "demo-tara"], status="completed"),
        make_session("demo-tennis-completed-3", "Whitefield Tennis Rally", "demo-meera", "tennis", "Whitefield", today - timedelta(days=19), time(18), time(20), 3.2, 4.8, "competitive", ["demo-meera", rhea_id, "demo-vikram", "demo-arjun"], status="completed"),
        make_session("demo-badminton-completed", "Brookefield Shuttle Recap", "demo-rohit", "badminton", "Brookefield", today - timedelta(days=3), time(20), time(22), 2.8, 4.2, "social", ["demo-rohit", "demo-sana", "demo-isha", "demo-dev"], status="completed"),
        make_session("demo-padel-completed", "Varthur Padel Recap", "demo-vikram", "padel", "Varthur", today - timedelta(days=1), time(9), time(11), 3.0, 4.5, "competitive", ["demo-vikram", "demo-meera", "demo-isha", "demo-kabir"], status="completed"),
        make_session("demo-badminton-awaiting-feedback", "Whitefield Feedback Rally", rhea_id, "badminton", "Whitefield", today - timedelta(days=1), time(18), time(20), 2.8, 4.2, "social", [rhea_id, "demo-sana", "demo-isha", "demo-dev"], status="awaiting_feedback"),
        make_session("demo-tennis-awaiting-feedback", "Whitefield Tennis Review", rhea_id, "tennis", "Whitefield", today - timedelta(days=2), time(19), time(21), 3.0, 4.6, "casual", [rhea_id, "demo-neil"], status="awaiting_feedback"),
    ]
    for session in sessions:
        repository.save_session(session)
    generated_sessions = seed_additional_sessions(repository, players, today)
    seed_activity_history(repository, players, sessions)
    social_post_count, social_comment_count = seed_social_content(repository, players, sessions, rhea_id, now)
    if social_only:
        replacement = f" Replaced {deleted_social_posts} social posts and {deleted_social_comments} social comments." if replace_social else ""
        reset_summary = f" Reset {sum(deleted_synthetic.values())} synthetic documents." if reset_synthetic else ""
        print(f"Seeded synthetic CourtMate social data into {project}: {len(players)} players, {len(sessions) + generated_sessions} sessions, {social_post_count} session activity engagement records, {social_comment_count} social comments.{replacement}{reset_summary}")
        return

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
        ChatPost(id="demo-chat-feedback-1", session_id="demo-badminton-awaiting-feedback", player_id=rhea_id, player_display_name="Rhea Adhikari", message="That was a fun session. Please add your private player ratings when you have a minute.", created_at=now - timedelta(hours=2)),
    ]
    for post in posts:
        repository.save_chat_post(post)

    feedback: list[Feedback] = []
    players_by_id = {player.id: player for player in players}
    for session in sessions:
        if session.status != "completed":
            continue
        session_players = [players_by_id[player_id] for player_id in session.confirmed_player_ids if player_id in players_by_id]
        baseline_order = sorted(
            session_players,
            key=lambda candidate: candidate.cmr_ratings.get(session.sport, 0),
            reverse=True,
        )
        for reviewer_index, reviewer in enumerate(session_players):
            ordered_players = [candidate for candidate in baseline_order if candidate.id != reviewer.id]
            if ordered_players:
                rotation = reviewer_index % len(ordered_players)
                ordered_players = ordered_players[rotation:] + ordered_players[:rotation]
            feedback.append(Feedback(
                session_id=session.id,
                player_id=reviewer.id,
                fun=5,
                fairness=5,
                would_return=True,
                ratings=[
                    PlayerRating(
                        player_id=candidate.id,
                        rank_score=round(100 - (index * 100 / max(len(ordered_players) - 1, 1)), 2),
                    )
                    for index, candidate in enumerate(ordered_players)
                ],
                created_at=now - timedelta(days=max((date.today() - session.session_date).days - 1, 0)),
            ))

    # Leave one awaiting-feedback game one response away from completion so
    # the demo account can verify the full feedback-to-CMR flow.
    feedback.append(Feedback(
        session_id="demo-tennis-awaiting-feedback",
        player_id="demo-neil",
        fun=5,
        fairness=5,
        would_return=True,
        ratings=[PlayerRating(player_id=rhea_id, rating_10=8)],
        created_at=now - timedelta(hours=3),
    ))
    for item in feedback:
        repository.client.collection("feedback").document(f"demo-feedback-{item.session_id}-{item.player_id}").set(item.model_dump(mode="json"))

    notifications = [
        make_notification("demo-notification-rhea-match", rhea_id, "game_match", "A game fits your profile", "East Bengaluru Ladder has a competitive spot near your usual area.", "demo-pb-sun-competitive", now - timedelta(hours=1)),
        make_notification("demo-notification-rhea-follow", rhea_id, "follow", "Demo Meera followed you", "You have a new follower from the Varthur pickleball community.", "", now - timedelta(hours=3), actor_id="demo-meera"),
        make_notification("demo-notification-rhea-update", rhea_id, "request_update", "Your game request was approved", "You are confirmed for East Bengaluru Ladder.", "demo-pb-sun-competitive", now - timedelta(days=2), request_id=f"demo-pb-sun-competitive:{rhea_id}"),
        make_notification("demo-notification-rhea-pending", rhea_id, "request_update", "Your request is waiting", "The organizer is reviewing your Brookefield Badminton Mix request.", "demo-badminton-evening", now - timedelta(hours=7), request_id=f"demo-badminton-evening:{rhea_id}"),
        make_notification("demo-notification-rhea-feedback", rhea_id, "game_completed", "Rate your Whitefield Feedback Rally", "The game is ready for private player ratings. Finish when the group is ready.", "demo-badminton-awaiting-feedback", now - timedelta(hours=2), actor_id=rhea_id),
        make_notification("demo-notification-organizer-request", rhea_id, "join_request", "Demo Rohit wants to join", "Review the request for Whitefield Sunset Rally.", "demo-pb-sat-evening", now - timedelta(hours=2), request_id="demo-pb-sat-evening:demo-rohit", actor_id="demo-rohit"),
    ]
    for notification in notifications:
        repository.save_notification(notification)

    replacement = f" Replaced {deleted_social_posts} social posts and {deleted_social_comments} social comments." if replace_social else ""
    reset_summary = f" Reset {sum(deleted_synthetic.values())} synthetic documents." if reset_synthetic else ""
    print(f"Seeded synthetic CourtMate data into {project}: {len(players)} players, {len(sessions) + generated_sessions} sessions, {len(requests)} requests, {len(posts)} chat posts, {social_post_count} session activity engagement records, {social_comment_count} social comments, {len(feedback)} feedback records, {len(follows)} follows, {len(notifications)} notifications.{replacement}{reset_summary}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed synthetic CourtMate data.")
    parser.add_argument(
        "--replace-social",
        action="store_true",
        help="Delete all Firestore social_posts and social_comments before seeding completed-session activity cards.",
    )
    parser.add_argument(
        "--social-only",
        action="store_true",
        help="Stop after rebuilding players, sessions, and completed-session social activity data.",
    )
    parser.add_argument(
        "--reset-synthetic",
        action="store_true",
        help="Delete only this script's synthetic records across CourtMate collections before reseeding.",
    )
    arguments = parser.parse_args()
    if arguments.social_only and not arguments.replace_social:
        parser.error("--social-only requires --replace-social")
    seed(replace_social=arguments.replace_social, social_only=arguments.social_only, reset_synthetic=arguments.reset_synthetic)
