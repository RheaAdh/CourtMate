"""Migrate CourtMate player and session ratings to the 1.00-10.00 CMR scale.

Only CourtMate's own ``players`` and ``sessions`` records are updated. Firebase
Authentication and raw external ratings such as DUPR are deliberately untouched.
The conversion is idempotent, so it can safely be re-run after interrupted work.
"""

import os

from .models import Player, Session, normalize_cmr_player, normalize_session
from .repository import FirestoreRepository


def migrate() -> None:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    repository = FirestoreRepository(project=project)
    converted_players = 0
    converted_sessions = 0

    for document in repository.client.collection("players").stream():
        data = document.to_dict() or {}
        if data.get("cmr_scale") == 10:
            continue
        player = normalize_cmr_player(Player.model_validate({**data, "id": document.id}))
        repository.save_player(player)
        converted_players += 1

    for document in repository.client.collection("sessions").stream():
        data = document.to_dict() or {}
        if data.get("skill_scale") == 10:
            continue
        for field in ("session_date", "start_time", "end_time"):
            value = data.get(field)
            if hasattr(value, "date"):
                data[field] = value.date().isoformat() if field == "session_date" else value.time().isoformat()
        session = normalize_session(Session.model_validate({**data, "id": document.id}))
        repository.save_session(session)
        converted_sessions += 1

    print(
        f"Migrated {converted_players} player profile(s) and {converted_sessions} session(s) "
        f"to CMR 1.00-10.00 in {project}."
    )


if __name__ == "__main__":
    migrate()
