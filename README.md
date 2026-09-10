# CourtMate

**Find people to play racket sports with, organise a game, and track your progress.**

CourtMate helps players discover nearby games in pickleball, badminton, tennis,
padel, squash, and table tennis. A **Rally Circle** is a game's group space for
requests, scheduling, chat, and feedback. **CMR** means CourtMate Rating, a
sport-specific skill rating on a 1–10 scale.

## Demo

[Watch the CourtMate demo on Google Drive](https://drive.google.com/file/d/1AeZK6aqI5kf2KhtlqPSF2UzbttQXqYQC/view?usp=drive_link).

Start with the video for a visual overview, then follow the evaluation steps below
to try the application yourself.

[Read the CourtMate technical document](docs/CourtMate%20Tech%20Doc.pdf) (PDF).

## Start here

| What you want to evaluate | Follow this path | What you need |
| --- | --- | --- |
| Backend logic and automated tests | [Quick evaluation](#quick-evaluation-without-a-cloud-account) | Python, Git, and internet for dependency installation. No cloud account or API keys. |
| Complete website with two players | [Browser evaluation](#browser-evaluation-with-google-sign-in) | Node.js plus a configured Firebase project and Google sign-in. |
| Container packaging | [Docker check](#docker) | Docker running locally. |
| Cloud deployment or optional AI | [Advanced setup](#advanced-setup) | Google Cloud/Firebase access and feature-specific configuration. |

**Recommended evaluation order:** run the tests, complete the local API
walkthrough, then try the browser flow if Firebase access is available.
The local API starts with an empty, temporary database; the walkthrough creates
its own game. Restarting that server clears its data.

## Contents

- [Demo](#demo)
- [What the app does](#what-the-app-does)
- [Quick evaluation without a cloud account](#quick-evaluation-without-a-cloud-account)
- [Manual API walkthrough](#manual-api-walkthrough)
- [Browser evaluation with Google sign-in](#browser-evaluation-with-google-sign-in)
- [Evaluation checklist](#evaluation-checklist)
- [Troubleshooting](#troubleshooting)
- [Docker](#docker)
- [How the project works](#how-the-project-works)
- [Advanced setup](#advanced-setup)

## What the app does

| Feature | Example |
| --- | --- |
| Find games | Search for a casual pickleball game in Whitefield. |
| Organise a Rally Circle | Create a game, approve join requests, and coordinate a time. |
| Play together | Chat with confirmed players and track check-ins. |
| Review a game | Submit feedback and view ratings and reliability. |
| Connect with players | Follow people and browse profiles and social posts. |
| Explore the community | View nearby venues, games, and community activity. |
| Use optional AI features | Analyze wearable screenshots or discuss personal performance. |

Core matching works without Gemini. Google Maps, cloud persistence, image
storage, and AI features require their own configuration.

## Quick evaluation without a cloud account

Commands below use **Bash on macOS/Linux or WSL on Windows**. Run commands from
the repository root unless a step says otherwise. Use Python 3.12 to match the
Docker runtime; Node.js is only needed for browser evaluation.

### 1. Install the backend

Skip the clone command if you already have the repository open.

```bash
git clone https://github.com/RheaAdh/CourtMate.git
cd CourtMate

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Check `python --version` before creating the environment if several Python
versions are installed. Installation requires internet access; the following
core evaluation does not require cloud credentials.

### 2. Run the automated tests

```bash
python -m pytest -q
```

**Expected result:** pytest finishes with a passing summary and exit code 0.
Tests use synthetic records and in-memory storage; they do not need a running
server. The test count can change as the project develops.

To examine a particular area:

```bash
python -m pytest tests/test_api.py -v
python -m pytest tests/test_matching.py -v
python -m pytest -k feedback -v
```

| Suite | What it evaluates |
| --- | --- |
| `tests/test_api.py` | Game requests, lifecycle, feedback, profiles, maps, social activity, notifications, and upload handling. |
| `tests/test_matching.py` | Sport and skill matching, replacement ranking, rating conversion, and vector-search fallback. |
| `tests/fixtures.py` | Repeatable example records used by tests. |

There is no configured coverage-percentage gate or browser end-to-end test suite.

### 3. Start the local API

In **Terminal 1**, keep the following process running:

```bash
source .venv/bin/activate

COURTMATE_DATASTORE=memory \
COURTMATE_AUTH_REQUIRED=false \
COURTMATE_USE_VERTEX_AI=false \
GOOGLE_GENAI_USE_VERTEXAI=false \
COURTMATE_USE_GEMINI_INTENT=false \
COURTMATE_GROUNDED_RESPONSE_WITH_GEMINI=false \
COURTMATE_VECTOR_SEARCH_ENABLED=false \
GEMINI_API_KEY= GOOGLE_MAPS_API_KEY= \
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

**Expected result:** Uvicorn reports that it is running on
`http://127.0.0.1:8000`. These per-command settings override matching values in
an existing `.env`; there is no need to edit cloud configuration for this path.

This local-only mode uses the `X-CourtMate-Player-ID` header to simulate two
players. It does not test Firebase authentication. Do not use this mode for a
public deployment.

### 4. Check that it is ready

In **Terminal 2**, open the repository folder and activate the same environment:

```bash
source .venv/bin/activate
curl -fsS http://127.0.0.1:8000/health
```

**Expected response:**

```json
{"status":"ok","service":"courtmate-api","datastore":"InMemoryRepository"}
```

For a point-and-click API interface, open
[Swagger UI](http://127.0.0.1:8000/docs). Expand a route, choose **Try it out**,
enter its fields and development player header, then choose **Execute**.

## Manual API walkthrough

Keep Terminal 1 running. Run the following steps **in order in Terminal 2**.
They simulate an organizer (`eval-organizer`) and another player
(`eval-player`). No real Google accounts or API tokens are needed for this path.

### 1. Create a public game as the organizer

The date is calculated seven days ahead so the example does not expire.

```bash
EVAL_DATE=$(python -c 'from datetime import date, timedelta; print(date.today() + timedelta(days=7))')

SESSION_ID=$(curl -fsS http://127.0.0.1:8000/v1/groups \
  -H 'Content-Type: application/json' \
  -H 'X-CourtMate-Player-ID: eval-organizer' \
  -d "{\"query\":\"casual pickleball in Whitefield\",\"group_name\":\"Evaluation Rally\",\"sport\":\"pickleball\",\"area\":\"Whitefield\",\"session_date\":\"$EVAL_DATE\",\"start_time\":\"18:00:00\",\"end_time\":\"19:00:00\",\"skill_min\":1,\"skill_max\":10,\"capacity\":4,\"visibility\":\"public\"}" \
  | python -c 'import json, sys; print(json.load(sys.stdin)["session"]["id"])')

echo "Created game: $SESSION_ID"
```

**Expected result:** a game ID starting with `g-`. The organizer is the first
confirmed player. Keep `SESSION_ID` in this terminal for the remaining steps.

### 2. Request to join as the second player

```bash
REQUEST_ID=$(curl -fsS -X POST \
  "http://127.0.0.1:8000/v1/sessions/$SESSION_ID/join" \
  -H 'X-CourtMate-Player-ID: eval-player' \
  | python -c 'import json, sys; r=json.load(sys.stdin); assert r["status"] == "pending", r; print(r["id"])')

echo "Pending request: $REQUEST_ID"
```

**Expected result:** a pending request ID. This is a public game between two
unconnected players, so the organizer must approve the request.

### 3. Approve the request as the organizer

```bash
curl -fsS -X POST \
  "http://127.0.0.1:8000/v1/sessions/$SESSION_ID/join-requests/$REQUEST_ID/decision" \
  -H 'Content-Type: application/json' \
  -H 'X-CourtMate-Player-ID: eval-organizer' \
  -d '{"status":"approved"}' | python -m json.tool
```

**Expected result:** the response contains `"status": "approved"`.

### 4. Send a message as the approved player

```bash
curl -fsS -X POST \
  "http://127.0.0.1:8000/v1/sessions/$SESSION_ID/chat" \
  -H 'Content-Type: application/json' \
  -H 'X-CourtMate-Player-ID: eval-player' \
  -d '{"message":"Ready for the evaluation game!"}' | python -m json.tool
```

**Expected result:** a chat record containing the message and
`"player_id": "eval-player"`.

### 5. Verify the game roster

```bash
curl -fsS "http://127.0.0.1:8000/v1/sessions/$SESSION_ID/group" \
  -H 'X-CourtMate-Player-ID: eval-organizer' \
  | python -c 'import json, sys; s=json.load(sys.stdin)["session"]; assert {"eval-organizer", "eval-player"} <= set(s["confirmed_player_ids"]); print("PASS: both players are confirmed")'
```

**Expected result:** `PASS: both players are confirmed`.

You have now tested game creation, joining, approval, chat, and roster updates.
Press **Ctrl+C in Terminal 1** to stop the API. To repeat with an empty database,
restart it and rerun the walkthrough from step 1. A separate seed command cannot
populate a running server's in-memory database.

## Browser evaluation with Google sign-in

Use this path to evaluate the actual website. It requires **Node.js 20.9 or
newer**, a Firebase project with Google Authentication enabled, Firestore, and
backend Application Default Credentials. The API-only development headers above
do not bypass the website's sign-in flow.

### 1. Configure your evaluation project

Create a Firebase Web app and enable the Google sign-in provider. Add
`localhost` to Firebase Authentication's authorized domains. Create a Firestore
database and a Storage bucket for image features.

Create local configuration files if they do not already exist:

```bash
test -f .env || cp .env.example .env
test -f .env.local || cp .env.local.example .env.local
```

Edit these values in `.env`:

```dotenv
COURTMATE_DATASTORE=firestore
COURTMATE_AUTH_REQUIRED=true
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
COURTMATE_ALLOWED_ORIGINS=http://localhost:3000
COURTMATE_USE_VERTEX_AI=false
GOOGLE_GENAI_USE_VERTEXAI=false
COURTMATE_USE_GEMINI_INTENT=false
COURTMATE_VECTOR_SEARCH_ENABLED=false
GEMINI_API_KEY=
GOOGLE_MAPS_API_KEY=
```

Edit `.env.local` with your Firebase Web app values:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_FIREBASE_API_KEY=YOUR_FIREBASE_WEB_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT_ID.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=YOUR_FIREBASE_STORAGE_BUCKET
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=YOUR_MESSAGING_SENDER_ID
NEXT_PUBLIC_FIREBASE_APP_ID=YOUR_FIREBASE_APP_ID
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
```

Replace every `YOUR_...` value. All six Firebase configuration fields are needed
by the frontend's configuration check. Keep server credentials out of
`NEXT_PUBLIC_*` values. Maps and Gemini can stay disabled for the main game flow.

Authenticate the backend to your evaluation project:

```bash
gcloud auth application-default login
```

The authenticated account needs permission to use the selected Firestore
database. Image evaluation additionally requires configured bucket permissions.

### 2. Start the API and website

Stop the API-only process first if it still occupies port 8000.

**Terminal 1 — API:**

```bash
source .venv/bin/activate
python -m uvicorn backend.main:app --reload --port 8000
```

**Terminal 2 — website:**

```bash
npm ci
npm run dev
```

Open [CourtMate](http://localhost:3000). Use two separate browser profiles, signed
in with different Google accounts, to act as **Player A** and **Player B**.

### 3. Follow the evaluation scenario

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Sign in as Player A and complete the sport profile. | Profile is created and remains available after a refresh. |
| 2 | Create a public pickleball game in Whitefield for a future date with open spaces. | A Rally Circle appears in the organizer's activity. |
| 3 | Sign in as Player B; choose the same sport, locality, date, and a compatible skill level. | The new game can be found in discovery. |
| 4 | As Player B, request to join. | A pending request appears for the organizer. |
| 5 | As Player A, approve the request. | Player B appears in the confirmed roster and their upcoming games. |
| 6 | Open the Rally Circle as each player and exchange a message. | Both players can see the conversation after refreshing. |
| 7 | Mark the game done as each confirmed player and submit feedback. | The game moves through awaiting feedback to completed once all confirmed players submit. |
| 8 | Open profiles, activity, and leaderboards. | Completed activity is reflected; CMR changes depend on the game's rating mode and eligible results. |

Use a public game between accounts that are not mutually connected when testing
the pending-request path. Private games and mutual connections can follow an
auto-approval path.

### 4. Run frontend checks

```bash
npm run lint
npm run typecheck
npm run build
```

**Expected result:** each command exits successfully. These validate lint, types,
and production compilation; they do not simulate clicks or verify cloud access.

## Evaluation checklist

Record the command/result or take a screenshot for each item you evaluate.

| Check | Evidence to capture |
| --- | --- |
| Automated backend tests | Pytest passing summary. |
| API starts | `/health` JSON showing `status: ok`. |
| Two-player workflow | Approved request, chat response, and roster PASS message. |
| Browser flow, if configured | Game creation, approval, and shared chat in two accounts. |
| Frontend validation | Successful lint, typecheck, and build output. |
| Docker, if required | Image build output and container health response. |
| Optional integrations | Label Maps, AI, and cloud-storage checks as tested or not configured. |

No Jenkinsfile or GitHub Actions workflow is checked in. These are manual
evaluation steps; automatic CI checks and coverage gates should not be assumed.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `ModuleNotFoundError` or missing `pytest` | Activate `.venv` and install `requirements.txt` with `python -m pip`. Use `python -m uvicorn` so the API uses that environment. |
| `Address already in use` | Stop the earlier API or web process before starting another on the same port. |
| Curl cannot connect | Keep Terminal 1 running and confirm the API reports port 8000. |
| JSON parsing error during the walkthrough | Inspect the preceding curl error. Check the API logs, then repeat from game creation; do not continue with empty IDs. |
| HTTP 401 in the API-only walkthrough | Start the API with the exact local evaluation command; a cloud-configured server requires Firebase tokens instead. |
| Google sign-in is unavailable | Replace all six Firebase web values and restart `npm run dev`. |
| Google sign-in rejects the domain | Add `localhost` to Firebase Authentication's authorized domains. |
| Firestore credentials or permission error | Run ADC login and check `GOOGLE_CLOUD_PROJECT` and account permissions, or use the API-only path. |
| Browser cannot reach the API | Check `NEXT_PUBLIC_API_URL`, the API process, and `COURTMATE_ALLOWED_ORIGINS`. |
| No games appear | An empty database is expected. Create a future game, match the sport/date/locality, or seed a dedicated demo Firestore project. |
| Changes disappear after restart | Memory mode is temporary; use Firestore to test persistence. |
| Map illustration appears instead of a live map | The optional browser Maps key is absent or rejected. Core discovery can still be evaluated. |
| AI or image features are unavailable | Configure the corresponding model and storage integrations in Advanced setup. |
| Node/Next.js version error | Check `node --version`; use Node.js 20.9 or newer. |

## Docker

The Dockerfile builds a **single-stage backend image** based on
`python:3.12-slim`. It installs `requirements.txt`, copies `backend/`, and launches
Uvicorn on `PORT` (default `8080`). It does not package the Next.js frontend.

| Choice | Current implementation |
| --- | --- |
| Dependency caching | Copy requirements before backend source. |
| Runtime files | Backend package and installed Python dependencies. |
| Default datastore | Firestore; configure credentials for cloud-backed runs. |
| Local smoke test | Override datastore to memory and probe `/health`. |
| Container hardening | No explicit non-root user or Docker `HEALTHCHECK` is configured. |

```bash
docker build -t courtmate-api:local .

docker run --rm --name courtmate-api \
  -p 127.0.0.1:8080:8080 \
  -e COURTMATE_DATASTORE=memory \
  -e COURTMATE_AUTH_REQUIRED=true \
  -e COURTMATE_VECTOR_SEARCH_ENABLED=false \
  courtmate-api:local
```

In another terminal:

```bash
curl http://localhost:8080/health
docker logs courtmate-api
docker stop courtmate-api
```

This provides a health smoke test; authenticated flows require Firebase
configuration. The image has no separate `test` target.

## How the project works

| Part | Purpose | Main files |
| --- | --- | --- |
| Next.js frontend | Screens for discovery, Rally Circles, profiles, and feedback. | `app/page.tsx`, `app/group-space.tsx`, `app/community-hub.tsx` |
| FastAPI backend | Receives API requests and runs application rules. | `backend/main.py`, `backend/models.py` |
| Authentication | Verifies Firebase ID tokens for signed-in users. | `backend/auth.py`, `firebase.ts` |
| Matching | Filters and ranks games and replacement players. | `backend/matching.py` |
| Persistence | Stores data in memory or Firestore. | `backend/repository.py` |
| Optional AI | Language parsing, images, embeddings, and retrieval. | `backend/gemini.py`, `backend/vector_search.py` |
| Automated tests | Repeatable API and matching checks. | `tests/test_api.py`, `tests/test_matching.py` |

The browser sends requests to the API. The API checks identity, applies game
rules, and reads or writes records. Optional AI assists discovery and analysis;
Python remains responsible for match eligibility.

For the complete API reference, use [Swagger UI](http://127.0.0.1:8000/docs).
During browser/cloud evaluation, protected API calls require a Firebase ID token;
the website attaches it automatically.

## Advanced setup

Skip this section for the no-cloud evaluation. Expand only the configuration
needed for the feature you want to test.

<details>
<summary>Configuration reference</summary>

### Configuration

Backend values are loaded from `.env`; Next.js uses `.env.local`. Values prefixed
with `NEXT_PUBLIC_` are browser-visible and must never contain server secrets.

| Variable | Default or template value | Purpose |
| --- | --- | --- |
| `COURTMATE_DATASTORE` | Code: `memory`; template/container: `firestore` | Select persistence. |
| `COURTMATE_AUTH_REQUIRED` | `true` | Require a Firebase bearer token. |
| `COURTMATE_DEFAULT_AREA` | `Whitefield` | Initial locality for new players. |
| `COURTMATE_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated frontend origins for CORS. |
| `COURTMATE_TIMEZONE` | `Asia/Kolkata` | Session scheduling timezone. |
| `GOOGLE_CLOUD_PROJECT` | Empty in backend template | Project for Firestore, Firebase Admin, and cloud integrations. |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex AI location when configured. |
| `GEMINI_API_KEY` | Empty | Server-only Gemini API credential. |
| `GEMINI_MODEL` | Code: `gemini-2.5-flash`; template: `gemini-3.6-flash` | Set explicitly to a model available to your project. |
| `COURTMATE_USE_GEMINI_INTENT` | `false` | Enable model-based intent parsing when a client is configured. |
| `COURTMATE_GROUNDED_RESPONSE_WITH_GEMINI` | `false` | Optional model-written grounded responses. |
| `COURTMATE_USE_VERTEX_AI` / `GOOGLE_GENAI_USE_VERTEXAI` | `false` | Select Vertex AI authentication for model clients. |
| `COURTMATE_VECTOR_SEARCH_ENABLED` | `true` | Enable optional vector retrieval. |
| `GEMINI_EMBEDDING_MODEL` / `COURTMATE_VECTOR_DIMENSIONS` | `gemini-embedding-001` / `768` | Embedding model and index dimensions. |
| `COURTMATE_MAX_SESSION_READS` / `COURTMATE_MAX_PLAYER_READS` | `100` / `500` | Repository read limits. |
| `COURTMATE_MAX_VECTOR_RESULTS` | `20` | Vector candidate limit. |
| `GOOGLE_MAPS_API_KEY` | Empty | Server-side locality geocoding. |
| `COURTMATE_PROFILE_BUCKET` | Configured Firebase bucket, otherwise project-derived bucket | Media storage. |
| `COURTMATE_SIGNING_SERVICE_ACCOUNT` | Credential-derived when available | Signing identity for profile upload URLs. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Browser API origin. |
| `NEXT_PUBLIC_APP_URL` | Hosted URL in template | Web app origin; use localhost for development. |
| `NEXT_PUBLIC_FIREBASE_*` | Mostly empty | Firebase web configuration, including auth domain and storage bucket. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Empty | Browser Maps JavaScript API key. |

A Gemini key alone does not enable model-based intent parsing: set
`COURTMATE_USE_GEMINI_INTENT=true` as well. Without Maps geocoding, known locality
coordinates and textual matching remain available.

</details>

<details>
<summary>Demo Firestore data, migrations, semantic search, and deployment</summary>

## Demo data and migrations

Firestore starts empty. Create records through the application or populate a
dedicated demo project using Application Default Credentials:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID \
  python -m backend.seed_synthetic_firestore
```

The seed utility upserts stable synthetic records for players, games, requests,
chat, feedback, follows, notifications, communities, and social posts. Synthetic
profiles use initials instead of uploaded photos. It does not create Firebase
Authentication accounts.

| Option | Purpose |
| --- | --- |
| `--replace-social` | Replace synthetic social posts and comments. |
| `--replace-social --social-only` | Refresh only the synthetic social feed. |
| `--reset-synthetic` | Delete the script's synthetic records and rebuild its dataset. |
| `COURTMATE_DEMO_RHEA_UID` | Optionally associate the named demo persona with an existing Firebase UID; use a demo account only. |

For a labelled synthetic CMR trajectory on a demo profile:

```bash
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID \
  python -m backend.seed_profile_trajectory \
  --player-id YOUR_DEMO_FIREBASE_UID --sport badminton --games 8
```

Historic rating formats are converted when read. This migration permanently
rewrites stored ratings to the canonical scale; back up target data first:

```bash
COURTMATE_DATASTORE=firestore GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID \
  python -m backend.migrate_cmr_to_10
```

## Grounded semantic search

Optional semantic retrieval uses Firestore vector search and Vertex AI
embeddings. Search documents contain projections of sessions, public players,
and CourtMate FAQ content. Candidate records are reread and validated by Python
before being returned.

Enable Vertex AI in backend configuration, grant the runtime service account
the needed Vertex AI and Firestore permissions, and refresh the corpus:

```bash
COURTMATE_DATASTORE=firestore \
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID \
GOOGLE_CLOUD_LOCATION=global \
COURTMATE_USE_VERTEX_AI=true \
GOOGLE_GENAI_USE_VERTEXAI=true \
python -m backend.rebuild_vector_index
```

Create the corresponding vector index for the default 768 dimensions:

```bash
gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --database='(default)' \
  --collection-group=search_documents \
  --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=source_type \
  --field-config=order=ASCENDING,field-path=visibility \
  --field-config=order=ASCENDING,field-path=sport \
  --field-config=order=ASCENDING,field-path=status \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
```

If embeddings or the index are unavailable, discovery falls back to deterministic
matching. Keep index dimensions aligned with `COURTMATE_VECTOR_DIMENSIONS`.

## Deployment

### Vercel frontend

1. Configure the Next.js project with its `NEXT_PUBLIC_API_URL`,
   `NEXT_PUBLIC_APP_URL`, and Firebase web configuration.
2. Set `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` for the interactive map. Enable Maps
   JavaScript API for that key and restrict it to the app's web domains.
3. Redeploy after changing public configuration because Next.js embeds these
   values at build time.
4. Add the deployed domain to Firebase Authentication's authorized domains.

For Google sign-in on the app's own domain, `next.config.ts` proxies Firebase's
reserved `/__/auth/` and `/__/firebase/` routes. Its upstream currently references
the existing Firebase project; update it when deploying with another project.
Set the frontend Firebase auth domain to your web hostname and configure the
OAuth JavaScript origin as `https://YOUR_WEB_DOMAIN` and redirect URI as
`https://YOUR_WEB_DOMAIN/__/auth/handler`. Set the OAuth consent-screen app name to
`CourtMate`.

If Maps configuration is missing or rejected, the UI retains its fallback
illustration and game listings.

### Cloud Run backend

Use Firestore Native mode, a dedicated runtime service account, and permissions
limited to the services the selected features need. Example deployment profile:

```bash
gcloud run deploy courtmate-api \
  --project=YOUR_PROJECT_ID \
  --source . \
  --region us-central1 \
  --min-instances 0 \
  --max-instances 1 \
  --memory 512Mi \
  --cpu 1 \
  --service-account YOUR_RUNTIME_SERVICE_ACCOUNT \
  --set-env-vars 'COURTMATE_DATASTORE=firestore,COURTMATE_AUTH_REQUIRED=true,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,COURTMATE_ALLOWED_ORIGINS=https://YOUR_WEB_DOMAIN,COURTMATE_MAX_SESSION_READS=100,COURTMATE_MAX_PLAYER_READS=500'
```

Supply optional Gemini and server Maps credentials through Secret Manager rather
than literal keys in commands. Configure the media bucket and optional Vertex AI
settings separately. Browser-direct API access also requires Cloud Run invocation
access to be configured for that architecture; Firebase authentication remains
enforced by the app on protected routes.

Scale-to-zero and read limits help control usage but do not guarantee zero cost.
Monitor billing, request volume, and Firestore operations. The API exposes
`X-Response-Time-Ms` and request-duration logs for diagnostics.

After deployment, check health, Google sign-in, game creation and join requests,
map loading, and media uploads using the deployed web and API origins.

</details>
