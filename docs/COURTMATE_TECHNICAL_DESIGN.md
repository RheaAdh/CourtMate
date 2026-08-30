# CourtMate Technical Design

**Status:** Hackathon MVP
**Frontend:** Next.js 15, React, TypeScript, responsive PWA
**Backend:** Python FastAPI on Cloud Run
**Data and AI:** Firebase Auth, Firestore, Cloud Storage, Gemini, Firestore native vector search with Vertex AI embeddings

## 1. Boundaries

The Next.js client owns presentation, voice capture, browser history, and optimistic interaction states. FastAPI is authoritative for authentication, privacy, authorization, matching, capacity, lifecycle, scores, feedback, CMR, social visibility, and tournament standings. Gemini parses language and explains verified records; it never mutates Firestore or decides access.

The same repository protocol supports Firestore in deployment and an in-memory repository for local tests. Existing response shapes for search, groups, requests, tournaments, feedback, and performance remain compatible with the client.

## 2. Chat And Search

`POST /v1/sessions/search` accepts natural language, optional prior context, and an optional mode. The flow is:

1. A deterministic scope guard accepts racket-sport discovery, courts, players, groups, tournaments, score/feedback entry, and the authenticated player’s performance. Other requests receive a short redirect.
2. Gemini extracts strict intent JSON: sport, date, time, locality, skill range, style, tournament intent, and requested action. A deterministic parser is the fallback.
3. Python applies hard filters for sport, status, visibility, capacity, authorization, date/time, skill, and area or travel radius. Similarity never replaces these checks.
4. The normalized request is embedded with `gemini-embedding-001`, `output_dimensionality=768`, and `RETRIEVAL_QUERY`. Firestore KNN uses cosine distance and metadata pre-filters to retrieve up to `COURTMATE_MAX_VECTOR_RESULTS` candidates.
5. Current session or tournament records are fetched again in batches. Python rechecks closed, full, cancelled, completed, private, out-of-range, or skill-incompatible records, then ranks by skill, time, distance, style, reliability, familiarity, and prior satisfaction.
6. Gemini receives only verified records, allowed actions, and the parsed intent. It returns a concise grounded message and card-compatible IDs. If no result is valid, it returns a conversational creation proposal, never a fabricated match.

When embeddings are disabled or unavailable, the deterministic matcher remains usable. Search timing is exposed through server logs and `X-Response-Time-Ms`; read-only status refreshes do not rebuild CMR or embeddings.

## 3. Vector Corpus

`search_documents` stores `id`, `source_type`, `source_id`, canonical `content`, a 768-dimensional `embedding`, filter metadata, `embedding_model`, and `embedding_version`. Canonicalizers generate text from structured sessions, tournaments, public player summaries, venues, and FAQ/policy records. They must use safe optional fields and never assume a tournament summary exists.

Index only open/upcoming public games, recurring group profiles, upcoming tournaments, public player summaries, venue information, and approved help content. Exclude contact details, exact home coordinates, private preferences, auth material, private conversations, and unauthorized membership data.

`python -m backend.rebuild_vector_index` idempotently reads source records, embeds canonical text, upserts current documents, deletes obsolete/cancelled entries, and records the model version. New or edited sessions and tournaments attempt synchronous upserts; operational writes succeed if indexing fails and the next rebuild repairs the index. A future production worker can use Pub/Sub and Cloud Run.

## 4. Data And Workflows

Firestore collections include `players`, `sessions`, `join_requests`, `chat_posts`, `feedback`, `notifications`, `follows`, `social_posts`, `social_comments`, `activity_proofs`, `tournaments`, `tournament_registrations`, `tournament_matches`, and `search_documents`.

Game states are `open`, `full`, `in_progress`, `completed`, and `cancelled`. Requests are `pending`, `approved`, `declined`, `waitlisted`, or `withdrawn`; capacity rules can promote the next waitlisted player. Group chat posts may contain parsed teams and scores. Participants confirm or dispute a result before CMR changes. Feedback is qualitative and score evidence is session-scoped.

CMR is calculated independently per supported sport on a 0-100 scale. Confirmed results update ratings, game counts, history, and deltas. Performance chat retrieves only the authenticated player’s own history, completed games, feedback, and wearable proofs.

Tournaments use request-based registration and editable fixtures. Organizer or authorized match players submit scores; standings and draw data are recalculated from stored matches after every accepted edit. Social session activity and share-card generation use the verified leaderboard.

## 5. Client Navigation And Privacy

The client uses browser-history pages, not modal overlays, for settings, notifications, calendar, Connections, and public profiles. Connections calls `GET /v1/me/following` and `GET /v1/me/followers`, with profile navigation and follow/unfollow actions. The mobile sport selector is a horizontal list sourced only from the six CourtMate sports; missing profile photos render initials.

Voice input uses browser speech recognition and feeds the same chat pipeline as typing. Home supports active-game score selection and post-game feedback mode. Social media uploads require a tagged game for session photos/videos; profile and wearable images use protected Cloud Storage URLs.

## 6. API, Security, And Operations

Core routes include `/health`, `/v1/me`, `/v1/me/profile`, `/v1/me/following`, `/v1/me/followers`, `/v1/sessions/search`, `/v1/groups`, `/v1/sessions/{id}/join`, `/v1/sessions/{id}/leave`, `/v1/sessions/{id}/group`, `/v1/sessions/{id}/chat`, `/v1/sessions/{id}/feedback`, `/v1/sessions/{id}/leaderboard`, `/v1/me/performance-chat`, `/v1/social/*`, and `/v1/tournaments/*`. Search may return a non-sensitive retrieval trace with mode, candidate count, grounded result count, and embedding version; embeddings never reach the browser.

FastAPI verifies Firebase ID tokens and enforces organizer, member, player, follower, and tournament permissions. Vector similarity is not an authorization boundary. Exact home coordinates and private group data are never exposed. Cloud Run uses Application Default Credentials with `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`, `GOOGLE_GENAI_USE_VERTEXAI=true`, and Vertex AI/Firestore service roles. Set a billing alert and caps such as `COURTMATE_MAX_VECTOR_RESULTS=20`, `COURTMATE_MAX_SESSION_READS=100`, and `COURTMATE_MAX_PLAYER_READS=500`.

## 7. Verification

Run `npm run build`, `python -m unittest discover -s tests`, and vector tests with a fake embedding provider. Evaluate 40-60 queries covering exact and paraphrased searches, voice language, tournaments, follow-ups, no-match creation, score/feedback, performance, and unrelated prompts. Require relevant top-five retrieval, no closed/full false results, grounded responses, correct actions, and out-of-scope rejection.
