"""Seed the Firestore demo dataset used by the hackathon MVP."""

import argparse
import os

from dotenv import load_dotenv

from .repository import FirestoreRepository, seed_firestore


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Seed CourtMate demo data into Firestore")
    parser.add_argument("--project", default=os.getenv("GOOGLE_CLOUD_PROJECT"), help="Google Cloud project id")
    args = parser.parse_args()
    if not args.project:
        parser.error("set GOOGLE_CLOUD_PROJECT or pass --project PROJECT_ID")
    repository = FirestoreRepository(project=args.project)
    seed_firestore(repository)
    from .repository import DemoData

    print(f"Seeded {len(DemoData.seed_players())} players and {len(DemoData.seed_sessions())} sessions into Firestore")


if __name__ == "__main__":
    main()
