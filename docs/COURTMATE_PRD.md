# CourtMate Product Requirements

**Version:** Hackathon MVP, August 2026
**Market:** Bengaluru, beginning with Whitefield
**Category:** Racket-sports discovery, community, CMR, and local tournaments

## 1. Product Thesis

CourtMate turns “I want to play” into a compatible real-world game. It solves the social coordination gap between a booking platform and a chat group: finding people at a similar level, keeping attendance reliable, recording what happened, and helping players return.

CourtMate is not a general-purpose chatbot or a court-booking replacement. Its assistant is intentionally limited to racket sports, courts, games, players, groups, tournaments, and the authenticated player’s own performance.

## 2. Users And Problems

- **Solo player:** wants a credible nearby game without joining many groups.
- **Organizer:** wants approvals, waitlist replacement, coordination, scores, and feedback in one place.
- **Tournament organizer:** needs request-based registration, editable local fixtures, draw sheets, and live standings.
- **Regular player:** wants sport-specific CMR, activity history, rematches, and shareable results.

Today, attendance is scattered across WhatsApp, skill labels are inconsistent, dropouts are difficult to replace, and scores, feedback, progress, and tournament results disappear after play.

## 3. Core Experience

### Chat-first home

The logged-in home is a clean chatbot, not a form. Players type or use voice to say what they want, for example: “Find a relaxed intermediate padel game near Whitefield Saturday morning.” The assistant asks only useful follow-ups, offers quick suggestion chips, shows a tennis-ball “Finding the best match” loader, and returns real game or tournament cards. Follow-up messages must preserve context and update the card, including when the player changes sport or area.

The assistant must reject unrelated questions politely. It must never invent a venue, player, game, score, or rating.

### Match, join, or create

Deterministic rules filter by sport, locality or travel radius, date, time, skill, style, capacity, privacy, and lifecycle. Cards support view group, request to join, join waitlist, and skip. A join request immediately appears as “Request sent” and is visible under Games.

When no suitable game exists, the assistant asks conversationally for missing sport, time, area, skill, and vibe. It shows a complete proposal and requires explicit confirmation before creating a game. After creation it confirms that the game is live and directs the player to Games. Creation must not depend on a structured form.

### Groups and performance

Every confirmed game has a private group space with member profiles, waitlist, venue/time/payment coordination, and voice-enabled chat. There is no “Log a match” form. Players can say who played and the score in the group chat or on Home after selecting an active game. Participants can agree or dispute the result. A separate conversational feedback mode collects fairness, fun, skill, and return intent after completion. Confirmed scores and feedback update sport-specific CMR.

### Social

Social is a lightweight, responsive activity feed rather than a doomscrolling network. Completed sessions are published as leaderboard activity so followers can see who played. Players can add an optional photo or video, like, comment, follow, and share. Share generates a polished CourtMate image containing the game and leaderboard, similar to a workout recap. Player avatars and ranking rows are clickable; missing photos use initials. Recommended players and Following/Followers live in a Connections page.

### Tournaments

The assistant searches tournaments as naturally as games. Tournaments have Explore, Upcoming, Pending, and History views. Organizers create tournaments from the tournament area, receive registration requests, maintain a waitlist, edit fixtures easily for local events, enter scores, and see the draw sheet and leaderboard update immediately.

## 4. Profile And Navigation

Profiles show bio, follower/following counts, reliability, activity calendar, recent sessions, and sport-specific CMR circles with up/down movement. The horizontal sport selector contains only active CourtMate sports: pickleball, badminton, tennis, padel, squash, and table tennis. No strength-training categories are shown.

Settings, Notifications, Activity Calendar, Connections, and public player profiles are pages with back arrows and browser-history navigation, not modals, so mobile swipe-back works. Sign out sits at the end of the profile screen. The UI must remain elegant and usable on phones, tablets, and monitors, with a compact mobile navigation and desktop left rail.

## 5. Trust And Success

Firebase sign-in, privacy controls, approximate locations, profile visibility, and session visibility protect players. AI cannot bypass authorization, capacity, privacy, approval, score confirmation, or tournament rules.

The demo success path is: voice search, inspect a fit, request to join, approve, coordinate, speak a score, confirm feedback, see CMR and leaderboard movement, and share the resulting activity image. Key signals are search-to-request conversion, confirmed attendance, repeat play, completed score/feedback, and tournament participation.
