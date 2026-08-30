# CourtMate Technical Design

**Status:** Hackathon MVP
**Frontend:** Next.js 15, React 19, TypeScript, responsive PWA
**Backend:** Python FastAPI on Cloud Run
**Data and AI:** Firebase Auth, Firestore, Cloud Storage, Gemini, Firestore native vector search with Vertex AI embeddings

## 1. Boundaries And Client Architecture

The Next.js client owns presentation, browser history, voice capture, theme state, file previews, optimistic social reactions, share-card rendering, and responsive navigation. FastAPI is authoritative for authentication, privacy, authorization, matching, capacity, lifecycle, scores, feedback, CMR, social visibility, and tournament standings. Gemini parses language and explains verified records; it never mutates Firestore or decides access.

The authenticated shell uses four primary tabs: **Home** for the social feed, **Games**, **Tournaments**, and **Assistant** for conversational discovery and performance queries. The logo is top-left, the profile avatar is top-right, and desktop uses a left rail while mobile keeps the tabs on one line with horizontal overflow handled without wrapping.

The same repository protocol supports Firestore in deployment and an in-memory repository for local tests. Existing response shapes for search, groups, requests, tournaments, feedback, performance, social posts, comments, and profiles remain compatible with the client.

## 2. Assistant, Search, And General Questions

`POST /v1/sessions/search` accepts natural language, optional prior context, an optional sport, and an optional mode. The flow is:

1. A deterministic scope guard accepts racket-sport discovery, courts, venue information, players, groups, tournaments, score/feedback entry, and the authenticated player’s own performance. General sports questions are routed to an informational answer without database recommendations. Unrelated requests receive a short redirect.
2. Gemini extracts strict intent JSON when enabled: sport, date, time, locality, skill range, style, tournament intent, and requested action. A deterministic parser is the fallback and is the normal low-latency path for common phrasing.
3. Python applies hard filters for sport, status, visibility, capacity, authorization, date/time, skill, and area or travel radius. Similarity never replaces these checks.
4. The normalized request is embedded with `gemini-embedding-001`, `output_dimensionality=768`, and `RETRIEVAL_QUERY`. Firestore KNN uses cosine distance and metadata pre-filters to retrieve up to `COURTMATE_MAX_VECTOR_RESULTS` candidates.
5. Current session or tournament records are fetched again in batches. Python rechecks closed, full, cancelled, completed, private, out-of-range, or skill-incompatible records, then ranks by skill, time, distance, style, reliability, familiarity, and prior satisfaction.
6. Gemini receives only verified records, allowed actions, and the parsed intent. It returns a concise grounded message and card-compatible IDs. If no result is valid, the client shows a complete creation proposal and requires explicit confirmation before creation.

Venue information such as “tell me about pickleball venues near me” is handled as a general assistant request, while explicit discovery such as “find a pickleball game near me” continues through matching. Follow-up context is only inherited when the new request is clearly related.

The Assistant supports typed and browser speech input, quick suggestion chips, a sport-aware active-game score picker, and a form-free conversational create flow. Games also exposes a direct create-game FAB and form for players who prefer structured entry.

## 3. Vector Corpus And Indexing

`search_documents` stores `id`, `source_type`, `source_id`, canonical `content`, a 768-dimensional `embedding`, filter metadata, `embedding_model`, and `embedding_version`. Canonicalizers generate text from structured sessions, tournaments, public player summaries, venues, and FAQ/policy records using safe optional fields.

Index only open/upcoming public games, recurring group profiles, upcoming tournaments, public player summaries, venue information, and approved help content. Exclude contact details, exact home coordinates, private preferences, auth material, private conversations, and unauthorized membership data.

`python -m backend.rebuild_vector_index` is idempotent: it reads source records, embeds canonical text, upserts current documents, deletes obsolete/cancelled entries, and records the model version. New or edited sessions and tournaments attempt best-effort indexing. Operational writes still succeed if indexing fails; a later rebuild repairs the index. A future worker can use Pub/Sub and Cloud Run.

## 4. Data Model And Workflows

Firestore collections include `players`, `sessions`, `join_requests`, `chat_posts`, `feedback`, `notifications`, `follows`, `social_posts`, `social_comments`, `activity_proofs`, `tournaments`, `tournament_registrations`, `tournament_matches`, and `search_documents`.

Game states are `open`, `full`, `in_progress`, `completed`, and `cancelled`. Requests are `pending`, `approved`, `declined`, `waitlisted`, or `withdrawn`; capacity rules can promote the next waitlisted player. Confirmed games expose group chat, member profiles, organizer requests, replacements, local leaderboards, feedback, and activity proofs.

Players select an active game before logging a score from Home. Group chat can parse a result into two teams, restrict players to confirmed members, and require confirmation from the involved players before CMR changes. Feedback stores fun, fairness, return intent, optional player skill levels/comments, and optional team scores.

CMR is calculated independently per supported sport on a 0-100 scale. Confirmed results update ratings, game counts, history, and deltas. Performance chat retrieves only the authenticated player’s own history, completed games, feedback, and wearable proofs.

### Social data and permissions

Social feed entries are authored posts or verified session activity. `SocialPostView` includes author, sport, optional media, like/comment/share counts, the viewer’s reaction, session metadata, session players, session status, and a CMR leaderboard. Feed visibility respects public/follower/private session settings and private profiles.

Media rules are enforced in both client and API layers:

- a text post may be created through the Home FAB;
- an image or video must reference a game and match its sport;
- only the organizer or a confirmed participant can tag that game;
- only confirmed session players see the Add photo control for a session activity post;
- profile images and social media use approved Cloud Storage URLs and size/type limits.

The client uses optimistic fire reactions and rolls back on failure. Comments load per post and can navigate to the commenter’s public profile. Sharing increments the API share count, renders a 1080x1350 branded leaderboard/post PNG in the browser, uses the native share sheet when available, and otherwise downloads the image and copies a deep link.

### Tournaments

Tournaments use request-based registration and editable fixtures. Organizer or authorized match players submit a match score. Optional `set_scores_a` and `set_scores_b` arrays contain up to seven set scores; the service validates each pair, derives the match score from sets won, and recalculates standings. Changing a fixture pairing or round clears its prior result and reopens a completed tournament when necessary.

## 5. Profile, Privacy, And Theming

Profile data includes a 240-character bio, profile image URL, sport skill levels and CMR histories, games played, follower/following counts, reliability, activity heatmap, and recent games. `GET /v1/players/recommended` returns sport/area/activity-compatible public players who are not already followed. `GET /v1/me/following` and `GET /v1/me/followers` power the Connections tabs. Public profiles provide follow/unfollow and expose only authorized recent activity, ratings, and counts.

`POST /v1/me/profile` updates preferences, bio, sport ratings/skill levels, and privacy defaults. `POST /v1/me/profile-image/upload-url` creates a time-limited upload target and `POST /v1/me/profile-image` persists the resulting URL. Private profiles are excluded from recommendations and public player pages. Session visibility is `public`, `followers`, or `private`, with the player default applied when creating a game.

The client stores the selected theme under `courtmate-theme` and mirrors it to `html[data-theme]`. Light and dark brand images are selected with CSS; the manifest, favicon, and Apple icon use the CourtMate icon assets in `public/`. Theme-specific tokens cover surfaces, borders, controls, social cards, settings, tabs, and action contrast.

All asynchronous surfaces use the shared tennis-ball loader with contextual labels: matching, refreshing Games, loading social, opening group space, loading rankings, loading tournaments, connections, and other utility pages. Errors offer an inline retry or a clear toast instead of leaving an empty or misaligned state.

## 6. API, Security, And Operations

Core routes include `/health`, `/v1/intent/parse`, `/v1/me`, `/v1/me/profile`, `/v1/me/profile-image/*`, `/v1/players/recommended`, `/v1/players/{id}`, `/v1/me/following`, `/v1/me/followers`, `/v1/sessions/search`, `/v1/me/explore`, `/v1/me/games`, `/v1/me/requests`, `/v1/me/groups`, `/v1/me/incoming-requests`, `/v1/me/notifications`, `/v1/groups`, `/v1/sessions/{id}/join`, `/v1/sessions/{id}/leave`, `/v1/sessions/{id}/group`, `/v1/sessions/{id}/chat`, `/v1/sessions/{id}/feedback`, `/v1/sessions/{id}/leaderboard`, `/v1/sessions/{id}/complete`, `/v1/leaderboards/local`, `/v1/me/activity-proof/*`, `/v1/me/performance-chat`, `/v1/social/feed`, `/v1/social/posts`, `/v1/social/posts/{id}/like`, `/comments`, `/share`, and `/v1/tournaments/*`.

FastAPI verifies Firebase ID tokens and enforces organizer, member, player, follower, and tournament permissions. Vector similarity is not an authorization boundary. Exact home coordinates and private group data are never exposed. Uploaded media is restricted to approved storage hosts, MIME types, and size limits.

Every response receives `X-Response-Time-Ms` for diagnostics. Reads are bounded by `COURTMATE_MAX_SESSION_READS`, `COURTMATE_MAX_PLAYER_READS`, and `COURTMATE_MAX_TOURNAMENT_READS`. CMR refreshes, community-score refreshes, notifications, and vector indexing run as FastAPI background tasks where safe, so user-facing writes do not wait for all derived data.

Cloud Run uses Application Default Credentials with `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`, `GOOGLE_GENAI_USE_VERTEXAI=true`, and Vertex AI/Firestore service roles. Set billing alerts and caps such as `COURTMATE_MAX_VECTOR_RESULTS=20`, `COURTMATE_MAX_SESSION_READS=100`, and `COURTMATE_MAX_PLAYER_READS=500`.

## 7. Verification

Run:

```bash
npm run build
python -m compileall -q backend
git diff --check
python -m pytest -q
```

The test suite covers exact and paraphrased searches, venue and general sports questions, follow-ups, no-match creation, games, join/withdraw/waitlist/notifications, group chat score confirmation, feedback and CMR, performance chat, profile images, follows, recommendations, social posts/media authorization, fire reactions, comments, shares, tournaments, fixture edits, set scores, standings, and vector fallback behavior.

Use fixture-safe dates or freeze the clock for lifecycle tests. Fixed historical fixture sessions can otherwise appear completed when the suite is run after their seeded date, producing false failures in search and join scenarios. Browser smoke testing should cover signed-in Home, Assistant, Games, Tournaments, Profile, Connections, Settings, light/dark themes, mobile tab wrapping, loaders, comments, fire reactions, share fallback, profile navigation, and active-game score selection without mutating live Firestore data.
