# CourtMate
## Technical Design, Architecture & Decisions

**Product:** Bangalore racket-sports community and session layer  
**Pilot status:** Working hackathon MVP  
**Current implementation:** Multi-sport group discovery, session continuity, profiles, feedback, leaderboards, and tournament desk  
**Initial market:** Whitefield and nearby Bangalore localities  
**Frontend:** Next.js 15, React 19, TypeScript, Firebase Auth/Storage  
**Backend:** FastAPI on Python 3.12, Cloud Run-compatible  
**Data:** Firestore with an in-memory development fallback  
**AI:** Gemini through the server-side `google-genai` adapter

> **Architecture principle:** Use Gemini for language, structured intent parsing, explanations, and bounded personalization. Use Python for deterministic eligibility, ranking, permissions, validation, and state changes.

## 1. Scope and Current System

CourtMate sits between distribution channels such as WhatsApp and Instagram and existing booking platforms such as Playo, Hudle, or a venue's own system. It helps players discover compatible games, helps organizers manage group continuity, and gives communities a place for profiles, chat, scores, feedback, and tournaments.

The current product supports:

- Pickleball, badminton, tennis, padel, squash, and table tennis.
- Natural-language session search with Gemini and a deterministic fallback parser.
- Locality and coordinate-aware matching, with Bangalore locality fallbacks.
- Player profiles with sport skill levels, external rating provenance, reliability, follows, and public activity.
- Session creation, shared-link-style discovery, join requests, organizer approval, waitlists, leaving, and status close-out.
- Persistent in-app notifications for new game matches, join requests, request updates, and follows.
- Member-only group chat.
- Post-game fun, fairness, return-intent, player-rating, team, and score feedback.
- Community score and CMR updates from feedback.
- Group and local leaderboards.
- Optional tracker screenshot analysis after a completed game.
- Round-robin tournament registration, fixture generation, score confirmation, and standings.
- Firestore persistence or an in-memory repository for local development.

CourtMate does **not** book courts, process payments, scrape DUPR, or depend on a booking-platform API. A session may carry an external booking URL, but that link is only a hand-off.

## 2. Goals and Boundaries

### 2.1 Current MVP goals

- Let an authenticated player search by sport, locality, time, level, and style.
- Return explainable session recommendations or a new-group proposal.
- Let an organizer create a session with themselves as the first confirmed player.
- Let compatible nearby players discover a new game through in-app notifications.
- Keep sessions viable through join approval, waitlists, leaving, and replacement suggestions.
- Preserve the group relationship through chat, profiles, feedback, leaderboards, and repeat-game history.
- Run a small venue tournament without spreadsheets.

### 2.2 Current non-goals

- Court inventory, court availability sync, booking, payments, refunds, or commissions.
- Official DUPR integration or an official CourtMate rating.
- Native mobile applications, browser push, WhatsApp API integration, or SMS workflows.
- Public city-wide rankings with no privacy or confidence controls.
- Bracket formats beyond the current round-robin tournament MVP.
- Pub/Sub, BigQuery, Looker, or other asynchronous analytics infrastructure.
- Production-grade moderation tooling beyond the current authenticated/member-only access model.

### 2.3 Quality targets

| Target | Current expectation |
|---|---|
| Matching | Deterministic filters and ranking remain usable when Gemini is unavailable. |
| Explainability | Session recommendations include factor values and a human-readable explanation. |
| Safety | Protected endpoints require server-verified Firebase identity when auth is enabled. |
| Recoverability | A player can leave without corrupting the session; waitlisted players can be promoted. |
| Data minimization | Approximate locality and bounded session/player snapshots are used for matching. |
| Cost | Firestore reads are bounded by environment-configured limits; Cloud Run can scale to zero. |

## 3. High-Level Architecture

```text
Authenticated browser
  Next.js PWA
      |
      | Firebase Auth ID token
      v
FastAPI application
  Cloud Run or local Uvicorn
      |
      +--> GeminiIntentParser
      |      - structured intent parsing
      |      - bounded search decision
      |      - optional tracker-image analysis
      |
      +--> deterministic matching
      |      - hard eligibility filters
      |      - locality/distance
      |      - skill/style/availability/reliability ranking
      |
      +--> Repository protocol
             +--> FirestoreRepository
             +--> InMemoryRepository

Firebase Storage
  - profile images
  - completed-game tracker screenshots

External booking URL
  - Playo, Hudle, venue system, or organizer-provided link
```

The browser does not receive a Gemini secret. AI requests are made by the backend. The repository protocol keeps local development and Firestore deployment on the same application contract.

### 3.1 Component responsibilities

| Component | Responsibility | Status |
|---|---|---|
| Next.js PWA | Home search, game creation, activity, profile, group space, feedback, tournament UI | Implemented |
| Firebase Auth | Google sign-in and Firebase identity | Implemented |
| Firebase Storage | Profile and activity-proof image uploads | Implemented |
| FastAPI | Authenticated API, validation, authorization, matching, state transitions | Implemented |
| Gemini adapter | Intent parsing, bounded search decisions, tracker-image extraction | Implemented with fallback for text parsing |
| Python matcher | Sport, location, date, time, capacity, skill, style, and ranking logic | Implemented |
| Firestore repository | Persistent operational data | Implemented |
| In-memory repository | Offline/local test fallback | Implemented |
| Pub/Sub | Reminders and async replacement events | Not implemented |
| BigQuery/Looker | Product analytics | Not implemented |

## 4. Request and State Flows

### 4.1 Authentication and player bootstrap

1. The frontend signs in with Firebase Google authentication.
2. It sends the Firebase ID token as a bearer token to protected API endpoints.
3. FastAPI verifies the token through `backend/auth.py`.
4. If a player document does not exist, `get_current_player` creates one using the Firebase identity and the configured default area.
5. In development, auth can be disabled through `COURTMATE_AUTH_REQUIRED=false`, which uses a local development identity.

### 4.2 Session search

1. The player submits text and optionally a selected sport.
2. `GeminiIntentParser.parse` returns a validated `SearchIntent`, or uses deterministic parsing when Gemini is unavailable.
3. The API resolves explicit locality text and may geocode it through Google Maps.
4. Known Bangalore localities have coordinate fallbacks, including Whitefield, Brookefield, Kadugodi, Varthur, Indiranagar, and Koramangala.
5. `search_sessions` applies hard filters for sport, status, open slots, date, locality/distance, time, skill overlap, and exact style when requested.
6. Python ranks eligible sessions and creates evidence-bearing recommendation reasons.
7. Gemini may choose the final action and summary from a bounded session snapshot. Its IDs are restricted to the deterministic recommendation set.
8. If no session matches, the API returns a group proposal instead of inventing an existing group.

### 4.3 Create game and notify nearby players

1. `POST /v1/groups` parses the request and creates a `Session`.
2. The organizer is added to `confirmed_player_ids`.
3. The session is saved through the repository.
4. `_notify_players_about_game` creates in-app `game_match` notifications for compatible players.
5. There is no email, SMS, WhatsApp, or browser push notification in the current implementation.

### 4.4 Join request and waitlist

1. A player posts `POST /v1/sessions/{session_id}/join`.
2. If capacity exists, a pending request is stored in `join_requests` and the organizer receives a notification.
3. If the session is full, the player is appended to `waitlist_player_ids` and receives a waitlisted request.
4. The organizer approves or declines through the decision endpoint.
5. Approval confirms the player if capacity remains; otherwise the request becomes waitlisted.
6. The player receives a request-update notification.
7. A confirmed player can leave. The first waitlisted player is promoted and their request becomes approved.

### 4.5 Session lifecycle

Sessions use:

- `open`
- `full`
- `in_progress`
- `completed`
- `cancelled`

The API refreshes status from the session date and local `Asia/Kolkata` time. A session becomes `in_progress` at its start and `completed` at its end. Completed sessions are read-only for chat and feedback remains available. An organizer can also close a session explicitly.

### 4.6 Replacement suggestions

```text
GET /v1/sessions/{session_id}/replacement
  -> load session
  -> exclude confirmed players and non-opted-in players
  -> rank candidates by skill fit, distance/area, reliability, and style
  -> return candidates
```

The current endpoint returns suggestions only. It does not yet create an invitation, run a transaction, or send an expiry-backed replacement invitation. The product UI can use organizer approval and an existing join flow until a dedicated replacement state machine is implemented.

### 4.7 Group space

A recurring group is currently represented by a session record and its `group_name`; there is no separate `groups` collection or Group model yet.

Confirmed members can:

- Read and post member-only chat.
- View member profiles.
- View group and locality leaderboards.
- Submit post-game feedback and team/score context.
- Attach tracker proof after completion.

### 4.8 Tournament flow

1. An authenticated player creates a tournament with sport, area, optional venue, date, capacity, and round-robin format.
2. Players register; registrations become waitlisted after capacity.
3. The organizer generates fixtures once.
4. The tournament moves from `registration` to `in_progress`.
5. Match players or the organizer submit a score.
6. A result may be pending confirmation or become completed immediately for an organizer/explicit confirmation.
7. Standings calculate played, wins, losses, draws, points for, points against, and table points.
8. When all matches are completed, the tournament moves to `completed`.

The current tournament limit is 2-16 participants and round-robin only.

### 4.9 Tracker screenshot flow

1. A confirmed member uploads a JPG, PNG, or WebP screenshot to Firebase Storage under `activity-proofs/{userId}/{sessionId}/{fileName}`.
2. After the session is completed, the frontend sends the Storage URL to `POST /v1/sessions/{session_id}/activity-proof/analyze`.
3. The API accepts only HTTPS URLs hosted by Google Cloud Storage domains.
4. Gemini extracts only visible values such as calories, duration, active minutes, distance, steps, and average heart rate.
5. The structured analysis is stored as an activity proof.

This is optional proof of participation. It does not influence the current matching score or CMR calculation.

## 5. Data Design

### 5.1 Source of truth

The repository protocol is the application boundary. Firestore is used when `COURTMATE_DATASTORE=firestore); otherwise `InMemoryRepository` is used. The current Firestore collections are:

| Collection | Purpose |
|---|---|
| `players` | Profiles, sport skill/rating provenance, reliability, CMR, follows-related profile aggregates |
| `sessions` | Groups/games, venue and locality, capacity, members, lifecycle |
| `join_requests` | Pending, approved, declined, waitlisted, and withdrawn requests |
| `feedback` | Fun, fairness, would-return, player ratings, teams, and score context |
| `chat_posts` | Authenticated member chat posts |
| `notifications` | Persistent in-app notifications |
| `follows` | Player-to-player follow relationships |
| `activity_proofs` | Tracker image URL and extracted metrics |
| `tournaments` | Event metadata and registration state |
| `tournament_registrations` | Player registration and waitlist state |
| `tournament_matches` | Round-robin fixtures, scores, confirmation, and winner |

There is currently no separate `groups`, `venues`, `events`, or `audit_events` collection.

### 5.2 Core models

#### Player

Key fields include:

```text
id, display_name, profile_image_url
area, latitude, longitude, travel_radius_km
skill_levels, sport_ratings, rating_sources
dupr_rating, rating_source, rating_confidence
availability, style, reliability
cmr_ratings, cmr_game_counts, cmr_history, cmr_scale
community_score, community_rating_count
friends, opted_into_replacement_pool
```

Supported rating provenance is `dupr`, `organizer_confirmed`, `synthetic`, `self_reported`, or `unrated`.

#### Session

```text
id, group_name, organizer_id, sport
area, latitude, longitude, venue_name
session_date, start_time, end_time
skill_min, skill_max, style, capacity
confirmed_player_ids, waitlist_player_ids
external_booking_url, status
```

#### Feedback

```text
session_id, player_id, fun, fairness, would_return
ratings[{player_id, skill_level, rating, comment}]
teams[{name, player_ids, score}]
created_at
```

#### Tournament

```text
id, name, sport, organizer_id, area, venue_name
tournament_date, format, capacity, status
registration_ids, created_at
rules{score_label, point_target, win_by, best_of}
```

### 5.3 Rating and CMR behavior

DUPR is retained as an external pickleball reference when available. It is never overwritten by CourtMate.

CourtMate maintains sport-specific CMR values on a 0-100 display scale. Older persisted CMR values on the legacy 1-8 scale are normalized on read/write. CMR is refreshed from completed-game feedback; it is a community/player-history signal, not an official rating.

The matcher converts CMR to the legacy 1-8 compatibility scale when necessary and falls back to sport ratings or DUPR. Unrated players remain eligible where the session rules allow them, but the UI labels their evidence and confidence.

### 5.4 Profile privacy

Public profiles expose only the fields required for discovery and social context, such as display name, area, sport ratings, CMR, reliability, follower counts, recent games, and activity dates. Exact coordinates are used for matching but are not intended as a public home location. Protected profile changes require the signed-in player identity.

## 6. Matching and Intelligence

### 6.1 Deterministic matching

The matcher first filters by:

- sport;
- open or full session status;
- required open slots;
- requested date;
- locality or travel-radius distance;
- requested time overlap;
- skill-band overlap;
- exact style when requested;
- player rating inside the session band when a player rating is available.

The current session ranking is:

```text
0.35 skill fit
0.25 time or saved-availability fit
0.20 area/distance fit
0.10 style fit
0.10 confirmed-member reliability
```

Familiarity is calculated and returned as evidence, but is not currently included in the final session score. Replacement ranking uses:

```text
0.50 skill fit
0.20 area/distance fit
0.20 reliability
0.10 style fit
```

These are hard-coded starting weights in `backend/matching.py`, not model output.

### 6.2 Gemini adapter

The current adapter supports:

- Structured `SearchIntent` extraction.
- Bounded `SearchDecision` generation over deterministic recommendations.
- Fallback parsing and decisioning when `GEMINI_API_KEY` or the SDK is unavailable.
- Tracker screenshot extraction through the same server-side client.

The current implementation does **not** expose a general Gemini function-calling loop. Backend tools are conceptual product boundaries; API endpoints and Python functions perform the actual state changes.

### 6.3 Intent schema

```json
{
  "sport": "pickleball",
  "area": "Whitefield",
  "date": "2026-08-30",
  "start_time": "08:00:00",
  "end_time": "12:00:00",
  "skill_min": 3.0,
  "skill_max": 3.5,
  "style": "casual",
  "open_slots_required": 1,
  "latitude": 12.9698,
  "longitude": 77.7499
}
```

Supported sports are `pickleball`, `badminton`, `tennis`, `padel`, `squash`, and `table_tennis`. Search skill values use a 1-8 compatibility scale; visible CMR uses 0-100.

### 6.4 AI boundaries

- Pydantic validates model output before it is used.
- Python owns capacity, membership, dates, locality, skill constraints, and permissions.
- Gemini receives a bounded session snapshot for search decisions.
- Gemini cannot invent session IDs, players, ratings, scores, or evidence.
- If Gemini fails, deterministic browsing and matching remain available.
- Image analysis is rejected unless the URL is an approved Google Storage HTTPS URL and the game is completed.

## 7. API Surface

All endpoints below are implemented in `backend/main.py`. Protected endpoints require the current player unless auth is explicitly disabled for local development.

### Identity, profiles, and social

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Service and datastore health |
| POST | `/v1/intent/parse` | Parse search intent |
| GET | `/v1/me` | Current player |
| GET | `/v1/players/{player_id}` | Public player profile |
| POST | `/v1/players/{player_id}/follow` | Follow a player |
| POST | `/v1/players/{player_id}/unfollow` | Unfollow a player |
| GET | `/v1/me/following` | Following profiles |
| GET | `/v1/me/followers` | Follower profiles |
| POST | `/v1/me/profile` | Update profile/preferences |
| POST | `/v1/me/profile-image` | Save uploaded profile image URL |

### Sessions and groups

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v1/sessions/search` | Search sessions or return group proposal |
| POST | `/v1/groups` | Create a session/group |
| POST | `/v1/sessions/{id}/join` | Request to join or enter waitlist |
| POST | `/v1/sessions/{id}/leave` | Leave session or waitlist |
| GET | `/v1/sessions/{id}/join-requests` | Organizer view of requests |
| POST | `/v1/sessions/{id}/join-requests/{request_id}/decision` | Approve or decline |
| GET | `/v1/me/requests` | Player's request history |
| GET | `/v1/me/incoming-requests` | Organizer's pending requests |
| GET | `/v1/me/groups` | Sessions organized by player |
| GET | `/v1/me/games` | Upcoming and past player games |
| GET | `/v1/sessions/{id}/group` | Member/profile/activity view |
| GET | `/v1/sessions/{id}/replacement` | Replacement candidates |
| POST | `/v1/sessions/{id}/complete` | Organizer closes game |

### Social activity, feedback, and rankings

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/v1/me/notifications` | In-app notification inbox |
| POST | `/v1/me/notifications/{id}/read` | Mark notification read |
| GET | `/v1/sessions/{id}/chat` | Read member chat |
| POST | `/v1/sessions/{id}/chat` | Post member chat |
| POST | `/v1/sessions/{id}/feedback` | Save fun/fairness/player/team/score feedback |
| POST | `/v1/sessions/{id}/activity-proof/analyze` | Analyze uploaded tracker screenshot |
| GET | `/v1/sessions/{id}/leaderboard` | Group leaderboard |
| GET | `/v1/leaderboards/local` | Locality leaderboard by sport |

### Tournament desk

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/v1/tournaments` | List tournaments |
| POST | `/v1/tournaments` | Create tournament |
| GET | `/v1/tournaments/{id}` | Tournament details |
| POST | `/v1/tournaments/{id}/register` | Register or waitlist player |
| POST | `/v1/tournaments/{id}/fixtures` | Generate round-robin fixtures |
| POST | `/v1/tournaments/{id}/matches/{match_id}/score` | Submit/confirm result |

## 8. Security, Privacy, and Operations

### 8.1 Authentication and authorization

- Firebase ID tokens are verified server-side.
- Organizer-only operations enforce `session.organizer_id == player.id`.
- Member-only operations require the player in `confirmed_player_ids`.
- Players can rate only other confirmed members of the session.
- Tournament scores are restricted to match players or the tournament organizer.
- Notification reads are scoped to the owning player.
- The frontend never receives the Gemini API key.

### 8.2 Firebase Storage rules

Profile images are limited to 5 MB and activity proofs to 8 MB. Both are restricted to authenticated users writing under their own Firebase UID and to JPEG, PNG, or WebP content types. The current storage rules allow authenticated reads.

### 8.3 Locality and location

The profile stores a locality label and optional coordinates. The backend may use Google Maps Geocoding when `GOOGLE_MAPS_API_KEY` is configured, with known Bangalore fallback coordinates when it is not. The matcher uses travel radius and distance where both sides have coordinates; otherwise it falls back to locality text matching.

### 8.4 Observability currently available

The API exposes `/health` with the active repository type. Python logging records Gemini parsing/decision failures and fallback use. Product metrics can be derived from stored sessions, requests, feedback, notifications, follows, and tournaments.

Request correlation IDs, token usage dashboards, structured audit events, and centralized business analytics are not currently implemented.

### 8.5 Cost controls

- Firestore reads are bounded by `COURTMATE_MAX_SESSION_READS`, `COURTMATE_MAX_PLAYER_READS`, and `COURTMATE_MAX_TOURNAMENT_READS`.
- Gemini receives bounded session snapshots rather than the full database.
- The local parser keeps the core workflow usable without paid AI calls.
- Tracker image downloads are capped at 8 MB.
- Cloud Run is configured to scale to zero in the documented deployment profile.
- BigQuery and asynchronous infrastructure are deferred until usage justifies them.

## 9. Configuration and Deployment

### 9.1 Relevant environment variables

| Variable | Purpose |
|---|---|
| `COURTMATE_DATASTORE` | `firestore` or `memory` |
| `COURTMATE_AUTH_REQUIRED` | Require Firebase auth; default true |
| `COURTMATE_DEFAULT_AREA` | Default player locality; default Whitefield |
| `COURTMATE_ALLOWED_ORIGINS` | FastAPI CORS origins |
| `COURTMATE_TIMEZONE` | Session lifecycle timezone; default Asia/Kolkata |
| `GOOGLE_CLOUD_PROJECT` | Firestore/GCP project |
| `GOOGLE_CLOUD_LOCATION` | Google Cloud location |
| `GOOGLE_MAPS_API_KEY` | Optional server-side geocoding |
| `GEMINI_API_KEY` | Optional server-side Gemini API key |
| `GEMINI_MODEL` | Gemini model; default `gemini-3.6-flash` |
| `COURTMATE_MAX_SESSION_READS` | Firestore session read cap |
| `COURTMATE_MAX_PLAYER_READS` | Firestore player/follower read cap |
| `COURTMATE_MAX_TOURNAMENT_READS` | Firestore tournament read cap |
| `COURTMATE_DEMO_RHEA_UID` | Optional demo seed profile mapping |

Vertex AI configuration is present in the example environment, but the current `GeminiIntentParser` initializes the API-key client when `GEMINI_API_KEY` is configured. Vertex AI migration is a deployment decision still to complete.

### 9.2 Backend deployment

The root `Dockerfile`:

- Uses Python 3.12 slim.
- Installs `requirements.txt`.
- Copies the `backend` package.
- Defaults `COURTMATE_DATASTORE=firestore`.
- Starts Uvicorn on the Cloud Run-provided `PORT`.

The documented deployment target is one Cloud Run service with Firestore Native mode. Firebase Storage rules are deployed from `storage.rules`. The repository does not currently contain a Firebase Hosting configuration; the Next.js frontend is run with `npm run dev`, `npm run build`, and `npm start`, or deployed through a separately configured frontend host.

### 9.3 Seed data and migration

`backend/seed_synthetic_firestore.py` creates stable `demo-` records for multi-sport players, sessions, requests, chat, feedback, follows, notifications, and tournaments. It is safe to rerun because writes are upserts and it does not touch Firebase Authentication.

`backend/migrate_cmr_to_100.py` permanently rewrites legacy CMR documents after the 0-100 scale change.

## 10. Architecture Decisions

| Decision | Current choice | Reason | Tradeoff |
|---|---|---|---|
| Frontend | Next.js PWA | Fast mobile web flow from shared links | Less native device integration |
| Identity | Firebase Auth, Google sign-in | Simple browser identity and backend token verification | Phone OTP is not currently implemented |
| Images | Firebase Storage | Secure profile and tracker uploads without service-account keys in browser | Storage rules and URL validation must stay aligned |
| Backend | FastAPI/Python | Existing matching logic, clear validation, Cloud Run fit | Requires Python service deployment |
| Database | Repository protocol with Firestore + memory fallback | Shared contract, simple operational documents, easy tests | No relational joins or analytics warehouse |
| AI | Server-side `google-genai` | Structured Gemini parsing and bounded image analysis | Current adapter is not a general tool-calling agent |
| Matching | Deterministic Python ranking | Auditable, testable, safe for eligibility and capacity | Less adaptive until enough outcome data exists |
| Skill signal | Multi-sport ratings plus optional DUPR provenance | Works before official integrations and across sports | Sparse/self-reported data needs confidence labels |
| CMR | Sport-specific 0-100 community signal | Gives players a visible history without claiming official status | Requires completed-game feedback |
| Group model | Session with `group_name` | Keeps hackathon data model small | Recurring groups and venue entities are not first-class yet |
| Booking | External URL only | Keeps CourtMate focused on community and games | No booking sync or commission |
| Async work | Synchronous API | Reliable demo and simpler state transitions | No production reminder/replacement queue |
| Tournament format | Round robin, 2-16 players | Practical venue-level MVP | No brackets, doubles teams, or seasons yet |

## 11. Known Gaps and Next Technical Steps

1. Add first-class `Venue`, `Group`, and `Event` models so recurring communities and cross-venue activity are not encoded only in sessions.
2. Add an activity-feed API and moderation primitives for the Bangalore-wide social/FOMO layer.
3. Turn replacement suggestions into explicit invitations with expiry, acceptance, and audit state.
4. Add idempotency and transactional protection around join approval, waitlist promotion, and tournament score writes.
5. Add structured server events for search, join, attendance, feedback, CMR updates, and tournament activity.
6. Add notification delivery beyond the in-app inbox when the product has repeat usage.
7. Add tests for all authenticated authorization paths, lifecycle transitions, waitlist promotion, tournament confirmation, and tracker URL validation.
8. Move analytics to a warehouse only after there is enough session and feedback volume to justify it.
9. Revisit Gemini Vertex AI configuration and production secret management before launch.
10. Add rate limits, abuse reporting, block/mute controls, and retention policies before opening social surfaces broadly.

## 12. Verification

Run the current automated tests with:

```bash
python3 -m unittest discover -s tests -v
```

Run the frontend checks with:

```bash
npm run build
```

Run the backend locally with:

```bash
COURTMATE_DATASTORE=memory COURTMATE_AUTH_REQUIRED=false python -m uvicorn backend.main:app --reload
```

For a shared Firestore demo, authenticate with Google, configure the GCP project and Application Default Credentials, seed the synthetic dataset, and run the frontend and backend separately.
