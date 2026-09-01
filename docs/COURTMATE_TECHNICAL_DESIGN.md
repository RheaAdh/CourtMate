# CourtMate Technical Design

**Status:** Hackathon MVP
**Frontend:** Next.js 15, React 19, TypeScript, responsive PWA
**Backend:** Python FastAPI on Cloud Run
**Data:** Firebase Auth, Firestore, Cloud Storage, Gemini, optional Firestore vector search

## 1. Architecture And Boundaries

The Next.js client owns presentation, browser history, voice input, optimistic reactions, image previews, share-card rendering, theme state, and responsive navigation. FastAPI is authoritative for authentication, authorization, visibility, matching, capacity, lifecycle, feedback, CMR, notifications, and derived community scores. Gemini parses and explains verified records; it does not decide access or mutate Firestore directly.

The authenticated shell has four primary areas: **Home**, **Games**, **Profile**, and **Assistant**. Games → **Explore** is the map-led community discovery surface; Communities is retained only as a legacy routing alias that resolves to Games → Explore. Profile and utility pages are history-aware. The client uses the same repository protocol against Firestore in deployment and an in-memory repository in local tests.

## 2. Game Discovery And Creation

`POST /v1/sessions/search` parses a natural-language request, applies deterministic hard constraints, and ranks verified records. Hard constraints include sport, lifecycle, visibility, capacity, date/time, CMR/skill compatibility, area or travel radius, and authorization. Similarity is never an authorization boundary.

`GET /v1/me/explore` returns public or follower-visible open/full sessions that the current player is eligible to request. Private sessions are excluded unless the current player is already the organizer or a confirmed participant. Games → Explore loads `GET /v1/me/community-map?sport=all` by default around the player's approximate location and five-kilometre radius, then applies map filters for sport, radius, area, visibility, CMR fit, exact date, and time of day. Selecting a cluster or map point filters the returned game list to that location; the client never exposes individual player records.

`POST /v1/groups` creates a session. `CreateGroupRequest.visibility` accepts `public`, `followers`, or `private`; when omitted, the player’s `default_session_visibility` is used. Game creation validates future start time, end after start, CMR bounds, format, and capacity.

Private sessions are not sent through `_notify_players_about_game` and are not included in Explore or discovery indexing. The Group Space link uses the session ID, while the API still enforces authentication, capacity, approval, membership, and lifecycle rules. The shared preview can be opened before membership so a friend can submit a join request.

## 3. Group Lifecycle And CMR Loop

Relevant session states are `open`, `full`, `in_progress`, `awaiting_feedback`, `completed`, and `cancelled`. Join requests are `pending`, `approved`, `declined`, `waitlisted`, or `withdrawn`.

Group Space routes provide the session preview, member profiles, chat, join requests, leaderboard, feedback, and completion. A confirmed player can call `POST /v1/sessions/{id}/complete`. The server moves the session to `awaiting_feedback`; after the required feedback is collected, it marks the session completed and publishes the stable Home activity record. A competitive session may record one final two-sided score in chat. Every player in that result must confirm it before the server recalculates sport-specific CMR; casual sessions cannot update CMR.

Feedback stores match quality, satisfaction, optional return intent, and private ratings from each player for every other confirmed player. It contributes to community quality and trust signals, never directly to CMR. CMR replay is deterministic: each confirmed competitive result uses combined partner strength, opponent strength, win/loss/draw, and a bounded score-margin factor. Per-sport CMR confidence rises from confirmed result count, reducing the adjustment factor for established players. CMR history records the session, rating, delta, resulting game rating, confidence, and date. Home renders the session leaderboard and attached session media after publication.

### CMR Scale And Migration

The canonical CMR representation is a float in the inclusive `1.00–10.00` range. `Player.self_assessed_levels` stores an integer `1–10` selected by the player as an onboarding estimate, `cmr_starting_ratings` stores the stable per-sport seed, and `cmr_ratings` stores the current two-decimal value after confirmed results. A profile is **Starting level** at zero confirmed competitive games, **Provisional** below three, and **Verified** at three or more. The count comes from deterministic competitive-result replay, not casual attendance, private feedback, or the user-entered level. New-game and matching bands default to the player's CMR plus or minus `1.8`.

Legacy persisted values are versioned by `Player.cmr_scale` and `Session.skill_scale`. The migration accepts the historic `1–8` and `0–100` CMR formats and converts them deterministically to the canonical range; it is idempotent and touches only CourtMate `players` and `sessions` Firestore documents. Run `PYTHONPATH=. python -m backend.migrate_cmr_to_10`. Authentication records and raw external ratings are not mutated.

Competitive replay uses an expected-result denominator of `1.8` CMR points and a confidence-adjusted K factor from `0.90` for a new record to `0.36` for an established record. Only a valid, two-sided result confirmed by every named participant is replayed. Casual results and private feedback never modify CMR.

## 4. Communities And Aggregated Density

`GET /v1/me/player-density` accepts sport, latitude, longitude, radius, and optional CMR bounds. The default client radius is 5 km. `GET /v1/me/community-map` accepts `sport=all` as well as a specific sport and returns nearby public game markers/clusters, aggregated density, and activity in one response. The server returns aggregated neighbourhood points only, with player count, intensity, CMR range, coordinates suitable for a neighbourhood marker, and distance. It must:

- omit groups with fewer than three visible players;
- avoid individual player IDs and exact home coordinates;
- respect private profiles and the caller’s matching scope;
- fall back to saved locality or the Whitefield coordinates when GPS is unavailable.

The frontend renders Google Maps when the browser key and SDK are available, with an SVG/CSS fallback when they are not. Google Maps loading is client-only and lazy; map markers are public-game or privacy-safe aggregation markers. Latitude/longitude differences are converted to approximate kilometres using the latitude cosine correction. The 5 km radius is represented by the base map ring; zoom, pan, pinch, and reset update the map without changing the selected filters.

`GET /v1/me/community-leaderboard` accepts sport and optional area. It groups completed sessions by community, calculates quality signals, and returns entries only after three completed games and five ratings. Results are sorted deterministically by quality score and stable community identity. The client shows the leaderboard near the top of Communities, before the map, so it is visible on mobile. The optional facility directory is collapsed and fetches only when opened.

## 5. Data Model And Privacy

Core Firestore collections are `players`, `sessions`, `join_requests`, `chat_posts`, `feedback`, `notifications`, `follows`, `social_posts`, `social_comments`, `activity_proofs`, `community_memberships`, and `search_documents`.

`Session.visibility` is `public`, `followers`, or `private`. `_session_visible_to_player` permits the organizer and confirmed members, permits public sessions to discovery, permits follower sessions to the organizer’s followers, and excludes private sessions from discovery. `_member_session` protects member-only Group Space actions.

Player records include locality, optional latitude/longitude, travel radius, sport ratings, sport-specific CMR histories, reliability, profile visibility, and default session visibility. A future PIN/ZIP field may replace or supplement GPS as an approximate location input; it must never be returned as an exact player location in density responses.

Cloud Storage uploads use approved MIME types and size limits. Profile images, sporty-avatar source/output images, and session media are authorized separately. Session media requires a completed-game context and organizer or confirmed-player permission.

## 6. Social Feed And Notifications

`GET /v1/social/feed` supports all, following, and personal Rally Circles views. Session activity is visibility-filtered and includes session metadata, lineup, CMR leaderboard, reactions, comments, and media. Home posts are derived from completed sessions rather than generic free-form posts.

Notifications cover join requests, request decisions, follow requests and acceptance, upcoming booking reminders, and game completion/feedback prompts. Unread counts are returned by `/v1/me/notifications` and rendered on the top-right bell.

The client uses optimistic fire reactions, loads comments per post, and shares a formatted deep link or branded leaderboard image. Shared game text identifies the sport, date, time, area, and Group Space URL.

## 7. Performance And Operations

Reads should be bounded and cached where safe. Short-lived read caches are cleared after session, feedback, social, and community-score writes. CMR refreshes, notifications, and best-effort indexing may run as FastAPI background tasks so creation, completion, and feedback submissions do not wait for every derived view.

Every response includes `X-Response-Time-Ms` for diagnostics. The client uses contextual loaders and renders cached/stale Group Space data immediately while refreshing chat, players, waitlist, and leaderboard data in parallel. API failures show retryable inline states or concise toasts.

## 8. Verification

Run:

```bash
npm run build
python -m compileall -q backend
git diff --check
PYTHONPATH=. pytest -q
```

Tests must cover private games being absent from Explore, shared-link preview and join requests, visibility authorization, lifecycle transitions, all-player feedback, CMR updates, Home publication, community density privacy and five-kilometre filtering, location fallback, minimum leaderboard thresholds, stable ranking, map zoom/pan/reset, mobile layout, and existing search, social, media, notification, and profile flows.

## 8. Future Integration: DUPR

DUPR is a future, pickleball-only enrichment integration. It requires an approved DUPR partner relationship and a player-scoped consent/token flow. The public read-only contract can support a connected player's DUPR identity and rating sync; official match reporting requires separate partner or club authorization.

When enabled, store only the data required for matching and display: DUPR ID, singles/doubles rating, verified rating, provisional flags, reliability score, sync timestamp, and token metadata required for server-side refresh. Encrypt or otherwise protect partner credentials and refresh tokens, never expose them to the browser, and support disconnect/revocation.

`cmr_ratings["pickleball"]` remains CourtMate's own confirmed-result-derived rating. DUPR data is a separately labeled source that may seed new-player matching or serve as an additional ranking signal; it must not overwrite CMR, be used for non-pickleball sports, or be accessed through scraped or undocumented endpoints.
