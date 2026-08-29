COURTMATE
Technical Design, Architecture & Decisions
Product
Pilot
Status
Pickleball group discovery & session continuity
Whitefield, Bengaluru
Hackathon MVP implementation baseline


ARCHITECTURE PRINCIPLE   Use Gemini for language, orchestration, explanations, and personalization. Use Python for deterministic eligibility, ranking, permissions, and state changes.
1. Scope and System Goals
CourtMate is an organizer-led web application that sits between existing distribution channels such as WhatsApp and Instagram and existing booking platforms such as Playo or Hudle. It helps organizers form enjoyable pickleball sessions, keep them full when membership changes, and learn which groups produce repeat participation.
1.1 MVP Goals
Support one sport: pickleball.
Support one launch cluster: Whitefield, Bengaluru.
Let a player discover and join through a shared link without installing an app.
Use text or push-to-talk voice to search for sessions.
Use DUPR as an external skill signal when available, without rebuilding an official rating system.
Demonstrate dropout replacement and post-session learning.
1.2 Non-Goals
CourtMate will not book courts, process payments, scrape DUPR, replace WhatsApp, provide public rankings, or require a native mobile app for the first release. Official DUPR integration is a later partnership track, not an MVP dependency.
1.3 System Quality Targets
Target
MVP Expectation
Response time
Return seeded search results in under 2 seconds; Gemini response within an acceptable conversational wait.
Explainability
Every recommendation shows stored reasons such as rating band, availability, distance, and group fit.
Safety
No private contact details are exposed without mutual consent; organizers approve replacements.
Recoverability
A single player decline or dropout does not break the session flow.

2. High-Level Architecture
The frontend is a mobile-first PWA. Firebase handles identity and hosting. Cloud Run exposes a Python API that owns business rules and calls Gemini. Firestore is the operational source of truth. Pub/Sub, BigQuery, and Looker Studio are optional supporting services and can be added after the core demo works.
Player browser / PWA
        | Firebase Auth + HTTPS
        v
Firebase Hosting -----> Python API on Cloud Run
                              |
                              +--> Gemini via google-genai
                              |
                              +--> Firestore
                              |
                              +--> Pub/Sub (optional events)
                              |
                              +--> BigQuery (optional analytics)
 
External booking link: Playo / Hudle / venue


2.1 Component Responsibilities
Component
Responsibility
MVP Status
Next.js PWA
Search UI, voice capture, group cards, join flow, organizer console.
Required
Firebase Auth
Phone OTP and Google sign-in; guest access for public session previews.
Required
Cloud Run API
Authentication, validation, matching, tool execution, feedback, audit events.
Required
Gemini
Intent extraction, function calling, explanations, summaries, next-session suggestions.
Required
Firestore
Players, groups, sessions, invitations, preferences, feedback, audit metadata.
Required
Pub/Sub
Reminder and replacement events when asynchronous behavior is needed.
Optional
BigQuery / Looker
Fill rate, repeat attendance, fun, fairness, and organizer metrics.
Optional


DEPLOYMENT BOUNDARY   The browser never calls Gemini directly in the production path and never receives a Gemini secret. All model requests pass through the authenticated Cloud Run API.
3. Request and Session Flows
3.1 Voice Search
The player presses and holds the microphone button and speaks a short request.
The frontend sends audio or transcript plus the player context to Cloud Run.
Gemini converts the request into a strict SearchIntent object.
Python validates the object, applies defaults, and calls the deterministic search service.
Gemini receives only the eligible results and creates a concise explanation.
The frontend renders open groups, similar groups, and compatible players.

3.2 Dropout Replacement
cancel(session_id, player_id)
  -> transaction: mark player cancelled; increment open_slots
  -> rank eligible opt-in players
  -> organizer approves candidate
  -> send invitation with expiry
  -> acceptance transaction confirms player
  -> audit replacement outcome


3.3 External Booking
CourtMate stores an organizer-provided booking URL and displays it after the group is sufficiently formed. The MVP does not automate booking or depend on Playo, Hudle, or venue APIs. This keeps the demo focused on group formation and avoids fragile external integrations.
3.4 State Model
Object
States
Group
draft, published, paused, archived
Session
open, full, in_progress, completed, cancelled
Invitation
pending, accepted, declined, expired, withdrawn
Player membership
invited, waitlisted, approved, confirmed, attended, cancelled

4. Data Design and Matching
4.1 Firestore Collections
Collection
Important Fields
Access
players
display_name, area, dupr_rating, rating_source, rating_updated_at, availability, style, privacy
Owner; limited organizer view
groups
organizer_id, skill_band, recurring_schedule, style, venue_link, member_ids
Organizer; public summary
sessions
group_id, start_time, capacity, confirmed_ids, open_slots, status
Participants; organizer control
invitations
session_id, sender_id, recipient_id, status, expires_at
Sender and recipient
feedback
session_id, player_id, fun, fairness, would_return, created_at
Participant; aggregate organizer view
events
actor_id, action, entity_id, timestamp, metadata
Server only; audit and analytics


4.2 DUPR and Unrated Players
CourtMate stores a DUPR reference and its provenance, not a competing official rating. A player may be rated, unrated, organizer-confirmed, or represented by synthetic demo data. Unrated players can join beginner or organizer-approved sessions and can be matched using provisional evidence, but the UI must never present a local score as a DUPR rating.
4.3 Deterministic Ranking
eligibility = capacity_ok and consent_ok and availability_overlap
 
score = 0.35 * skill_fit
      + 0.20 * availability_fit
      + 0.15 * distance_fit
      + 0.15 * group_compatibility
      + 0.10 * attendance_reliability
      + 0.05 * familiarity


Hard filters run before scoring. Skill fit uses the organizer's session band and DUPR where available. Group compatibility is learned from explicit fun, fairness, would-return, repeat participation, and opt-in behavior. The weights are configuration, not model output, so organizers can understand and tune them.
DECISION BOUNDARY   Gemini may explain or personalize a result, but it cannot qualify a player, override capacity, change membership, or invent evidence.
5. Gemini and API Design
5.1 Structured Intent
{
  "intent": "search_sessions",
  "sport": "pickleball",
  "area": "Whitefield",
  "date": "2026-08-30",
  "time_window": ["08:00", "12:00"],
  "skill_band": {"min": 3.0, "max": 3.5},
  "style": "casual",
  "needs": ["open_group"]
}


Gemini must return schema-valid JSON. Missing details produce a clarification question rather than an invented default, except for safe defaults such as the player's saved area or preferred sport.
5.2 Tool Contracts
Tool
Input
Output
search_open_sessions
Validated SearchIntent
Ranked session cards with evidence
find_compatible_players
Session id plus candidate constraints
Eligible candidates and score breakdown
send_invitation
Session id, recipient id
Pending invitation with expiry
suggest_replacement
Session id
Ranked opt-in candidates; no state change
record_feedback
Session id and ratings
Stored feedback event and updated aggregates
recommend_next_session
Player id
Personalized session shortlist and reasons


5.3 Prompt and Model Controls
Use a system prompt that defines CourtMate's scope, privacy rules, and tool boundaries.
Pass only the minimum player and session fields needed for the current request.
Use low temperature for intent extraction and tool selection; use a slightly higher setting only for explanations.
Validate all model output with Pydantic before any tool executes.
Log model latency, tool selection, validation failures, and fallback usage without logging private voice content by default.
FAILURE BEHAVIOR   If Gemini is unavailable, the player can still browse deterministic open-session filters. AI enhances the workflow but does not make the core session data inaccessible.
6. Security, Privacy, and Operations
6.1 Security Requirements
Use Firebase Authentication identity tokens and verify them server-side on every protected API request.
Use Firestore security rules for client-readable public summaries; sensitive writes go through Cloud Run.
Keep Gemini credentials in Secret Manager locally or use Vertex AI Application Default Credentials on Cloud Run.
Use approximate area or neighborhood, never exact home location, for discovery and ranking.
Require explicit opt-in before revealing direct contact details or sending invitations.
Provide block, report, hide-profile, and leave-group actions in the data model even if the UI is minimal.
6.2 Observability
Signal
Implementation
Request tracing
Cloud Logging correlation id across frontend request, API, Gemini call, and tool execution.
Business events
Server-generated events for search, join, invite, decline, replacement, attendance, and feedback.
AI health
Latency, token usage, schema failures, tool errors, and fallback rate.
Product health
Open slots, fill rate, replacement time, repeat attendance, fun, fairness, and would-return.


6.3 Cost Controls
Use seeded data and short voice inputs for the hackathon. Limit request size, cap conversation history, cache deterministic search results, and avoid sending large Firestore documents to Gemini. Start with Firestore and Cloud Run; enable BigQuery export only when analytics requirements justify it.
6.4 Deployment
Create a Google Cloud project, enable Cloud Run, Firestore, Secret Manager, and optionally Pub/Sub.
Deploy the Python API as a container with a health endpoint and environment-based configuration.
Deploy the Next.js PWA through Firebase Hosting or the selected Google-supported hosting path.
Seed synthetic Whitefield groups and run the end-to-end demo against the deployed services.
7. Architecture Decisions
Decision
Choice
Why
Tradeoff
Frontend
Next.js PWA
Fast mobile web flow from WhatsApp links; no install barrier.
Less native device integration.
Backend
Python on Cloud Run
Matches Python matching logic and scales without server management.
Requires container and deployment setup.
Operational database
Firestore
Simple document model for groups, sessions, invitations, and realtime UI updates.
Complex analytics belongs elsewhere.
AI SDK
google-genai
Official Gemini path with structured output and tool calling.
Model behavior still needs validation and fallback.
Skill source
DUPR reference plus provenance
Avoids rebuilding a mature rating network and improves credibility.
Integration may require future partnership work.
Matching
Deterministic Python ranking
Auditable, testable, and safe for eligibility and capacity.
Less adaptive than end-to-end ML initially.
Booking
External URL only
Keeps MVP focused and works alongside Playo, Hudle, or venue booking.
No booking commission or availability sync initially.
Async work
Synchronous first; Pub/Sub later
Reduces demo complexity while preserving an event path for reminders and replacements.
Some notifications are not production-grade yet.


7.1 Known Risks and Mitigations
Risk
Mitigation
Cold start and limited credibility
Organizer-led links, verified organizer identity, seeded venue scenario, and no-install join.
Unrated or inaccurate skill data
Show provenance and confidence; organizer approval; recommend DUPR result logging later.
Low network density
Start with one venue cluster and optimize replacement/waitlist workflows before broad discovery.
Gemini hallucination or tool misuse
Strict schemas, deterministic eligibility, evidence-based explanations, and audit logs.
External platform dependency
Use booking links only; do not block the core group workflow on integrations.


IMPLEMENTATION ORDER   Build the organizer session, shared-link join, deterministic search, and replacement flow first. Add voice, explanations, and next-session personalization once the state transitions are reliable.

