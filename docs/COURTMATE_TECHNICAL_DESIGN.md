# CourtMate Technical Design

**Status:** Hackathon MVP
**Frontend:** Next.js 15, React, TypeScript, PWA
**Backend:** Python FastAPI on Cloud Run
**Cloud:** Firebase Auth, Firestore native vector search, Vertex AI Gemini Embeddings, Cloud Storage, Gemini API, optional Google Maps Geocoding

## 1. Design Principles

1. Gemini handles natural language, voice-to-text input, explanations, conversational follow-ups, and image interpretation.
2. Python remains authoritative for eligibility, ranking, permissions, capacity, lifecycle, score validation, and CMR updates.
3. The home journey is chat-first. Structured forms are not used for game creation or score entry.
4. Every AI result is bounded by stored data and validated before state changes.
5. The same API contract works with Firestore in deployment and an in-memory repository for local tests.

## 2. Architecture

```text
Next.js PWA
  | Firebase ID token
  v
FastAPI on Cloud Run
  |-- Gemini adapter (google-genai)
  |-- embedding provider and sanitized vector indexer
  |-- deterministic matcher and CMR engine
  |-- authorization and state transitions
  |-- repository protocol
       |-- FirestoreRepository
       |-- InMemoryRepository

Firebase Auth: Google identity
Cloud Storage: profile photos and wearable screenshots
Playo/Hudle/venue URL: external booking hand-off
```

The browser never receives the Gemini secret. Cloud Run uses environment configuration and service credentials. Local development can use an AI Studio API key; production should use a managed secret and Vertex AI credentials when enabled.

## 3. Chat and Search Flow

`POST /v1/sessions/search` receives a natural-language query and optional sport/mode.

1. The deterministic scope guard rejects unrelated questions before any retrieval.
2. `GeminiIntentParser` attempts structured `SearchIntent` extraction.
3. If Gemini is unavailable or invalid, the deterministic parser extracts supported sport, locality, date, time, skill range, and style. It handles phrases such as "around me," "this Saturday," "tomorrow," numeric ranges, and clock times without confusing time with skill.
4. The query is embedded with Vertex AI `gemini-embedding-001` at 768 dimensions and searched against sanitized `search_documents` using Firestore KNN cosine search. Filters include source type, sport when explicit, visibility, and active status.
5. Returned source IDs are re-read from Firestore. Localities are geocoded through Google Maps when configured, with Bangalore fallback coordinates.
6. `search_sessions` filters by sport, open capacity, date, time overlap, coordinate distance/travel radius, skill overlap, and exact style when requested.
7. Python ranks eligible sessions and produces evidence such as skill fit, distance, availability, reliability, and familiarity. Gemini receives only those verified records for a concise grounded explanation.
8. If embeddings or the vector index are unavailable, the bounded deterministic matcher remains the fallback. No match returns a `GroupProposal`, not a fabricated group.

`POST /v1/me/performance-chat` handles CMR, completed games, activity, and uploaded wearable questions. Out-of-scope questions receive a safe redirect.

## 4. Operational Data

Firestore collections:

- `players`: identity, approximate location, sport signals, reliability, CMR history, follows.
- `sessions`: sport, group name, coordinates, schedule, skill band, style, capacity, confirmed members, waitlist, lifecycle, external booking URL.
- `join_requests`: pending, approved, declined, waitlisted, withdrawn.
- `chat_posts`: member posts and parsed match-result metadata.
- `feedback`: fun, fairness, qualitative skill feedback, teams, scores, return intent.
- `notifications`: game matches, requests, approvals, follows, and event alerts.
- `follows`, `activity_proofs`, `social_posts`, `social_comments`.
- `tournaments`, `tournament_registrations`, `tournament_matches`.
- `search_documents`: sanitized projections for public sessions, tournaments, players, venues, and CourtMate FAQ content, including a 768-dimensional embedding and filter metadata. It never stores contact details, exact home coordinates, private preferences, or private group chat.

Coordinates support matching but are not public profile data. Profile photos and activity images use authenticated cloud-storage upload flows; initials are rendered when no photo exists.

## 5. Matching and CMR

Python hard filters first, then ranks with starting weights: 35% skill, 25% time or saved availability, 20% distance/area, 10% style, and 10% member reliability. Replacement candidates use skill, distance, reliability, and style. The weights are configuration, not model output.

External DUPR or self-reported skill can seed compatibility. CMR is separate per sport and displayed from 0-100. Completed-game feedback and confirmed scores update `cmr_ratings`, `cmr_game_counts`, and `cmr_history`; each history point stores rating and delta. CMR is a community signal, not an official DUPR replacement.

## 6. Group and Score State

Session states are `open`, `full`, `in_progress`, `completed`, and `cancelled`. Requests and waitlist promotion are authorized by the organizer and capacity rules. Members can post chat updates and natural score statements. The API parses teams and score, sets `pending_confirmation`, and requires participating confirmation before CMR refresh. A disputed result does not affect CMR.

## 7. Tournament Design

`POST /v1/tournaments/{id}/fixtures` generates a 2-16 player round-robin draw. `POST /v1/tournaments/{id}/matches/{match_id}/score` accepts a score from a match player or organizer. Player submissions can require opponent confirmation; organizers can correct completed scores. `GET /v1/tournaments/{id}` recalculates standings from stored matches, so wins, losses, points, ranks, and the frontend Draw sheet stay current after every update.

## 8. Security and Guardrails

- Firebase ID tokens are verified server-side.
- Organizer-only, member-only, player-only, and tournament permissions are enforced in FastAPI.
- Gemini cannot override authorization, capacity, privacy, dates, score rules, or stored evidence.
- Vector similarity is not an authorization boundary. Source records are fetched again and checked against the authenticated player before they are returned.
- Screenshot analysis accepts only approved HTTPS cloud-storage URLs and extracts only visible metrics.
- Exact home coordinates and private group content are not exposed.
- Firestore read limits and Cloud Run scale-to-zero keep the hackathon deployment affordable.

## 9. API Surface

Core routes include:

```text
GET  /health
GET  /v1/me
POST /v1/me/profile
POST /v1/sessions/search
POST /v1/me/performance-chat
POST /v1/groups
POST /v1/sessions/{id}/join
POST /v1/sessions/{id}/leave
GET  /v1/sessions/{id}/group
GET/POST /v1/sessions/{id}/chat
POST /v1/sessions/{id}/feedback
GET  /v1/sessions/{id}/leaderboard
GET/POST /v1/tournaments...
```

`POST /v1/sessions/search` keeps its existing recommendation and group-proposal contract and adds a non-sensitive `retrieval` trace containing the retrieval mode, candidate count, grounded result count, and embedding version. Embeddings are never returned to the browser.

## 10. Verification and Deployment

Run `python -m unittest discover -s tests` for API, matching, lifecycle, CMR, waitlist, and tournament coverage. Run `npm run build` for the PWA production build. Use `COURTMATE_DATASTORE=memory` for isolated local development and `COURTMATE_DATASTORE=firestore` on Cloud Run. Required configuration includes Firebase project identity, allowed CORS origins, Gemini credentials, Google Maps key if geocoding is enabled, and Firestore service access.
Run `python -m backend.rebuild_vector_index` after seeding Firestore and create the `search_documents.embedding` vector index with 768 dimensions and cosine distance. Vector tests use a fake embedding provider and do not require cloud credentials.

Deferred infrastructure includes Pub/Sub reminders, BigQuery/Looker analytics, native push notifications, first-class Venue/Event entities, bracket tournaments, and a general-purpose agent tool loop. These should follow evidence from the chat-to-game and organizer workflows.
