# CourtMate

CourtMate is the intelligent group layer for racket-sport organizers. The MVP helps players discover skill-compatible sessions across pickleball, badminton, tennis, padel, squash, and table tennis, while helping organizers replace dropouts without replacing their messaging or court-booking platforms.

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
- CMR calculated and displayed on the canonical 1-10 scale, with compatibility conversion for historic 1-8 and 0-100 ratings
- A free-tier deployment profile with bounded Firestore reads and scale-to-zero Cloud Run
- Post-game feedback with fun/fairness signals, broad player skill levels, and optional team/score context
- Gemini vision analysis of optional watch-tracker screenshots, with extracted game stats saved as activity proof
- Tournament desk for racket-sport registration, single-elimination draws, winner advancement, optional scores, and live standings

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

The API uses Firestore when `COURTMATE_DATASTORE=firestore`. Set `COURTMATE_DATASTORE=memory` for an offline local run. With `GEMINI_API_KEY`, intent extraction uses the model in `GEMINI_MODEL` (default `gemini-3.6-flash`) through the server-side adapter. Search summaries are deterministic by default so a search does not wait for a second Gemini generation call; set `COURTMATE_GROUNDED_RESPONSE_WITH_GEMINI=true` only if model-written prose is needed. Gemini receives only parsed intent and verified records; Python remains the authority for sport, skill, date, area, time, and open-slot eligibility. If Gemini or Vertex AI embeddings are unavailable, the API falls back to deterministic parsing, retrieval, and decisions.

### Grounded semantic search

Semantic search uses Firestore native vector search and Vertex AI `gemini-embedding-001`. Firestore remains authoritative: embeddings are only sanitized projections used to find candidate IDs, and the API re-reads and deterministically validates every result before returning it. The current frontend contract is unchanged. To enable it locally or on Cloud Run, set `COURTMATE_USE_VERTEX_AI=true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`, and `GOOGLE_GENAI_USE_VERTEXAI=true`. The Cloud Run service account needs Vertex AI User and Cloud Datastore User access.

Build or refresh the corpus after seeding data:

```bash
COURTMATE_DATASTORE=firestore \
GOOGLE_CLOUD_PROJECT=mttn-portal \
GOOGLE_CLOUD_LOCATION=global \
COURTMATE_USE_VERTEX_AI=true \
GOOGLE_GENAI_USE_VERTEXAI=true \
python -m backend.rebuild_vector_index
```

The command writes sanitized session, tournament, public-player, and CourtMate FAQ projections to `search_documents`. Create the vector index once (and include the project if it is not the active gcloud project):

```bash
gcloud firestore indexes composite create \
  --project=mttn-portal \
  --database='(default)' \
  --collection-group=search_documents \
  --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=source_type \
  --field-config=order=ASCENDING,field-path=visibility \
  --field-config=order=ASCENDING,field-path=sport \
  --field-config=order=ASCENDING,field-path=status \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
```

Search falls back to the existing deterministic matcher if Vertex AI, the vector index, or embeddings are unavailable. The index can take a few minutes to become ready.

The Tournament Desk is a racket-sport competition MVP. Open `Tournaments`, create a pickleball, badminton, tennis, padel, squash, or table-tennis event, register players, and generate a single-elimination draw. Byes advance automatically; match players or the organizer select who won from the bracket and the winner advances into the next round. Optional scores and per-set scores can still be recorded, and only completed results contribute to the live leaderboard. Tournament data is stored in `tournaments`, `tournament_registrations`, and `tournament_matches` in Firestore.

For coordinate-aware locality matching, set `GOOGLE_MAPS_API_KEY` with the Google Maps Geocoding API enabled. The key stays server-side; the backend geocodes search localities and profile locality labels, while browser location permission can provide more precise coordinates. If the key is absent, textual locality matching remains available.

### Google Maps on Vercel

The interactive Explore map uses the browser-only `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. Next.js embeds `NEXT_PUBLIC_*` values at build time, so setting only `GOOGLE_MAPS_API_KEY` on Cloud Run or adding the value after deployment will not enable the map in the web app.

1. In Vercel, add `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` to the Production environment (and Preview if preview deployments need maps).
2. In Google Cloud, enable **Maps JavaScript API** and billing for that key.
3. Restrict the browser key to `https://court-mate-blr.vercel.app/*` (plus any required preview or custom domains). Keep the server-side Geocoding key separate from the browser key when possible.
4. Redeploy Vercel after saving the variable. The key must be present in the generated browser bundle.

If the key is missing or rejected, CourtMate keeps the density illustration as a fallback and displays an "Interactive map unavailable" status while still listing nearby games below.

### Production checklist

Before releasing, configure the browser and API separately. Public `NEXT_PUBLIC_*` values are embedded into the Vercel build and must be safe to expose; server credentials belong only in Cloud Run or its secret manager.

1. In Vercel Production, set `NEXT_PUBLIC_API_URL` to the deployed API origin, the required `NEXT_PUBLIC_FIREBASE_*` web configuration, `NEXT_PUBLIC_APP_URL` to the public web URL, and the restricted `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. Redeploy after changing any `NEXT_PUBLIC_*` value.
2. In Cloud Run, set `COURTMATE_ALLOWED_ORIGINS` to the exact production web origin, plus any required preview origins. Configure `GOOGLE_CLOUD_PROJECT`, Firestore access, Firebase Admin credentials, and server-only keys such as `GEMINI_API_KEY` and `GOOGLE_MAPS_API_KEY` as secrets.
3. Verify `GET /health` on the API, sign in with Google on a real mobile browser, create and request a game, and confirm the Explore map loads with the production browser key.
4. Run `npm run lint`, `npm run typecheck`, `npm run build`, and `python -m pytest -q` before a production deploy.

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

### CourtMate-branded Google sign-in on Vercel

For the production app to use `court-mate-blr.vercel.app` as its Firebase `authDomain`, Vercel transparently proxies Firebase's reserved helper routes through `next.config.ts`. This keeps the sign-in flow on the CourtMate domain instead of displaying `mttn-portal.firebaseapp.com`.

1. In Vercel, set `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=court-mate-blr.vercel.app` for Production (and Preview if required), then redeploy.
2. In Firebase Authentication, add `court-mate-blr.vercel.app` to **Authorized domains**.
3. In Google Cloud OAuth, keep `https://court-mate-blr.vercel.app` under **Authorized JavaScript origins** and use `https://court-mate-blr.vercel.app/__/auth/handler` as the authorized redirect URI.
4. Set the OAuth consent-screen application name to `CourtMate`. Google may still show the verified hostname alongside the app name; using a custom domain such as `courtmate.in` is required if you want that hostname to omit `vercel.app` too.

To test two people, sign in with Google using two separate browser profiles. One user creates a group; compatible nearby players receive a persistent in-app alert in the notification bell, and can open it to return to matching games. The other player can search for the group and request to join. The creator can click `View requests` in the organizer panel and approve or decline the request. Confirmed members can open the group space to post and reload chat messages, submit post-game feedback using `Beginner`, `Intermediate`, or `Advanced` labels instead of numeric player ratings, optionally record who played on each team and the final score, and view group and locality leaderboards. Click any group member to open their public profile, see sport CMR and reliability, and follow or unfollow them. The `My activity` panel shows `pending`, `approved`, or `declined` requests, upcoming approved games, and all groups created by the signed-in organizer. Approved games can be added to Google Calendar. The notification API exposes `GET /v1/me/notifications` and `POST /v1/me/notifications/{notification_id}/read`; the frontend refreshes the inbox every 30 seconds. Native browser or mobile push can be added later with Firebase Cloud Messaging without changing the matching contract. Social APIs expose `GET /v1/players/{player_id}`, `POST /v1/players/{player_id}/follow`, `POST /v1/players/{player_id}/unfollow`, `GET /v1/me/following`, and `GET /v1/me/followers`. The API also exposes `GET /v1/me`, `GET /v1/me/requests`, `GET /v1/me/games`, `GET /v1/me/groups`, `GET /v1/sessions/{session_id}/join-requests`, `GET/POST /v1/sessions/{session_id}/chat`, `POST /v1/sessions/{session_id}/feedback`, `GET /v1/sessions/{session_id}/leaderboard`, and `GET /v1/leaderboards/local` for the authenticated user.

After the scheduled end time, CourtMate marks the session `completed`, removes it from discovery and upcoming games, and makes chat read-only while preserving feedback, tracker screenshots, and leaderboard access. Organizers can close a game immediately with `POST /v1/sessions/{session_id}/complete`. Confirmed players can attach a JPG, PNG, or WebP watch screenshot in the game check-in; Gemini extracts only clearly visible calories, duration, distance, steps, and heart rate values, and stores the structured proof in the `activity_proofs` Firestore collection.

## Test the Firestore flow

Firestore starts empty. Sign in, search for a game, and create the first group. Other signed-in users can then discover the group and request to join it.

To populate a realistic demo dataset, authenticate with Application Default Credentials and run the demo-only seed script:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
  python -m backend.seed_synthetic_firestore
```

The script upserts stable `demo-` records for players, sessions, join requests, chat, private feedback, follows, notifications, community memberships, and social posts. It does not touch Firebase Authentication or unrelated user records. Synthetic people have natural display names and no image URL, so CourtMate renders their initials instead of stock avatars.

To replace only synthetic Explore posts and comments while rebuilding the feed:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
  python -m backend.seed_synthetic_firestore --replace-social
```

`--replace-social` is intentionally opt-in and preserves posts and comments created by genuine users.

To fully refresh the demo state for the current product flows, delete only synthetic CourtMate records and reseed all screens in one command. This preserves unrelated player and application data:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
  python -m backend.seed_synthetic_firestore --reset-synthetic
```

The refreshed dataset includes 35 realistic Bengaluru players, 32 games across all six sports and ten localities, pending and waitlisted requests, two awaiting-feedback games, completed games, common chat, notifications, private feedback, connections, sport CMR histories, leaderboard depth, and eight authored Explore posts with comments, reactions, and shares. The session count intentionally leaves headroom below the production Firestore read cap so genuine and seeded games remain visible together. An integrity audit runs after every full seed and fails if roster/request states conflict, a synthetic avatar is present, Explore lacks personal posts, or a sport is missing from discovery and completed history.

For a faster social-only reset that skips unrelated requests, notifications, and tournament writes, add `--social-only` to the replacement command.

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
COURTMATE_DEMO_RHEA_UID=YOUR_FIREBASE_AUTH_UID \
  python -m backend.seed_synthetic_firestore
```

Without `COURTMATE_DEMO_RHEA_UID`, Rhea is created as the isolated `demo-rhea-adhikari` player. It is safe to rerun because synthetic IDs are stable and writes are upserts.

To add only a labelled synthetic CMR trajectory to an existing demo profile, without replacing its name, image, or preferences, run:

```bash
GOOGLE_CLOUD_PROJECT=mttn-portal \
  .venv/bin/python -m backend.seed_profile_trajectory \
  --player-id YOUR_FIREBASE_UID --sport badminton --games 8
```

This utility is for demo profiles only. It marks the rating source as `synthetic` and creates 3–12 representative historical points for the profile graph.

Existing player documents created on historic CMR scales are converted safely when read. To permanently rewrite those records in Firestore, run the one-time migration with Application Default Credentials:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=mttn-portal \
  python -m backend.migrate_cmr_to_10
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
- API responses include `X-Response-Time-Ms`; use it with Cloud Run logs to separate auth, Gemini, vector search, and Firestore latency.
- Read-only feed, search, and activity requests do not synchronously rebuild CMR ratings or re-index embeddings when a scheduled session changes status.
- Use the Gemini API key server-side only; do not expose it in the frontend.
- Keep Pub/Sub and BigQuery optional for the MVP; Cloud Storage is required only for profile pictures.

Example Cloud Run deployment profile:

```bash
gcloud run deploy courtmate-api \
  --source . \
  --region us-central1 \
  --min 0 \
  --max 1 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars COURTMATE_DATASTORE=firestore,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,COURTMATE_USE_VERTEX_AI=true,GOOGLE_GENAI_USE_VERTEXAI=true,COURTMATE_VECTOR_SEARCH_ENABLED=true,COURTMATE_VECTOR_DIMENSIONS=768,COURTMATE_PROFILE_BUCKET=profile-pictures,COURTMATE_SIGNING_SERVICE_ACCOUNT=YOUR_CLOUD_RUN_SERVICE_ACCOUNT,GOOGLE_MAPS_API_KEY=YOUR_MAPS_KEY,COURTMATE_MAX_SESSION_READS=100,COURTMATE_MAX_PLAYER_READS=500,COURTMATE_MAX_VECTOR_RESULTS=20
```

The pasted Google Cloud free-tier limits are usage limits, not a spend cap. Set a billing budget alert in Cloud Billing and monitor Firestore reads/writes and Cloud Run requests.

Profile photos upload through the authenticated API to Firebase Storage, which avoids browser Storage CORS and signed-URL setup; the API saves a tokenized download URL on the player. Profile files use `profiles/{firebase_uid}/...` and are limited to JPG, PNG, or WebP files under 5 MB. Game-post photos use `social-posts/{firebase_uid}/...` and are limited to 8 MB. Set `COURTMATE_PROFILE_BUCKET` when using a dedicated bucket, or the API falls back to `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` and then `{GOOGLE_CLOUD_PROJECT}.firebasestorage.app`. Deploy the included `storage.rules` before enabling browser-based Storage features in a deployed environment.

If the traceback shows `/opt/homebrew/anaconda3/site-packages`, Uvicorn was started outside the project environment. Activate `.venv` first or run it explicitly with `.venv/bin/python -m uvicorn`.
