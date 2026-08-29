# CourtMate Technical Design

**Status:** Hackathon MVP
**Frontend:** Next.js 15, React, TypeScript, PWA
**Backend:** Python FastAPI on Cloud Run
**Cloud:** Firebase Auth, Firestore, Cloud Storage, Gemini API, optional Google Maps Geocoding

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

1. `GeminiIntentParser` attempts structured `SearchIntent` extraction.
2. If Gemini is unavailable or invalid, the deterministic parser extracts supported sport, locality, date, time, skill range, and style. It handles phrases such as "around me," "this Saturday," "tomorrow," numeric ranges, and clock times without confusing time with skill.
3. Localities are geocoded through Google Maps when configured, with Bangalore fallback coordinates.
4. `search_sessions` filters by sport, open capacity, date, time overlap, coordinate distance/travel radius, skill overlap, and exact style when requested.
5. Python ranks eligible sessions and produces evidence such as skill fit, distance, availability, reliability, and familiarity.
6. Gemini may summarize or order only the already-approved result IDs. Invalid or invented IDs are discarded.
7. No match returns a `GroupProposal`, not a fabricated group. The frontend keeps creation conversational and asks follow-up questions before explicit posting.

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

## 10. Verification and Deployment

Run `python -m unittest discover -s tests` for API, matching, lifecycle, CMR, waitlist, and tournament coverage. Run `npm run build` for the PWA production build. Use `COURTMATE_DATASTORE=memory` for isolated local development and `COURTMATE_DATASTORE=firestore` on Cloud Run. Required configuration includes Firebase project identity, allowed CORS origins, Gemini credentials, Google Maps key if geocoding is enabled, and Firestore service access.

Deferred infrastructure includes Pub/Sub reminders, BigQuery/Looker analytics, native push notifications, first-class Venue/Event entities, bracket tournaments, and a general-purpose agent tool loop. These should follow evidence from the chat-to-game and organizer workflows.
