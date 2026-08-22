# CourtMate

CourtMate is the intelligent group layer for court-sport organizers. The MVP helps players discover skill-compatible sessions across pickleball, badminton, tennis, padel, squash, table tennis, basketball, and volleyball, while helping organizers replace dropouts without replacing WhatsApp or court-booking platforms.

## Backend MVP

The first implementation slice is a Python API with:

- Deterministic multi-sport session search by sport, area, time, normalized skill band, and play style
- Sport-specific player and replacement ranking, with DUPR retained as the pickleball compatibility alias
- Gemini search decision over a bounded Firestore session snapshot
- Explicit join requests and no-match group creation
- Automatic session close-out after the scheduled end time, with organizer completion override
- Unrated-player handling with explicit provenance
- Gemini intent parsing through `google-genai` when `GEMINI_API_KEY` is configured
- A deterministic local parser fallback for development and demos
- Firestore-backed players, sessions, and feedback, with an explicit in-memory fallback
- A free-tier deployment profile with bounded Firestore reads and scale-to-zero Cloud Run
- Feedback capture for fun, fairness, and repeat-play learning

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
python3 -m backend.seed_firestore --project mttn-portal
```

The API uses Firestore when `COURTMATE_DATASTORE=firestore`. Set `COURTMATE_DATASTORE=memory` for an offline local demo. With `GEMINI_API_KEY`, intent extraction and search explanation use the model in `GEMINI_MODEL` (default `gemini-3.6-flash`) through the server-side adapter. Gemini receives only a bounded session snapshot; Python remains the authority for sport, skill, date, area, time, and open-slot eligibility. If Gemini is unavailable, the API falls back to deterministic parsing and decisions so the demo remains usable.

For coordinate-aware locality matching, set `GOOGLE_MAPS_API_KEY` with the Google Maps Geocoding API enabled. The key stays server-side; the backend geocodes search localities and profile locality labels, while browser location permission can provide more precise coordinates. If the key is absent, seeded Bengaluru locality coordinates keep the demo usable offline.

## Google sign-in setup

Firebase Authentication Google sign-in is used for identity; the backend verifies the Firebase ID token before reading or writing player, group, or join-request data.

1. In the Firebase console, open project `mttn-portal`, add a Web app, and copy its Firebase configuration.
2. In Authentication, enable the Google provider and add `localhost` to the authorized domains.
3. Copy `.env.local.example` to `.env.local` and fill the `NEXT_PUBLIC_FIREBASE_*` values from the Web app configuration.
4. Keep `COURTMATE_AUTH_REQUIRED=true` in `.env`.
5. Install the updated dependencies and run both services:

```bash
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --port 8000

# another terminal
npm install
npm run dev
```

To test two people, sign in with Google using two separate browser profiles. One user creates a group; the other searches for it and requests to join. The creator can click `View requests` in the organizer panel and approve or decline the request. Confirmed members can open the group space to post and reload chat messages, submit post-game feedback, rate other players, and view group and locality leaderboards. The `My activity` panel shows `pending`, `approved`, or `declined` requests, upcoming approved games, and all groups created by the signed-in organizer. Approved games can be added to Google Calendar. The API also exposes `GET /v1/me`, `GET /v1/me/requests`, `GET /v1/me/games`, `GET /v1/me/groups`, `GET /v1/sessions/{session_id}/join-requests`, `GET/POST /v1/sessions/{session_id}/chat`, `POST /v1/sessions/{session_id}/feedback`, `GET /v1/sessions/{session_id}/leaderboard`, and `GET /v1/leaderboards/local` for the authenticated user.

After the scheduled end time, CourtMate marks the session `completed`, removes it from discovery and upcoming games, and makes chat read-only while preserving feedback and leaderboard access. Organizers can close a game immediately with `POST /v1/sessions/{session_id}/complete`.

## Test the Firestore flow

Run the seed command once after Firestore is enabled. It is safe to rerun and writes the same 14 demo players and 13 multi-sport sessions to the `players` and `sessions` collections.

Start the API and website in separate terminals:

```bash
# terminal 1
source .venv/bin/activate
python -m uvicorn backend.main:app --reload --port 8000

# terminal 2
npm run dev
```

Open `http://localhost:3000`, choose a sport, and search for `Find me a casual intermediate badminton game near Whitefield this evening`. The same flow works for every supported court sport; a successful API response will show the Firestore-backed group candidates.

To test the no-match branch, search for `Find an advanced competitive tennis game near Indiranagar this Sunday evening`. CourtMate will return a sport-specific group proposal instead of fake results. Click `Create this group`; the new session is written to Firestore. Existing results use `Request to join`, which writes a pending record to the `join_requests` collection.

Useful checks:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/v1/sessions/search \
  -H 'content-type: application/json' \
  -d '{"query":"Find a casual intermediate pickleball game near Whitefield this Sunday morning"}'
curl http://localhost:8000/v1/sessions/s1/replacement

curl -X POST http://localhost:8000/v1/sessions/s1/join \
  -H 'content-type: application/json' \
  -d '{"player_id":"p1"}'

curl -X POST http://localhost:8000/v1/groups \
  -H 'content-type: application/json' \
  -d '{"query":"Find an advanced competitive game near Indiranagar this Sunday evening","player_id":"p1"}'
```

## Example requests

```bash
curl http://localhost:8000/health

curl -X POST http://localhost:8000/v1/sessions/search \
  -H 'content-type: application/json' \
  -d '{"query":"Find a casual intermediate pickleball game near Whitefield this Sunday morning"}'

curl http://localhost:8000/v1/sessions/s1/replacement
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

## Free-tier Google Cloud setup

- Create a Google Cloud project and enable Firestore in Native mode.
- Enable the Firestore API and grant the Cloud Run service account Firestore User access.
- Deploy one Cloud Run service in `us-central1` with scale-to-zero and a maximum of one instance for the demo.
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

If the traceback shows `/opt/homebrew/anaconda3/site-packages`, Uvicorn was started outside the project environment. Activate `.venv` first or run it explicitly with `.venv/bin/python -m uvicorn`.
