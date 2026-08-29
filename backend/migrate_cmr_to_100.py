"""Upgrade persisted CourtMate CMR values from 1-8 to 0-100."""

import os

from .models import Player, normalize_cmr_player
from .repository import FirestoreRepository


def migrate() -> None:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "mttn-portal")
    repository = FirestoreRepository(project=project)
    documents = repository.client.collection("players").limit(repository.max_player_reads).stream()
    converted = 0
    for document in documents:
        data = document.to_dict() or {}
        if data.get("cmr_scale") == 100:
            continue
        player = normalize_cmr_player(Player.model_validate({**data, "id": document.id}))
        repository.save_player(player)
        converted += 1
    print(f"Migrated {converted} player profile(s) to CMR 0-100 in {project}.")


if __name__ == "__main__":
    migrate()
