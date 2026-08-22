"""CourtMate backend package."""

try:
    from dotenv import load_dotenv
except ImportError:  # Local smoke tests can run before dependencies are installed.
    load_dotenv = None

if load_dotenv:
    load_dotenv()
