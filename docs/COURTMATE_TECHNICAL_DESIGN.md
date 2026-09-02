# CourtMate Technical Design

**Status:** Implemented hackathon MVP
**Frontend:** Next.js 16, React 19, TypeScript, responsive web app
**Backend:** Python FastAPI, deployable to Cloud Run
**Data and AI:** Firebase Authentication, Firestore or in-memory repository, Cloud Storage, Gemini, optional Firestore vector search

## 1. System Boundaries

The Next.js client owns presentation, navigation history, browser sharing, voice input, optimistic state, media previews, theme, maps, and responsive behavior. FastAPI is authoritative for authentication, authorization, session visibility, capacity, membership, lifecycle, feedback, CMR, notifications, social records, and rankings. Gemini parses intent and explains retrieved records; it cannot bypass API authorization or mutate Firestore directly.

The authenticated shell has five primary destinations: **Home**, **Games**, **Ask**, **Leaderboard**, and **Profile**. Utility panels include notifications, preferences, connections, activity history, and CMR explanation. A shared Rally Circle deep link can open a session preview without changing the authorization rules for member-only data.

The repository protocol supports Firestore in deployment and an in-memory implementation for local development and tests. Derived views must not become a second source of truth for sessions, membership, or CMR.

## 2. Google Cloud Architecture

### Request and data flow

```text
Next.js web app
  |-- Firebase Authentication: Google Sign-In and Firebase ID token
  |-- Google Maps JavaScript API: interactive game discovery
  |-- Google Calendar: prefilled upcoming-game event
  |
  +--> Cloud Run: FastAPI container
         |-- Firebase Admin: verify ID token
         |-- Cloud Firestore: authoritative application records
         |-- Cloud Storage: authorized media and activity evidence
         |-- Gemini: structured intent, grounded answers, multimodal analysis
         |-- Vertex AI embeddings: semantic query and document vectors
         +-- Firestore Vector Search: bounded candidate retrieval
```

Every AI or vector result returns to deterministic server validation before it reaches the client. A semantic match cannot override authentication, visibility, capacity, time, CMR bounds, or session lifecycle.

### Technology responsibilities

| Service | Runtime responsibility | Implementation evidence and fallback |
| --- | --- | --- |
| Firebase Authentication | Google Sign-In and player identity. | The Next.js client uses `GoogleAuthProvider`; FastAPI verifies bearer tokens with Firebase Admin. Local test headers are available only when authentication is explicitly relaxed. |
| Cloud Firestore | Primary operational database. | `FirestoreRepository` stores all core records. `COURTMATE_DATASTORE=memory` selects the test and offline fallback. |
| Cloud Storage for Firebase / Google Cloud Storage | User-owned image and activity files. | The API creates authorized upload paths and validates bucket URL, owner, content type, and size. Storage rules are included in `storage.rules`. |
| Gemini API | Natural-language and multimodal intelligence. | `google-genai` produces schema-bound `SearchIntent`, optional grounded prose, performance explanations, wearable extraction, and avatar options. Deterministic parsing and responses remain available if generation fails. |
| Vertex AI | Google Cloud-hosted Gemini and embeddings. | `GOOGLE_GENAI_USE_VERTEXAI=true` uses project and location credentials. `gemini-embedding-001` creates 768-dimensional search vectors. |
| Firestore Vector Search | Semantic candidate retrieval. | Sanitized projections are stored in `search_documents`; candidate IDs are re-read from authoritative collections and filtered again. Deterministic retrieval is the fallback. |
| Google Maps JavaScript API | Client-side map, markers, clusters, radius, and camera controls. | Loaded lazily with a restricted public browser key. The internal density illustration and game list remain usable if Maps cannot load. |
| Google Maps Geocoding API | Server-side locality-to-coordinate lookup. | A separately restricted server key enables geocoding; textual locality matching remains the fallback. |
| Cloud Run | Managed serverless API runtime. | The repository includes a Python 3.12 Docker image and a scale-to-zero `gcloud run deploy` profile. Secrets and service-account permissions remain server-side. |
| Google Calendar | Calendar handoff for confirmed sessions. | The client constructs a `calendar.google.com/calendar/render` URL from verified session details; no calendar write token is stored. |

### Gemini capabilities and grounding

`GeminiIntentParser` uses the configured Gemini model for four implemented workloads:

1. Convert natural-language game queries into a validated `SearchIntent` JSON schema.
2. Produce short grounded responses using only verified records supplied by the API.
3. Analyze an uploaded wearable screenshot and extract only visible duration, calories, distance, steps, and heart-rate evidence.
4. Generate optional sport-themed avatar choices from an authenticated player image.

The performance assistant may summarize the signed-in player's stored games, CMR trajectory, and activity evidence. It is restricted to CourtMate data and cannot perform real-time discovery unless the request enters the session-search flow.

### Vertex AI and vector retrieval

`GeminiEmbeddingProvider` embeds sanitized search documents and user queries with `gemini-embedding-001`. Firestore native vector search retrieves a bounded set of candidate document IDs. The API then:

1. re-reads the current source record from Firestore;
2. applies visibility and lifecycle rules;
3. enforces sport, date, time, distance, capacity, and CMR constraints;
4. ranks valid results with deterministic matching signals;
5. returns a retrieval trace indicating vector or fallback mode.

This is retrieval-augmented generation without granting the model direct database authority.

## 3. Implemented Domain Model

Core collections are:

- `players`
- `sessions`
- `join_requests`
- `chat_posts`
- `feedback`
- `notifications`
- `follows`
- `social_posts`
- `social_comments`
- `activity_proofs`
- `community_memberships`
- `search_documents`

`Session.status` is `open`, `full`, `in_progress`, `awaiting_feedback`, `completed`, or `cancelled`. `JoinRequest.status` is `pending`, `approved`, `declined`, `waitlisted`, or `withdrawn`. Session capacity is derived from confirmed player IDs; waitlisted player IDs remain ordered for promotion.

`Session.visibility` is `public`, `followers`, or `private`:

- public sessions may appear in Explore and notify compatible nearby players;
- follower sessions are discoverable only to eligible followers;
- private sessions are excluded from discovery and nearby notifications;
- organizers and confirmed members retain access regardless of discovery visibility.

The API requires Firebase identity for protected operations. `_member_session` protects member-only actions, while session preview access returns only the information needed to decide whether to join.

## 4. Discovery, Creation, And Registration

`POST /v1/sessions/search` parses natural-language requests and ranks verified session records. Deterministic filters enforce sport, lifecycle, visibility, capacity, date and time, CMR compatibility, locality or distance, and authorization. Vector retrieval can propose candidates but is never an access-control boundary.

`POST /v1/groups` creates a validated session from either an Ask proposal or the structured form. Supported fields include sport, area and optional coordinates, date, time or flexible window, duration, CMR band, style, rating mode, format, capacity, and visibility.

`GET /v1/me/explore` and `GET /v1/me/community-map` power list and map discovery. The map returns eligible game markers or clusters plus privacy-safe density. It uses Google Maps when the browser API is configured and an internal visual fallback otherwise. Search remains functional if the map provider is unavailable.

`POST /v1/sessions/{id}/join` enforces idempotent active membership behavior:

- an existing pending, approved, or waitlisted request returns a conflict rather than creating a duplicate;
- a private-link player is approved immediately when a seat is open;
- a full session places the player on the waitlist;
- other discoverable sessions create an organizer-reviewed request.

`POST /v1/sessions/{id}/leave` withdraws pending requests or removes confirmed and waitlisted players. If a confirmed player leaves, the server promotes the first waitlisted player and reopens a previously full session when appropriate.

`GET /v1/sessions/{id}/replacement` ranks possible substitutes by sport skill fit, distance or area, reliability, style, and player preferences.

## 5. Rally Circle, Completion, And CMR

`GET /v1/sessions/{id}/group` returns the authorized session view, confirmed public player profiles, ordered waitlist, and permitted activity proof. Group chat uses `GET/POST /v1/sessions/{id}/chat`. Flexible sessions can create a time poll and collect one vote per confirmed player.

The session lifecycle advances from scheduled states to `in_progress`, then `awaiting_feedback` after the end time or `POST /v1/sessions/{id}/complete`. The client places sessions requiring the current player's response at the top of Completed. Feedback submission is idempotent per player and session.

Feedback stores game quality and private lineup ratings. It contributes to experience and trust signals but does not directly change CMR. A competitive result uses two explicit sides, scores, and confirmation by every named participant. Only a valid fully confirmed result enters deterministic CMR replay. Casual sessions never change CMR.

CMR uses a canonical per-sport float in `1.00-10.00`. Unplayed sports display a locked `1.00` baseline. Confirmed competitive replay considers expected team strength, result, a bounded score-margin adjustment, and confidence. Earlier results can be replayed in stable date order, and the history stores session ID, rating, delta, game rating, confidence, and date.

Legacy `1-8` and `0-100` values are versioned by player and session scale fields and converted idempotently with:

```bash
PYTHONPATH=. python -m backend.migrate_cmr_to_10
```

## 6. Social, Profiles, And Leaderboards

`GET /v1/social/feed?feed=all|following|personal` returns visibility-filtered session activities and authored session posts. Social endpoints support media upload, creation, deletion by the author, likes, comments, and share-count updates. A shared post URL resolves back to the specific post; sharing does not generate a leaderboard image.

Media rendering preserves aspect ratio and uses cover or containment rules appropriate to the card instead of stretching the source. Uploads are restricted by MIME type, size, authenticated ownership, and session context.

Public player APIs expose a reusable profile view, follow state, request state, follower and following counts, activity, sport CMR, and privacy. A private profile returns the minimal identity card and relationship action but withholds detailed activity and ratings. Mutations update both the viewed profile and connections cache.

`GET /v1/me/circle-leaderboard?scope={circle|locality|bengaluru}&sport={sport}` powers the Leaderboard destination. The frontend preserves the scope tabs and changes sport through a compact selector. Rankings are sport-specific and link each row to the corresponding public profile.

## 7. Notifications And Client Synchronization

Notifications cover join requests, join decisions, follow requests and decisions, reminders, and completion or feedback actions. `GET /v1/me/notifications` includes unread count and source-derived action status; read and decision endpoints resolve the corresponding alert so stale actions are not displayed.

The client synchronization layer combines:

- immediate optimistic or successful-response state updates;
- targeted cache invalidation after every mutation;
- session-storage snapshots for initial rendering only;
- request deduplication per resource;
- five-second silent polling while the document is visible;
- refresh on focus and `visibilitychange`;
- no full-page reload for application state changes.

Refresh domains include activity, notifications, connections, social profile, feed, recommendations, leaderboard, and the open Rally Circle. If invalidation occurs during an active request, one follow-up refresh is queued. Equality guards prevent unchanged responses from triggering visible rerenders. Failed optimistic mutations roll back and show one automatically dismissing toast.

This polling baseline keeps cross-user chat, request, notification, profile, feed, and lineup state current without full-page reloads.

## 8. Privacy And Reliability

- Individual home coordinates are never rendered as public player pins.
- Density responses omit groups below the configured anonymity threshold.
- Location falls back from browser coordinates to saved profile locality and finally the Whitefield demo origin.
- Private sessions never enter public discovery or compatible-player broadcasts.
- Capacity, lifecycle, and visibility are rechecked on every mutation, not trusted from client state.
- Notification and social visibility is derived from the underlying source records.
- CMR updates are deterministic and cannot be triggered by likes, follows, private ratings, attendance, or casual sessions.
- Firebase ID tokens are verified on the server before protected reads or writes.
- Browser and server Maps keys are separated and restricted to their required APIs and origins.
- Gemini and Cloud credentials stay on Cloud Run; they are never embedded in the browser bundle.
- Cloud Run uses Application Default Credentials and least-privilege service-account roles for Firestore, Storage, and Vertex AI.

Every API response includes `X-Response-Time-Ms`. Slow derived work such as indexing and broad notifications may run as background tasks after the authoritative write. Client loaders are scoped to the affected component so polling never causes full-page loading screens.

## 9. Deployment Configuration

The implemented Google Cloud path uses these environment groups:

| Layer | Configuration |
| --- | --- |
| Firebase web client | `NEXT_PUBLIC_FIREBASE_*` |
| Browser Maps | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` |
| API origin and allowed web origins | `NEXT_PUBLIC_API_URL`, `COURTMATE_ALLOWED_ORIGINS` |
| Firestore and Cloud Run project | `COURTMATE_DATASTORE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` |
| Gemini generation | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| Vertex AI mode | `COURTMATE_USE_VERTEX_AI` or `GOOGLE_GENAI_USE_VERTEXAI` |
| Semantic search | `COURTMATE_VECTOR_SEARCH_ENABLED`, `GEMINI_EMBEDDING_MODEL`, `COURTMATE_VECTOR_DIMENSIONS` |
| Server Maps geocoding | `GOOGLE_MAPS_API_KEY` |
| Storage | `COURTMATE_PROFILE_BUCKET` or the Firebase project bucket |

Public `NEXT_PUBLIC_*` values are build-time browser configuration and must be domain-restricted. Gemini keys, Google Cloud credentials, signing identities, and server Maps keys belong only in Cloud Run configuration or its secret-management path.

## 10. Verification

Run:

```bash
npm run typecheck
npm run lint
npm run build
python -m compileall -q backend
PYTHONPATH=. pytest -q
git diff --check
```

Tests must cover:

- discovery visibility and map fallback;
- private-link direct join, duplicate prevention, capacity, and waitlist promotion;
- public request approval, decline, withdrawal, and notification resolution;
- lifecycle transitions and Completed warning counts;
- feedback persistence and interactive selected ratings;
- competitive-only CMR replay and casual-game exclusion;
- social post ownership, media aspect ratio, comments, likes, deletion, and deep-link sharing;
- private and public profile behavior, follows, connections, and leaderboard scopes;
- optimistic mutation updates, polling deduplication, hidden-tab pause, focus refresh, and rollback;
- mobile time inputs, navigation, dark-theme contrast, and absence of horizontal page gaps.
