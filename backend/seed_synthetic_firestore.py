"""Populate Firestore with realistic, safely scoped CourtMate showcase data.

By default this script only upserts synthetic ``demo-`` records, stable
``session-activity-demo-*`` engagement records, plus the optional player ID
supplied through ``COURTMATE_DEMO_RHEA_UID``. The optional
``--reset-synthetic`` mode clears only this script's records across CourtMate
collections before rebuilding them. It never touches Firebase Authentication
or unrelated user records. Synthetic profiles intentionally omit image URLs so
the product renders its native initials treatment.
"""

from datetime import date, datetime, time, timedelta, timezone
import argparse
import os
import re

from .models import (
    AppNotification,
    CMRHistoryPoint,
    ChatPost,
    CommunityMembership,
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
from .repository import FirestoreRepository, Repository


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

VENUES = {
    "Whitefield": "Sporthood Whitefield",
    "Brookefield": "Racqueteers Sports Centre",
    "Varthur": "Varthur Racquet Club",
    "Marathahalli": "Play Arena Marathahalli",
    "Indiranagar": "Indiranagar Club Courts",
    "Koramangala": "Games Point Koramangala",
    "HSR Layout": "HSR Sports Arena",
    "Sarjapur": "Sarjapur Racquet Hub",
    "Bellandur": "Bellandur Sports Park",
    "Kadubeesanahalli": "Active Arena Kadubeesanahalli",
}


def make_history(player_id: str, ratings: dict[str, float], games: int) -> dict[str, list[CMRHistoryPoint]]:
    history: dict[str, list[CMRHistoryPoint]] = {}
    for sport, legacy_rating in ratings.items():
        target = cmr_from_legacy_rating(legacy_rating)
        points: list[CMRHistoryPoint] = []
        previous = max(1.0, target - 0.72)
        for index in range(games):
            progress = (index + 1) / games
            current = round(max(1.0, min(10.0, target - 0.72 + progress * 0.72)), 2)
            points.append(CMRHistoryPoint(
                session_id=f"demo-history-{player_id}-{sport}-{index + 1}",
                session_date=date.today() - timedelta(days=(games - index) * 9),
                group_name=f"{sport.replace('_', ' ').title()} rally {index + 1}",
                game_rating=round(max(1.0, min(10.0, current + (0.18 if index % 2 == 0 else -0.09))), 2),
                rating=current,
                delta=round(current - previous, 2),
            ))
            previous = current
        history[sport] = points
    return history


def make_player(player_id: str, name: str, area: str, ratings: dict[str, float], style: str, reliability: float, history_games: int = 4, age: int | None = None, gender: str | None = None) -> Player:
    return Player(
        id=player_id,
        display_name=name,
        profile_image_url=None,
        area=area,
        age=age,
        gender=gender,
        latitude=COORDINATES[area][0],
        longitude=COORDINATES[area][1],
        travel_radius_km=12,
        sport_ratings=ratings,
        rating_sources={sport: "synthetic" for sport in ratings},
        primary_sport=next(iter(ratings), None),
        self_assessed_levels={sport: round(cmr_from_legacy_rating(rating)) for sport, rating in ratings.items()},
        cmr_ratings={sport: cmr_from_legacy_rating(rating) for sport, rating in ratings.items()},
        cmr_starting_ratings={sport: cmr_from_legacy_rating(rating) for sport, rating in ratings.items()},
        cmr_game_counts={sport: history_games for sport in ratings},
        cmr_history=make_history(player_id, ratings, history_games),
        cmr_scale=10,
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
        venue_name=VENUES[area],
        session_date=session_date,
        start_time=start,
        end_time=end,
        skill_min=cmr_from_legacy_rating(minimum),
        skill_max=cmr_from_legacy_rating(maximum),
        skill_scale=10,
        style=style,
        capacity=8,
        confirmed_player_ids=confirmed,
        waitlist_player_ids=waitlist or [],
        external_booking_url="https://playo.co/",
        status=status,
        social_activity_published=status == "completed",
    )


def delete_synthetic_social_collection(repository: FirestoreRepository, collection_name: str, batch_size: int = 250) -> int:
    """Reset showcase feed records without deleting posts made by real users."""
    documents = list(repository.client.collection(collection_name).stream())
    candidates = [document for document in documents if "demo-" in document.id]
    deleted = 0
    for offset in range(0, len(candidates), batch_size):
        batch_documents = candidates[offset:offset + batch_size]
        batch = repository.client.batch()
        for document in batch_documents:
            batch.delete(document.reference)
        batch.commit()
        deleted += len(batch_documents)
    return deleted


SYNTHETIC_COLLECTIONS = (
    "players", "sessions", "join_requests", "chat_posts", "feedback", "notifications",
    "follows",
    "community_memberships",
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


def seed_activity_history(repository: Repository, players: list[Player], sessions: list[Session]) -> None:
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
                game_rating=round(max(1.0, min(10.0, current + delta * 0.09)), 2),
                rating=current,
                delta=round(delta * 0.09, 2),
            ))
            updated_history = dict(player.cmr_history)
            updated_history[session.sport] = history
            players_by_id[player_id] = player.model_copy(update={"cmr_history": updated_history})
    for index, player in enumerate(players):
        players[index] = players_by_id[player.id]
        repository.save_player(players[index])


def seed_social_content(repository: Repository, players: list[Player], sessions: list[Session], rhea_id: str, now: datetime) -> tuple[int, int]:
    """Create activity engagement plus personal posts visible in Explore."""
    players_by_id = {player.id: player for player in players}
    completed_sessions = [session for session in sessions if session.status == "completed" and session.social_activity_published]
    engagement_specs = {
        "demo-pb-completed": ([rhea_id, "demo-kavya", "demo-rohit"], 2, [("demo-kavya", "That final rally was a great one."), ("demo-rohit", "Good rotation and a really balanced group.")]),
        "demo-tennis-completed": (["demo-neil", rhea_id, "demo-vikram"], 1, [(rhea_id, "The doubles format worked really well.")]),
        "demo-badminton-completed": (["demo-rohit", "demo-isha", "demo-dev"], 3, [("demo-isha", "Fast games and smooth partner changes."), ("demo-dev", "Would happily play this format again.")]),
        "demo-padel-completed": (["demo-meera", "demo-isha", "demo-kabir"], 1, [("demo-kabir", "The lobs were getting serious by the last game.")]),
    }
    captions = {
        "demo-pb-completed": "Sunrise pickleball, long rallies, and one very close final game. Same time next week?",
        "demo-tennis-completed": "Doubles under the lights. The partner rotations made this one especially fun.",
        "demo-badminton-completed": "Four courts, quick rotations, and no one wanted the last game to end.",
        "demo-padel-completed": "Still thinking about the rally that somehow came back off the glass.",
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
            caption=captions.get(session.id, f"A good {session.sport.replace('_', ' ')} session with this crew."),
            liked_by=[item for item in liked_by if item in players_by_id],
            comment_count=0,
            share_count=share_count,
            created_at=created_at,
        ))
        post_count += 1

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

    personal_posts = [
        ("demo-kavya", "demo-pb-completed", "Close games, kind people, and exactly the Sunday reset I needed.", 5, [rhea_id, "demo-rohit", "demo-sana"], 2, [("demo-sana", "That last rally was ridiculous."), (rhea_id, "Same crew next Sunday!")]),
        ("demo-rohit", "demo-badminton-completed", "The partner rotations were spot on tonight. Four courts and almost no waiting.", 11, ["demo-sana", "demo-isha", "demo-dev", rhea_id], 1, [("demo-dev", "Loved the quick games format."), ("demo-isha", "Booking this slot again.")]),
        ("demo-meera", "demo-padel-completed", "Finally getting comfortable using the back glass instead of fighting it.", 19, ["demo-kabir", "demo-isha", "demo-vikram"], 3, [("demo-kabir", "Your defence in game three was excellent.")]),
        ("demo-neil", "demo-tennis-completed", "Two hours of doubles and every set went close. Could not ask for a better evening.", 27, [rhea_id, "demo-vikram", "demo-meera"], 1, [("demo-vikram", "The deciding tiebreak made it.")]),
        ("demo-isha", "demo-badminton-completed", "Worked on staying patient in longer rallies today. Small improvement, big difference.", 36, ["demo-rohit", "demo-dev", "demo-player-15"], 0, [("demo-rohit", "It showed. Much harder to open up the court against you.")]),
        ("demo-vikram", "demo-tennis-completed-3", "Good intensity without taking the fun out of it. This is why I keep showing up.", 49, ["demo-meera", "demo-arjun", "demo-neil"], 2, [("demo-arjun", "Rematch soon.")]),
        ("demo-sana", "demo-pb-completed", "First time trying the soft game properly. Still learning, but the group made it easy.", 62, ["demo-kavya", rhea_id, "demo-pooja"], 1, [("demo-kavya", "Your resets got better every game!")]),
        ("demo-kabir", "demo-padel-completed", "Morning padel done. The coffee after was as important as the score.", 78, ["demo-meera", "demo-vikram", "demo-isha"], 2, [("demo-meera", "Court first, coffee always.")]),
    ]
    sessions_by_id = {session.id: session for session in sessions}
    for index, (player_id, session_id, caption, hours_ago, liked_by, share_count, comments) in enumerate(personal_posts, start=1):
        player = players_by_id[player_id]
        session = sessions_by_id[session_id]
        post_id = f"demo-post-{index:02d}"
        created_at = now - timedelta(hours=hours_ago)
        repository.save_social_post(SocialPost(
            id=post_id,
            player_id=player.id,
            player_display_name=player.display_name,
            profile_image_url=None,
            sport=session.sport,
            session_id=session.id,
            caption=caption,
            liked_by=[liker_id for liker_id in liked_by if liker_id in players_by_id],
            comment_count=0,
            share_count=share_count,
            created_at=created_at,
        ))
        post_count += 1
        for comment_index, (commenter_id, message) in enumerate(comments, start=1):
            commenter = players_by_id[commenter_id]
            repository.save_social_comment(SocialComment(
                id=f"{post_id}-comment-{comment_index}",
                post_id=post_id,
                player_id=commenter.id,
                player_display_name=commenter.display_name,
                profile_image_url=None,
                message=message,
                created_at=created_at + timedelta(minutes=comment_index * 7),
            ))
            comment_count += 1

    return post_count, comment_count


def seed_additional_sessions(repository: Repository, players: list[Player], today: date) -> list[Session]:
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
    seeded: list[Session] = []
    for area_index, area in enumerate(areas):
        # One curated game per locality keeps discovery broad while preserving
        # headroom for genuine games under the production session-read ceiling.
        for template_offset in range(1):
            sport_index = (area_index + template_offset) % len(session_templates)
            sport, format_name, start_hour, end_hour, minimum, maximum, style = session_templates[sport_index]
            date_offset = 1 + ((area_index * 3 + sport_index * 2) % 20)
            slug = re.sub(r"[^a-z0-9]+", "-", area.lower()).strip("-")
            session_id = f"demo-generated-{slug}-{sport}"
            eligible_players = [player for player in players if sport in player.cmr_ratings]
            organizer = eligible_players[(area_index + sport_index) % len(eligible_players)]
            confirmed = [organizer.id]
            for step in range(1, 4):
                member = eligible_players[(area_index + sport_index + step) % len(eligible_players)]
                if member.id not in confirmed:
                    confirmed.append(member.id)
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
            )
            repository.save_session(session)
            seeded.append(session)
    return seeded


def make_leaderboard_sessions(players: list[Player], today: date) -> list[Session]:
    """Create one completed circle per sport without exceeding read limits."""
    areas = ["Whitefield", "Brookefield", "Varthur", "Indiranagar", "Koramangala", "HSR Layout"]
    sports = ["tennis", "padel", "pickleball", "badminton", "squash", "table_tennis"]
    sessions: list[Session] = []
    for sport_index, (area, sport) in enumerate(zip(areas, sports)):
        eligible = [player for player in players if sport in player.cmr_ratings and player.area == area]
        eligible += [player for player in players if sport in player.cmr_ratings and player not in eligible]
        if len(eligible) < 4:
            continue
        confirmed = [eligible[offset].id for offset in range(4)]
        slug = re.sub(r"[^a-z0-9]+", "-", area.lower()).strip("-")
        sessions.append(make_session(
            f"demo-leaderboard-{slug}-{sport}",
            f"{area} {sport.replace('_', ' ').title()} Circle",
            confirmed[0], sport, area,
            today - timedelta(days=8 + sport_index * 3),
            time(7 + (sport_index % 3) * 5), time(9 + (sport_index % 3) * 5),
            2.5 + (sport_index % 3) * 0.2, 4.2 + (sport_index % 2) * 0.3,
            "social" if sport_index % 2 else "casual", confirmed, status="completed",
        ))
    return sessions


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


def validate_showcase_data(repository: Repository, rhea_id: str) -> dict[str, int]:
    """Fail fast when seeded records would produce a broken product journey."""
    players = [player for player in repository.list_players() if player.id.startswith("demo-") or player.id == rhea_id]
    player_ids = {player.id for player in players}
    sessions = [session for session in repository.list_sessions() if session.id.startswith("demo-")]
    session_ids = {session.id for session in sessions}
    requests = [request for session in sessions for request in repository.list_join_requests(session.id)]
    feedback = repository.list_feedback()
    social_posts = [post for post in repository.list_social_posts() if "demo-" in post.id]
    errors: list[str] = []

    if not players or not sessions:
        errors.append("players and sessions must be present")
    if any(player.profile_image_url for player in players):
        errors.append("synthetic profiles must use native initials")
    if any(player.display_name.casefold().startswith("demo") for player in players):
        errors.append("synthetic labels must not be visible in player names")
    for session in sessions:
        participant_ids = set(session.confirmed_player_ids) | set(session.waitlist_player_ids)
        if session.organizer_id not in player_ids or not participant_ids <= player_ids:
            errors.append(f"{session.id} contains an unknown player")
        if session.venue_name and "demo" in session.venue_name.casefold():
            errors.append(f"{session.id} contains a synthetic-looking venue")
        if session.open_slots and session.waitlist_player_ids:
            errors.append(f"{session.id} has a waitlist despite open slots")
    sessions_by_id = {session.id: session for session in sessions}
    for request in requests:
        session = sessions_by_id[request.session_id]
        if request.player_id not in player_ids:
            errors.append(f"{request.id} references an unknown player")
        if request.status == "approved" and request.player_id not in session.confirmed_player_ids:
            errors.append(f"{request.id} is approved but absent from the lineup")
        if request.status == "waitlisted" and request.player_id not in session.waitlist_player_ids:
            errors.append(f"{request.id} is waitlisted but absent from the waitlist")
        if request.status in {"pending", "declined"} and request.player_id in session.confirmed_player_ids:
            errors.append(f"{request.id} has an inconsistent lineup state")
    for item in feedback:
        if item.session_id not in session_ids:
            continue
        session = sessions_by_id[item.session_id]
        if item.player_id not in session.confirmed_player_ids:
            errors.append(f"feedback for {item.session_id} has a non-member reviewer")
        if any(rating.player_id not in session.confirmed_player_ids for rating in item.ratings):
            errors.append(f"feedback for {item.session_id} rates a non-member")
    visible_personal_posts = [post for post in social_posts if post.id.startswith("demo-post-")]
    if len(visible_personal_posts) < 6:
        errors.append("Explore needs at least six personal posts")
    if any(post.profile_image_url for post in social_posts):
        errors.append("synthetic posts must use native initials")
    sports = {"pickleball", "badminton", "tennis", "padel", "squash", "table_tennis"}
    upcoming_sports = {session.sport for session in sessions if session.status in {"open", "full"} and session.visibility == "public"}
    completed_sports = {session.sport for session in sessions if session.status == "completed"}
    if upcoming_sports != sports:
        errors.append(f"upcoming discovery is missing: {sorted(sports - upcoming_sports)}")
    if completed_sports != sports:
        errors.append(f"completed history is missing: {sorted(sports - completed_sports)}")
    if errors:
        raise RuntimeError("Invalid showcase data: " + "; ".join(errors))
    return {
        "players": len(players),
        "sessions": len(sessions),
        "requests": len(requests),
        "social_posts": len(visible_personal_posts),
    }


def seed(replace_social: bool = False, social_only: bool = False, reset_synthetic: bool = False, store: Repository | None = None) -> dict[str, int]:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    rhea_id = os.getenv("COURTMATE_DEMO_RHEA_UID", "demo-rhea-adhikari").strip() or "demo-rhea-adhikari"
    repository = store or FirestoreRepository(project=project)
    if (replace_social or reset_synthetic) and not isinstance(repository, FirestoreRepository):
        raise ValueError("Reset options require Firestore")
    today = date.today()
    now = datetime.now(timezone.utc)
    deleted_synthetic: dict[str, int] = {}
    if reset_synthetic:
        deleted_synthetic = delete_synthetic_data(repository, rhea_id)
    deleted_social_posts = 0
    deleted_social_comments = 0
    if replace_social:
        deleted_social_comments = delete_synthetic_social_collection(repository, "social_comments")
        deleted_social_posts = delete_synthetic_social_collection(repository, "social_posts")

    players = [
        make_player(rhea_id, "Rhea Adhikari", "Whitefield", {"pickleball": 3.9, "tennis": 4.3, "badminton": 3.6, "padel": 3.2}, "casual", 0.95, history_games=8, age=29, gender="woman"),
        make_player("demo-organizer-wf", "Ananya Rao", "Whitefield", {"pickleball": 3.4, "tennis": 3.8}, "casual", 0.96, age=31, gender="woman"),
        make_player("demo-kavya", "Kavya Menon", "Whitefield", {"pickleball": 3.2, "tennis": 3.5}, "casual", 0.91, age=27, gender="woman"),
        make_player("demo-rohit", "Rohit Kulkarni", "Brookefield", {"pickleball": 3.5, "badminton": 4.1}, "social", 0.88, age=34, gender="man"),
        make_player("demo-meera", "Meera Shah", "Varthur", {"pickleball": 3.8, "tennis": 4.2}, "competitive", 0.94, age=30, gender="woman"),
        make_player("demo-sana", "Sana Mirza", "Whitefield", {"pickleball": 2.9, "badminton": 3.6}, "social", 0.86, age=24, gender="woman"),
        make_player("demo-vikram", "Vikram Bhat", "Marathahalli", {"pickleball": 4.4, "tennis": 4.6}, "competitive", 0.90, age=38, gender="man"),
        make_player("demo-pooja", "Pooja Nair", "Whitefield", {"pickleball": 2.5, "badminton": 2.8}, "casual", 0.82, age=42, gender="woman"),
        make_player("demo-neil", "Neil D'Souza", "Brookefield", {"tennis": 3.2, "padel": 3.0}, "social", 0.84, age=46, gender="man"),
        make_player("demo-isha", "Isha Kapoor", "HSR Layout", {"badminton": 3.8, "padel": 3.6, "squash": 3.5, "table_tennis": 3.3}, "casual", 0.89, age=28, gender="woman"),
        make_player("demo-arjun", "Arjun Iyer", "Koramangala", {"tennis": 4.1, "squash": 4.2, "table_tennis": 3.9}, "competitive", 0.92, age=32, gender="man"),
        make_player("demo-nisha", "Nisha Reddy", "Sarjapur", {"pickleball": 3.1, "badminton": 3.2, "tennis": 3.4, "table_tennis": 2.9}, "social", 0.87, age=26, gender="woman"),
        make_player("demo-kabir", "Kabir Anand", "Bellandur", {"pickleball": 4.0, "padel": 4.2, "tennis": 4.4}, "competitive", 0.93, age=35, gender="man"),
        make_player("demo-tara", "Tara Bose", "Indiranagar", {"badminton": 2.7, "tennis": 3.0, "squash": 2.8}, "casual", 0.81, age=30, gender="woman"),
        make_player("demo-dev", "Dev Malhotra", "Kadubeesanahalli", {"pickleball": 3.7, "badminton": 4.0, "padel": 3.8, "table_tennis": 4.1}, "social", 0.90, age=37, gender="man"),
    ]
    extra_specs = [
        ("Aarav Krishnan", "Whitefield", {"tennis": 3.6, "padel": 3.4}), ("Diya Sen", "Whitefield", {"tennis": 3.9, "badminton": 3.5}),
        ("Mihir Joshi", "Whitefield", {"tennis": 4.2, "squash": 3.8}), ("Anika Shetty", "Brookefield", {"pickleball": 3.4, "padel": 3.1}),
        ("Rohan Gupta", "Brookefield", {"pickleball": 3.0, "badminton": 3.7}), ("Leena Thomas", "Brookefield", {"badminton": 3.2, "table_tennis": 3.5}),
        ("Aditi Prasad", "Varthur", {"pickleball": 3.7, "padel": 3.5}), ("Karan Mehta", "Varthur", {"pickleball": 4.1, "tennis": 3.9}),
        ("Nandini Rao", "Marathahalli", {"tennis": 3.3, "badminton": 3.8}), ("Yash Khanna", "Marathahalli", {"padel": 3.9, "squash": 4.0}),
        ("Ira Banerjee", "Indiranagar", {"badminton": 3.4, "squash": 3.1}), ("Manav Suri", "Indiranagar", {"tennis": 4.0, "table_tennis": 3.8}),
        ("Riya Patel", "Koramangala", {"tennis": 3.7, "squash": 3.6}), ("Adil Khan", "Koramangala", {"padel": 4.1, "table_tennis": 4.0}),
        ("Sia Narang", "HSR Layout", {"badminton": 3.9, "padel": 3.7}), ("Om Deshpande", "HSR Layout", {"squash": 4.2, "table_tennis": 3.4}),
        ("Veda Pai", "Bellandur", {"pickleball": 3.6, "padel": 4.0}), ("Samir Jain", "Bellandur", {"tennis": 4.3, "badminton": 3.9}),
        ("Kiara Mathew", "Sarjapur", {"tennis": 3.2}), ("Nikhil Gowda", "Kadubeesanahalli", {"pickleball": 3.8, "badminton": 4.1}),
    ]
    for index, (name, area, ratings) in enumerate(extra_specs, start=1):
        players.append(make_player(f"demo-player-{index:02d}", name, area, ratings, "social" if index % 2 else "casual", .80 + (index % 16) / 100, history_games=3 + index % 4))
    for player in players:
        repository.save_player(player)
    players_by_id = {player.id: player for player in players}

    follows = [
        FollowRecord(id=f"{rhea_id}_demo-kavya", follower_id=rhea_id, following_id="demo-kavya", created_at=now - timedelta(days=9)),
        FollowRecord(id=f"demo-kavya_{rhea_id}", follower_id="demo-kavya", following_id=rhea_id, created_at=now - timedelta(days=8)),
        FollowRecord(id=f"{rhea_id}_demo-rohit", follower_id=rhea_id, following_id="demo-rohit", created_at=now - timedelta(days=7)),
        FollowRecord(id=f"demo-meera_{rhea_id}", follower_id="demo-meera", following_id=rhea_id, created_at=now - timedelta(days=6)),
        FollowRecord(id=f"{rhea_id}_demo-meera", follower_id=rhea_id, following_id="demo-meera", created_at=now - timedelta(days=5)),
        FollowRecord(id=f"{rhea_id}_demo-sana", follower_id=rhea_id, following_id="demo-sana", created_at=now - timedelta(days=4)),
        FollowRecord(id=f"demo-vikram_{rhea_id}", follower_id="demo-vikram", following_id=rhea_id, created_at=now - timedelta(days=3)),
        FollowRecord(id="demo-rohit_demo-sana", follower_id="demo-rohit", following_id="demo-sana", created_at=now - timedelta(days=6)),
        FollowRecord(id="demo-meera_demo-vikram", follower_id="demo-meera", following_id="demo-vikram", created_at=now - timedelta(days=4)),
        FollowRecord(id="demo-kavya_demo-meera", follower_id="demo-kavya", following_id="demo-meera", created_at=now - timedelta(days=3)),
        FollowRecord(id="demo-sana_demo-kavya", follower_id="demo-sana", following_id="demo-kavya", created_at=now - timedelta(days=2)),
        FollowRecord(id="demo-neil_demo-vikram", follower_id="demo-neil", following_id="demo-vikram", created_at=now - timedelta(days=2)),
        FollowRecord(id="demo-isha_demo-dev", follower_id="demo-isha", following_id="demo-dev", created_at=now - timedelta(days=1)),
        FollowRecord(id="demo-dev_demo-isha", follower_id="demo-dev", following_id="demo-isha", created_at=now - timedelta(days=1)),
    ]
    for follow in follows:
        repository.save_follow(follow)

    sessions = [
        make_session("demo-pb-sat-evening", "Whitefield Sunset Pickleball", rhea_id, "pickleball", "Whitefield", today + timedelta(days=1), time(18), time(20), 3.0, 4.1, "casual", [rhea_id, "demo-kavya", "demo-sana"]),
        make_session("demo-pb-sun-morning", "Brookefield Sunday Social", "demo-rohit", "pickleball", "Brookefield", today + timedelta(days=2), time(8), time(10), 3.0, 3.7, "social", ["demo-rohit", "demo-meera", "demo-sana", "demo-pooja", "demo-kavya"]),
        make_session("demo-pb-sun-competitive", "East Bengaluru Pickleball Ladder", "demo-meera", "pickleball", "Varthur", today + timedelta(days=3), time(7), time(9), 3.6, 4.8, "competitive", ["demo-meera", "demo-vikram", rhea_id]),
        make_session("demo-pb-full", "Whitefield Full Court Social", rhea_id, "pickleball", "Whitefield", today + timedelta(days=4), time(19), time(21), 2.8, 4.1, "social", [rhea_id, "demo-kavya", "demo-rohit", "demo-meera", "demo-sana", "demo-pooja", "demo-arjun", "demo-vikram"], ["demo-isha"], status="full"),
        make_session("demo-tennis-evening", "Whitefield Evening Doubles", "demo-neil", "tennis", "Whitefield", today + timedelta(days=2), time(19), time(21), 3.0, 4.6, "casual", ["demo-neil", rhea_id, "demo-vikram"]),
        make_session("demo-badminton-evening", "Brookefield Badminton Mix", "demo-rohit", "badminton", "Brookefield", today + timedelta(days=3), time(20), time(22), 2.8, 4.2, "social", ["demo-rohit", "demo-sana", "demo-pooja"]),
        make_session("demo-padel-sunday", "Varthur Weekend Padel", "demo-vikram", "padel", "Varthur", today + timedelta(days=5), time(9), time(11), 3.0, 4.5, "competitive", ["demo-vikram", "demo-meera"]),
        make_session("demo-pb-completed", "Sunday Sunrise Pickleball", rhea_id, "pickleball", "Whitefield", today - timedelta(days=7), time(8), time(10), 3.0, 4.1, "casual", [rhea_id, "demo-kavya", "demo-rohit", "demo-sana"], status="completed"),
        make_session("demo-tennis-completed", "Whitefield Night Doubles", "demo-neil", "tennis", "Whitefield", today - timedelta(days=5), time(19), time(21), 3.0, 4.6, "casual", ["demo-neil", rhea_id, "demo-vikram", "demo-meera"], status="completed"),
        make_session("demo-tennis-completed-2", "Whitefield Tennis Social", rhea_id, "tennis", "Whitefield", today - timedelta(days=12), time(7), time(9), 3.0, 4.5, "social", [rhea_id, "demo-neil", "demo-arjun", "demo-tara"], status="completed"),
        make_session("demo-tennis-completed-3", "Whitefield Tennis Rally", "demo-meera", "tennis", "Whitefield", today - timedelta(days=19), time(18), time(20), 3.2, 4.8, "competitive", ["demo-meera", rhea_id, "demo-vikram", "demo-arjun"], status="completed"),
        make_session("demo-badminton-completed", "Brookefield Shuttle Night", "demo-rohit", "badminton", "Brookefield", today - timedelta(days=3), time(20), time(22), 2.8, 4.2, "social", ["demo-rohit", "demo-sana", "demo-isha", "demo-dev"], status="completed"),
        make_session("demo-padel-completed", "Varthur Padel Morning", "demo-vikram", "padel", "Varthur", today - timedelta(days=1), time(9), time(11), 3.0, 4.5, "competitive", ["demo-vikram", "demo-meera", "demo-isha", "demo-kabir"], status="completed"),
        make_session("demo-badminton-awaiting-feedback", "Whitefield Badminton Evening", rhea_id, "badminton", "Whitefield", today - timedelta(days=1), time(18), time(20), 2.8, 4.2, "social", [rhea_id, "demo-sana", "demo-isha", "demo-dev"], status="awaiting_feedback"),
        make_session("demo-tennis-awaiting-feedback", "Whitefield Tuesday Tennis", rhea_id, "tennis", "Whitefield", today - timedelta(days=2), time(19), time(21), 3.0, 4.6, "casual", [rhea_id, "demo-neil"], status="awaiting_feedback"),
    ]
    private_session = make_session("demo-private-apartment-game", "Apartment Friends Only", rhea_id, "tennis", "Whitefield", today + timedelta(days=2), time(20), time(22), 3.0, 4.5, "social", [rhea_id, "demo-neil"])
    sessions.append(private_session.model_copy(update={"visibility": "private"}))
    sessions.extend(make_leaderboard_sessions(players, today))
    for session in sessions:
        repository.save_session(session)
    for player in players:
        for sport in player.cmr_ratings:
            membership_id = f"demo-membership-{sport}-{player.area.lower().replace(' ', '-')}-{player.id}"
            repository.save_community_membership(CommunityMembership(
                id=membership_id,
                community_id=f"community:{sport}:{player.area.lower().replace(' ', '-')}",
                player_id=player.id,
                sport=sport,
                area=player.area,
                joined_at=now - timedelta(days=(len(player.id) + len(sport)) % 28),
            ))
    generated_sessions = seed_additional_sessions(repository, players, today)
    seed_activity_history(repository, players, sessions)
    social_post_count, social_comment_count = seed_social_content(repository, players, sessions, rhea_id, now)
    if social_only:
        replacement = f" Replaced {deleted_social_posts} social posts and {deleted_social_comments} social comments." if replace_social else ""
        reset_summary = f" Reset {sum(deleted_synthetic.values())} synthetic documents." if reset_synthetic else ""
        print(f"Seeded synthetic CourtMate social data into {project}: {len(players)} players, {len(sessions) + len(generated_sessions)} sessions, {social_post_count} session activity engagement records, {social_comment_count} social comments.{replacement}{reset_summary}")
        return {"players": len(players), "sessions": len(sessions) + len(generated_sessions), "social_posts": social_post_count}

    requests = [
        JoinRequest(id="demo-pb-sat-evening:demo-rohit", session_id="demo-pb-sat-evening", player_id="demo-rohit", player_display_name=players_by_id["demo-rohit"].display_name, status="pending", created_at=now - timedelta(hours=2)),
        JoinRequest(id="demo-pb-full:demo-isha:waitlist", session_id="demo-pb-full", player_id="demo-isha", player_display_name=players_by_id["demo-isha"].display_name, status="waitlisted", created_at=now - timedelta(hours=5)),
        JoinRequest(id="demo-pb-sun-morning:demo-kavya", session_id="demo-pb-sun-morning", player_id="demo-kavya", player_display_name=players_by_id["demo-kavya"].display_name, status="approved", created_at=now - timedelta(days=1)),
        JoinRequest(id="demo-tennis-evening:demo-meera", session_id="demo-tennis-evening", player_id="demo-meera", player_display_name=players_by_id["demo-meera"].display_name, status="pending", created_at=now - timedelta(hours=1)),
        JoinRequest(id=f"demo-pb-sun-competitive:{rhea_id}", session_id="demo-pb-sun-competitive", player_id=rhea_id, player_display_name="Rhea Adhikari", status="approved", created_at=now - timedelta(days=2)),
        JoinRequest(id=f"demo-badminton-evening:{rhea_id}", session_id="demo-badminton-evening", player_id=rhea_id, player_display_name="Rhea Adhikari", status="pending", created_at=now - timedelta(hours=7)),
        JoinRequest(id="demo-pb-full:demo-neil", session_id="demo-pb-full", player_id="demo-neil", player_display_name=players_by_id["demo-neil"].display_name, status="declined", created_at=now - timedelta(days=3)),
    ]
    for request in requests:
        repository.save_join_request(request)

    posts = [
        ChatPost(id="demo-chat-pb-sat-1", session_id="demo-pb-sat-evening", player_id=rhea_id, player_display_name="Rhea Adhikari", message="Court is pencilled in at 6 PM. Please confirm by lunch.", created_at=now - timedelta(hours=4)),
        ChatPost(id="demo-chat-pb-sat-2", session_id="demo-pb-sat-evening", player_id="demo-kavya", player_display_name=players_by_id["demo-kavya"].display_name, message="I can bring a spare set of balls.", created_at=now - timedelta(hours=3)),
        ChatPost(id="demo-chat-pb-sat-3", session_id="demo-pb-sat-evening", player_id="demo-sana", player_display_name=players_by_id["demo-sana"].display_name, message="6 PM works. I will reach ten minutes early.", created_at=now - timedelta(hours=2, minutes=30)),
        ChatPost(id="demo-chat-pb-sun-1", session_id="demo-pb-sun-morning", player_id="demo-rohit", player_display_name=players_by_id["demo-rohit"].display_name, message="Let us keep this social and rotate partners every game.", created_at=now - timedelta(days=1)),
        ChatPost(id="demo-chat-tennis-1", session_id="demo-tennis-evening", player_id="demo-neil", player_display_name=players_by_id["demo-neil"].display_name, message="Court 2 is booked. New balls are sorted.", created_at=now - timedelta(hours=5)),
        ChatPost(id="demo-chat-tennis-2", session_id="demo-tennis-evening", player_id="demo-vikram", player_display_name=players_by_id["demo-vikram"].display_name, message="Perfect. Happy to rotate partners after the first set.", created_at=now - timedelta(hours=4)),
        ChatPost(id="demo-chat-feedback-1", session_id="demo-badminton-awaiting-feedback", player_id=rhea_id, player_display_name="Rhea Adhikari", message="That was a fun session. Please add your private player ratings when you have a minute.", created_at=now - timedelta(hours=2)),
    ]
    for post in posts:
        repository.save_chat_post(post)

    feedback: list[Feedback] = []
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
        repository.save_feedback(item)

    notifications = [
        make_notification("demo-notification-rhea-match", rhea_id, "game_match", "A game fits your profile", "East Bengaluru Ladder has a competitive spot near your usual area.", "demo-pb-sun-competitive", now - timedelta(hours=1)),
        make_notification("demo-notification-rhea-follow", rhea_id, "follow", "Meera Shah followed you", "You have a new follower from the Varthur pickleball community.", "", now - timedelta(hours=3), actor_id="demo-meera"),
        make_notification("demo-notification-rhea-update", rhea_id, "request_update", "Your game request was approved", "You are confirmed for East Bengaluru Ladder.", "demo-pb-sun-competitive", now - timedelta(days=2), request_id=f"demo-pb-sun-competitive:{rhea_id}"),
        make_notification("demo-notification-rhea-pending", rhea_id, "request_update", "Your request is waiting", "The organizer is reviewing your Brookefield Badminton Mix request.", "demo-badminton-evening", now - timedelta(hours=7), request_id=f"demo-badminton-evening:{rhea_id}"),
        make_notification("demo-notification-rhea-feedback", rhea_id, "game_completed", "Rate your Whitefield Feedback Rally", "The game is ready for private player ratings. Finish when the group is ready.", "demo-badminton-awaiting-feedback", now - timedelta(hours=2), actor_id=rhea_id),
        make_notification("demo-notification-organizer-request", rhea_id, "join_request", "Rohit Kulkarni wants to join", "Review the request for Whitefield Sunset Pickleball.", "demo-pb-sat-evening", now - timedelta(hours=2), request_id="demo-pb-sat-evening:demo-rohit", actor_id="demo-rohit"),
    ]
    for notification in notifications:
        repository.save_notification(notification)

    summary = validate_showcase_data(repository, rhea_id)
    replacement = f" Replaced {deleted_social_posts} social posts and {deleted_social_comments} social comments." if replace_social else ""
    reset_summary = f" Reset {sum(deleted_synthetic.values())} synthetic documents." if reset_synthetic else ""
    print(f"Seeded synthetic CourtMate data into {project}: {len(players)} players, {len(sessions) + len(generated_sessions)} sessions, {len(requests)} requests, {len(posts)} chat posts, {social_post_count} session activity engagement records, {social_comment_count} social comments, {len(feedback)} feedback records, {len(follows)} follows, {len(notifications)} notifications.{replacement}{reset_summary}")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed synthetic CourtMate data.")
    parser.add_argument(
        "--replace-social",
        action="store_true",
        help="Delete only synthetic social posts and comments before rebuilding the showcase feed.",
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
