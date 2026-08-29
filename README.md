# CourtMate

CourtMate is the intelligent group layer for racket-sport organizers. The MVP helps players discover skill-compatible sessions across pickleball, badminton, tennis, padel, squash, and table tennis, while helping organizers replace dropouts without replacing WhatsApp or court-booking platforms.

## Backend MVP

The first implementation slice is a Python API with:

- Deterministic multi-sport session search by sport, area, time, normalized skill band, and play style
- Sport-specific player and replacement ranking, with DUPR retained as the pickleball compatibility alias
- Gemini search decision over a bounded Firestore session snapshot
- Explicit join requests and no-match group creation
- Automatic session close-out after the scheduled end time, with organizer completion override
- Unrated-player handling with explicit provenance
- Gemini intent parsing through `google-genai` when `GEMINI_API_KEY` is configured
- A deterministic local parser fallback for development
- Firestore-backed players, sessions, and feedback, with an explicit in-memory fallback
- Persistent in-app game notifications for compatible nearby players after a game is created
- Public player profiles with sport CMR, reliability, follower counts, and follow/unfollow relationships
- CMR calculated and displayed on a 0-100 scale, with compatibility conversion for existing 1-8 skill bands
- A free-tier deployment profile with bounded Firestore reads and scale-to-zero Cloud Run
- Post-game feedback with fun/fairness signals, broad player skill levels, and optional team/score context
- Gemini vision analysis of optional watch-tracker screenshots, with extracted game stats saved as activity proof
- Tournament desk for racket-sport registration, round-robin fixtures, score confirmation, and live standings

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cp .env.local.example .env.local
python -m uvicorn backend.main:app --reload
```

Set `GOOGLE_CLOUD_PROJECT` and authenticate with Application Default Credentials before starting the API:

```bash
gcloud auth application-default login
```

The API uses Firestore when `COURTMATE_DATASTORE=firestore`. Set `COURTMATE_DATASTORE=memory` for an offline local run. With `GEMINI_API_KEY`, intent extraction and search explanation use the model in `GEMINI_MODEL` (default `gemini-3.6-flash`) through the server-side adapter. Gemini receives only a bounded session snapshot; Python remains the authority for sport, skill, date, area, time, and open-slot eligibility. If Gemini is unavailable, the API falls back to deterministic parsing and decisions.

The Tournament Desk is a racket-sport competition MVP. Open `Tournaments`, create a pickleball, badminton, tennis, padel, squash, or table-tennis event, register players, and generate a round-robin draw. A match player can submit a result and the opponent or organizer can confirm it; only confirmed results contribute to the live leaderboard. Tournament data is stored in `tournaments`, `tournament_registrations`, and `tournament_matches` in Firestore.

For coordinate-aware locality matching, set `GOOGLE_MAPS_API_KEY` with the Google Maps Geocoding API enabled. The key stays server-side; the backend geocodes search localities and profile locality labels, while browser location permission can provide more precise coordinates. If the key is absent, textual locality matching remains available.

## Google sign-in setup

Firebase Authentication Google sign-in is used for identity; the backend verifies the Firebase ID token before reading or writing player, group, or join-request data.

1. In the Firebase console, open project `mttn-portal`, add a Web app, and copy its Firebase configuration.
2. In Authentication, enable the Google provider and add `localhost` to the authorized domains.
3. In Storage, create the default bucket, then deploy the profile-image rules from the repository root:

```bash
firebase use mttn-portal
firebase deploy --only storage
```

4. Copy `.env.local.example` to `.env.local` and fill the `NEXT_PUBLIC_FIREBASE_*` values from the Web app configuration, including `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`.
5. Keep `COURTMATE_AUTH_REQUIRED=true` in `.env`.
6. Install the updated dependencies and run both services:

```bash
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --port 8000

# another terminal
npm install
npm run dev
```

To test two people, sign in with Google using two separate browser profiles. One user creates a group; compatible nearby players receive a persistent in-app alert in the notification bell, and can open it to return to matching games. The other player can search for the group and request to join. The creator can click `View requests` in the organizer panel and approve or decline the request. Confirmed members can open the group space to post and reload chat messages, submit post-game feedback using `Beginner`, `Intermediate`, or `Advanced` labels instead of numeric player ratings, optionally record who played on each team and the final score, and view group and locality leaderboards. Click any group member to open their public profile, see sport CMR and reliability, and follow or unfollow them. The `My activity` panel shows `pending`, `approved`, or `declined` requests, upcoming approved games, and all groups created by the signed-in organizer. Approved games can be added to Google Calendar. The notification API exposes `GET /v1/me/notifications` and `POST /v1/me/notifications/{notification_id}/read`; the frontend refreshes the inbox every 30 seconds. Native browser or mobile push can be added later with Firebase Cloud Messaging without changing the matching contract. Social APIs expose `GET /v1/players/{player_id}`, `POST /v1/players/{player_id}/follow`, `POST /v1/players/{player_id}/unfollow`, `GET /v1/me/following`, and `GET /v1/me/followers`. The API also exposes `GET /v1/me`, `GET /v1/me/requests`, `GET /v1/me/games`, `GET /v1/me/groups`, `GET /v1/sessions/{session_id}/join-requests`, `GET/POST /v1/sessions/{session_id}/chat`, `POST /v1/sessions/{session_id}/feedback`, `GET /v1/sessions/{session_id}/leaderboard`, and `GET /v1/leaderboards/local` for the authenticated user.

After the scheduled end time, CourtMate marks the session `completed`, removes it from discovery and upcoming games, and makes chat read-only while preserving feedback, tracker screenshots, and leaderboard access. Organizers can close a game immediately with `POST /v1/sessions/{session_id}/complete`. Confirmed players can attach a JPG, PNG, or WebP watch screenshot in the game check-in; Gemini extracts only clearly visible calories, duration, distance, steps, and heart rate values, and stores the structured proof in the `activity_proofs` Firestore collection.

## Test the Firestore flow

Firestore starts empty. Sign in, search for a game, and create the first group. Other signed-in users can then discover the group and request to join it.

To populate a realistic demo dataset, authenticate with Application Default Credentials and run the demo-only seed script:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
  python -m backend.seed_synthetic_firestore
```

The script upserts only `demo-` records in the CourtMate collections: players, sessions, join requests, chat posts, feedback, follows, notifications, tournaments, tournament registrations, and tournament matches. It does not touch Firebase Authentication or unrelated collections. To attach the Rhea Adhikari demo profile to your signed-in Firebase account, pass the Firebase Auth UID from that account:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
COURTMATE_DEMO_RHEA_UID=YOUR_FIREBASE_AUTH_UID \
  python -m backend.seed_synthetic_firestore
```

Without `COURTMATE_DEMO_RHEA_UID`, Rhea is created as the isolated `demo-rhea-adhikari` player. The seed includes multi-sport CMR history for Rhea, synthetic nearby players, notifications, and tournament fixtures so the Profile, Home, Games, group requests, leaderboard, social, and tournament flows are ready for a hackathon walkthrough. It is safe to rerun because the demo IDs are stable and writes are upserts.

Existing player documents created before the 0-100 CMR update are converted safely when read. To permanently rewrite those records in Firestore, run the one-time migration with Application Default Credentials:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
  python -m backend.migrate_cmr_to_100
```

Start the API and website in separate terminals:

```bash
# terminal 1
source .venv/bin/activate
python -m uvicorn backend.main:app --reload --port 8000

# terminal 2
npm run dev
```

Open `http://localhost:3000`, choose a sport, and describe the game you want. With no existing groups, CourtMate returns a group proposal. Click `Create this group`; the new session is written to Firestore. Existing results use `Request to join`, which writes a pending record to the `join_requests` collection.

Useful checks:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/v1/sessions/search \
  -H 'content-type: application/json' \
  -d '{"query":"Find a casual intermediate pickleball game near Whitefield this Sunday morning"}'

curl -X POST http://localhost:8000/v1/groups \
  -H 'content-type: application/json' \
  -d '{"query":"Find an advanced competitive game near Indiranagar this Sunday evening"}'
```

## Example requests

```bash
curl http://localhost:8000/health

curl -X POST http://localhost:8000/v1/sessions/search \
  -H 'content-type: application/json' \
  -d '{"query":"Find a casual intermediate pickleball game near Whitefield this Sunday morning"}'
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

## Free-tier Google Cloud setup

- Create a Google Cloud project and enable Firestore in Native mode.
- Enable the Firestore API and grant the Cloud Run service account Firestore User access.
- Deploy one Cloud Run service in `us-central1` with scale-to-zero and a maximum of one instance for the MVP.
- Keep Firestore reads bounded with `COURTMATE_MAX_SESSION_READS` and `COURTMATE_MAX_PLAYER_READS`.
- Use the Gemini API key server-side only; do not expose it in the frontend.
- Do not enable Pub/Sub, BigQuery, Cloud Storage, or other paid services for the MVP.

Example Cloud Run deployment profile:

```bash
gcloud run deploy courtmate-api \
  --source . \
  --region us-central1 \
  --min 0 \
  --max 1 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars COURTMATE_DATASTORE=firestore,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_MAPS_API_KEY=YOUR_MAPS_KEY,COURTMATE_MAX_SESSION_READS=100,COURTMATE_MAX_PLAYER_READS=500
```

The pasted Google Cloud free-tier limits are usage limits, not a spend cap. Set a billing budget alert in Cloud Billing and monitor Firestore reads/writes and Cloud Run requests.

Profile photos use Firebase Storage, backed by Google Cloud Storage. Images are uploaded to `profile-images/{firebase_uid}` from the signed-in browser, while the corresponding download URL is saved on the Firestore player document through `POST /v1/me/profile-image`. No service-account key is needed in the frontend or in Cloud Run. The MVP accepts JPG, PNG, and WebP images up to 5 MB.

If the traceback shows `/opt/homebrew/anaconda3/site-packages`, Uvicorn was started outside the project environment. Activate `.venv` first or run it explicitly with `.venv/bin/python -m uvicorn`.
