"""Firebase Authentication token verification for the API."""

import os
from dataclasses import dataclass

from fastapi import Header, HTTPException


@dataclass(frozen=True)
class AuthIdentity:
    uid: str
    email: str | None = None
    display_name: str | None = None


_firebase_app = None


def _is_required() -> bool:
    return os.getenv("COURTMATE_AUTH_REQUIRED", "true").lower() in {"1", "true", "yes"}


def _firebase_auth():
    global _firebase_app
    try:
        from firebase_admin import auth, get_app, initialize_app
    except ImportError as error:
        raise HTTPException(status_code=500, detail="Install firebase-admin to verify Firebase tokens") from error

    if _firebase_app is None:
        try:
            _firebase_app = get_app()
        except ValueError:
            project_id = os.getenv("GOOGLE_CLOUD_PROJECT")
            options = {"projectId": project_id} if project_id else None
            _firebase_app = initialize_app(options=options)
    return auth, _firebase_app


def get_current_identity(
    authorization: str | None = Header(default=None),
    dev_player_id: str | None = Header(default=None, alias="X-CourtMate-Player-ID"),
) -> AuthIdentity:
    if not authorization:
        if _is_required():
            raise HTTPException(status_code=401, detail="Sign in with Google to use CourtMate")
        return AuthIdentity(uid=dev_player_id or os.getenv("COURTMATE_DEV_PLAYER_ID", "local-dev-player"), display_name="Local developer")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Use a Firebase Bearer token")
    auth, app = _firebase_auth()
    try:
        decoded = auth.verify_id_token(token, app=app)
    except Exception as error:
        raise HTTPException(status_code=401, detail="Invalid or expired Firebase token") from error
    return AuthIdentity(uid=decoded["uid"], email=decoded.get("email"), display_name=decoded.get("name"))
