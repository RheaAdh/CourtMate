"""Compatibility entry point for the current 1.00-10.00 CMR migration."""

from .migrate_cmr_to_10 import migrate


if __name__ == "__main__":
    migrate()
