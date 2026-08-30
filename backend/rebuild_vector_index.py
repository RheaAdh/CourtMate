"""Build the Firestore semantic-search corpus.

Usage:
    COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=... \
        COURTMATE_USE_VERTEX_AI=true python -m backend.rebuild_vector_index
"""

from .repository import create_repository
from .vector_search import VectorIndexer


def main() -> None:
    repository = create_repository()
    indexed = VectorIndexer(repository).rebuild()
    print(f"Indexed {indexed} CourtMate search documents")


if __name__ == "__main__":
    main()
