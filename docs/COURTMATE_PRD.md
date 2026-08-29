# CourtMate
## The community layer for Bangalore's racket-sports boom

**Document type:** Product Requirements Document  
**Stage:** Hackathon MVP -> Bangalore pilot  
**Initial sports:** Pickleball and padel  
**Initial market:** Bangalore, starting with dense venue clusters such as Whitefield, Indiranagar, Koramangala, HSR, and Sarjapur  
**Booking:** Deliberately out of scope for the initial product

## 1. Product thesis

Bangalore is gaining racket-sports venues faster than communities are forming around them. A court can be full and still feel disconnected: games are coordinated in fragmented WhatsApp groups, new players do not know where they fit, organizers manually chase confirmations, and every venue has activity that the rest of the city cannot see.

CourtMate is the social operating system for racket sports. It helps people find the right game, build a regular group, see what is happening across venues, talk playful trash, track scores and outcomes, and turn casual sessions into ladders, events, and venue-level tournaments.

CourtMate is **not** a court-booking marketplace. Booking may eventually be a partner integration, but it is not the reason a player returns. The reason to return is that their people, games, rivalries, reputation, and next challenge live here.

### Positioning

> Find your people. Find your game. Make every court count.

### One-line description

> CourtMate is the social and competitive layer connecting racket-sports players, groups, and venues across Bangalore.

### What CourtMate knows that a booking app does not

- Who plays well together, not only who is available.
- Which groups are casual, social, intense, beginner-friendly, or tournament-ready.
- Who reliably shows up and who can rescue a game when someone drops out.
- What is happening at other venues right now and what players are missing.
- Which rivalries, scores, streaks, and group rituals make people come back.

## 2. Problem

### Player problems

- Finding a game at the right level is difficult, especially for solo players and newcomers.
- Existing groups are hidden inside private chats and are hard to discover.
- Players do not know whether a session will be social, competitive, beginner-friendly, or awkwardly mismatched.
- Scores, memorable moments, and rivalries disappear after the game.
- There is no lightweight way to follow activity across Bangalore's venues.

### Organizer and venue-community problems

- Organizers spend time collecting availability, filling dropouts, and balancing teams.
- A venue may have several disconnected groups with no shared community identity.
- Ad-hoc tournaments are managed through spreadsheets and chat messages.
- There is no simple view of repeat players, session health, group growth, or event participation.
- Venues can host games but struggle to create an active community that returns between bookings.

### The wedge

Player matching and game formation are the initial utility. Social identity, banter, cross-venue discovery, scores, and tournaments are the retention engine.

## 3. Goals and non-goals

### Hackathon goals

1. Demonstrate a player can describe the game they want and receive credible session or player recommendations.
2. Let an organizer create and publish a game session in minutes.
3. Show a complete flow from discovery to joining, score capture, banter, and a next-game recommendation.
4. Show how a venue can run a small tournament and maintain live standings.
5. Make the Bangalore venue network feel alive with realistic seeded activity.

### Pilot goals

- Build dense, repeat usage in a handful of Bangalore venue clusters rather than spreading thinly across every sport and area.
- Learn which matching signals predict a good game: skill, location, play style, reliability, familiarity, and post-game sentiment.
- Establish a trusted identity and participation history without claiming to replace official ratings.
- Create enough activity for cross-venue discovery and FOMO to become useful.

### Non-goals for the MVP

- Court inventory, court booking, payments, refunds, or venue ERP.
- Becoming an official DUPR or equivalent rating provider.
- Advanced coaching, video analysis, wearables, or automated line-calling.
- A city-wide public ranking that rewards popularity over participation quality.
- Launching every racket sport at once. The data model may support them, but the pilot should lead with pickleball and padel.
- Monetisation before there is meaningful usage and evidence of value.

## 4. Target users

### The solo player

Wants a suitable game nearby without joining ten WhatsApp groups. Needs confidence that the level, tone, and people will be a good fit.

### The regular group captain

Runs a recurring group, manages attendance, fills empty spots, shares updates, and wants a simple record of the group and its games.

### The venue community lead

Wants the venue to feel active beyond isolated bookings. Creates open sessions, highlights activity, and runs ladders or tournaments.

### The competitive regular

Wants scores, rivalries, standings, rematches, and a visible progression story without needing a formal league every week.

## 5. Product pillars

### 5.1 Match me into a game

Players can type or speak a request such as:

> “Find me a social intermediate padel game near Indiranagar on Saturday evening.”

CourtMate extracts sport, locality, time, level, group style, and player preferences. It recommends existing sessions first, then compatible players for a new session.

Recommendation reasons must be legible: “three players are in your area,” “the group plays at your level,” “two members are people you have played with,” or “this group has a strong show-up record.”

### 5.2 Create a game, not a booking

An organizer creates a session with:

- sport, venue, date, start time, and capacity;
- skill band and play style;
- public, group-only, or invite-only visibility;
- recurring group or one-off game designation;
- optional external booking link;
- optional game objective such as social mixer, practice, ladder night, or tournament warm-up.

CourtMate creates a shareable link and QR code. The organizer can approve join requests, invite friends, manage a waitlist, and recover from dropouts.

### 5.3 Make the venue feel alive

The home feed is a pulse of racket-sports activity, not a generic social feed. It shows useful, time-sensitive signals:

- games forming nearby;
- sessions filling up;
- “happening now” activity;
- venue highlights and community posts;
- recent results, streaks, and rematches;
- upcoming events and tournament registration deadlines.

Cross-venue activity is intentionally designed to create healthy FOMO: players should see the game they could have joined, the venue that is buzzing, and the next opportunity to participate.

Privacy defaults should keep exact personal location and private group content protected. Public activity is venue- and event-oriented, not a live location tracker.

### 5.4 Give every group a home

Each recurring group gets a lightweight group space with:

- member list and roles;
- group description and play style;
- upcoming and past sessions;
- chat, banter, reactions, and pinned updates;
- attendance and show-up history;
- scores, team results, and memorable moments;
- group leaderboard or ladder, if enabled;
- rematch and next-session actions.

The group is the core retention unit. A player may discover CourtMate through one game, but returns for their group.

### 5.5 Turn games into stories

After a session, confirmed players can record:

- final score and teams;
- winner or result type;
- fun and fairness feedback;
- optional highlight, photo, or banter post;
- whether they would play with this group again.

CourtMate should make the post-game action take less than 30 seconds. The output is a useful game card that can be shared back into the group and used to suggest rematches or better-balanced future games.

### 5.6 Run venue-level competition

Venue organizers can create events and tournaments with:

- registration and waitlist;
- singles or doubles participants;
- skill/category divisions;
- round-robin MVP draw;
- fixture schedule and score submission;
- opponent or organizer confirmation;
- live standings;
- venue leaderboard and event recap.

The tournament desk should be useful for a 8-16 player event before it attempts to support complex bracket formats. The product can later add ladders, seasons, inter-venue cups, and city-wide championships.

## 6. Core user journeys

### Journey A: Solo player to first game

1. Player opens a shared link or CourtMate directly.
2. Player selects pickleball or padel and describes the desired game.
3. CourtMate shows three explainable session recommendations.
4. Player views group tone, level, venue, open spots, and recent activity.
5. Player requests to join or asks CourtMate to form a new game.
6. Organizer approves; the player receives the session details and group access.
7. After the game, the player posts a result or quick feedback.
8. CourtMate suggests the next relevant game, rematch, or event.

### Journey B: Organizer fills a session

1. Organizer creates a session and shares the link.
2. Players join, invite friends, or enter the waitlist.
3. CourtMate surfaces fit and reliability signals to the organizer.
4. A cancellation opens a slot.
5. CourtMate suggests opt-in replacement candidates; organizer approves one.
6. The session closes with attendance and score capture.
7. The group sees a recap and a prompt to schedule the next session.

### Journey C: Venue creates a community moment

1. Venue lead publishes a “Friday Night Mixer” or tournament.
2. Existing groups and nearby players discover it in the venue feed.
3. Players register, form pairs, and see the field fill up.
4. CourtMate generates fixtures and standings.
5. Scores are confirmed during play.
6. The venue gets a shareable recap with winners, participation, and the next event.

## 7. Matching and intelligence

AI is the interface and orchestration layer. Deterministic backend logic remains the authority for constraints, permissions, capacity, and state changes.

### Matching inputs

- sport and skill level;
- location and travel radius;
- date and time availability;
- casual, social, or competitive preference;
- singles/doubles and preferred format;
- prior group or player familiarity;
- attendance reliability;
- fun and fairness feedback;
- event or tournament eligibility.

External ratings such as DUPR can be used when available, but CourtMate must also work with self-reported and provisional levels. CourtMate's own community signals should describe fit and participation, not present themselves as official skill ratings.

### Suggested scoring model for the pilot

- 30% skill and format fit
- 20% time and availability fit
- 20% distance and locality fit
- 15% play-style and group-tone fit
- 10% reliability and dropout risk
- 5% familiarity or social continuity

These weights are starting assumptions, not product truth. Store the underlying signals so they can be evaluated later.

### AI capabilities

- natural-language and short voice search;
- extracting structured session intent;
- calling bounded tools for sessions, groups, invitations, and replacements;
- explaining recommendations with stored evidence;
- summarizing group and venue activity;
- generating respectful banter prompts and event recaps;
- suggesting rematches, next sessions, and relevant tournaments.

### Guardrails

- AI cannot override capacity, privacy, organizer approval, or tournament rules.
- AI cannot invent scores, ratings, attendance, or player attributes.
- Recommendation explanations must cite stored signals.
- Unrated and low-confidence profiles are labelled clearly.
- Banter must be opt-in, visible to the relevant group or event, and reportable.
- No exact home location or sensitive personal inference is exposed.

## 8. MVP scope for the hackathon

### Must have

- Bangalore venue and locality discovery with seeded activity.
- Pickleball and padel session creation.
- Shared-link player join flow without installation.
- Text search, with voice as the demo differentiator if reliable.
- Explainable player/session recommendations.
- Organizer approval, waitlist, and one dropout replacement flow.
- Group space with lightweight chat/banter.
- Score and post-game feedback capture.
- Tournament creation, registration, round-robin fixtures, result confirmation, and standings.
- A feed that makes activity across venues visible.

### Should have

- QR code for venue posters and event check-in.
- Recurring groups and one-click rematch.
- Follow a player, group, or venue.
- Shareable result and event recap cards.
- Basic organizer metrics: fill rate, show-up rate, repeat players, and feedback.

### Later

- Native push notifications and WhatsApp sharing/integration.
- Ladders, seasons, inter-venue cups, and city-wide rankings.
- Team formation and dynamic balancing during sessions.
- Deeper stats once there is sufficient score and participation data.
- Venue analytics, sponsorships, memberships, and booking partnerships.

## 9. Data model additions

The current session and tournament entities are the foundation. The product should treat venue and group activity as first-class objects.

### Venue

`id, name, area, locality, latitude, longitude, sports, community_status, external_url`

### Group

`id, name, sport, venue_id, organizer_id, visibility, style, skill_band, member_ids, recurring_schedule, created_at`

### Session

`id, group_id, venue_id, sport, organizer_id, start_time, capacity, confirmed_player_ids, waitlist_ids, status, external_booking_url`

### Game result

`id, session_id, team_a_ids, team_b_ids, score, winner, submitted_by, confirmation_status, created_at`

### Community signal

`id, session_id, player_id, target_player_id, fairness, fun, would_play_again, created_at`

### Activity post

`id, scope_type, scope_id, author_id, type, body, media_url, visibility, reactions, created_at`

### Tournament

`id, venue_id, organizer_id, sport, category, format, registrations, fixtures, rules, status, recap`

## 10. Success metrics

### North-star metric

**Meaningful games per active player per month:** a confirmed session with attendance, score or feedback, or tournament participation.

This combines utility and repeat behaviour without optimizing for empty bookings or passive browsing.

### Pilot metrics

- session fill rate;
- time from game creation to full or viable session;
- percentage of dropouts replaced;
- player match acceptance rate;
- show-up rate;
- post-game feedback completion;
- would-play-again rate;
- repeat participation within 30 days;
- group creation and group survival after four weeks;
- cross-venue discovery and event conversion;
- tournament registration completion and result confirmation rate;
- organizer coordination time saved.

### Hackathon proof points

- A player reaches a viable recommendation in under three minutes.
- At least one dropout is replaced before the session.
- The demo records a result and produces a shareable recap.
- A venue tournament moves from registration to live standings.
- The feed shows enough seeded activity to make another venue feel worth checking.

## 11. Rollout strategy

### Phase 1: Dense pilot

Start with 5-10 cooperative venues across two or three connected Bangalore clusters. Seed and verify recurring groups, event calendars, and a small set of community captains. Optimize for density and repeat play, not geographic coverage.

### Phase 2: Community loops

Add recurring groups, venue pages, rematches, ladders, event recaps, and follow notifications. Give organizers simple templates for mixers and tournaments.

### Phase 3: Network effects

Introduce inter-venue challenges, city-wide events, richer player history, and better matching models trained on observed outcomes.

### Phase 4: Monetisation after evidence

Do not charge before the product has a habit and enough data to prove value. Potential paths to test later:

- venue community software subscription;
- paid tournament and event tools;
- sponsored venue challenges and brand activations;
- premium player membership for advanced stats, priority discovery, or event access;
- booking or payments partnerships as an optional layer.

The initial business model should follow the strongest demonstrated value, not force booking economics onto a community product.

## 12. Risks and mitigations

### Cold start

Empty feeds and empty games destroy trust. Launch with venue captains, seeded recurring sessions, and a small number of dense localities.

### Match quality

Bad first games cause churn. Show why a match was recommended, collect one-tap feedback, and let organizers define the group tone.

### Social toxicity

Competitive banter can become exclusionary. Make banter scoped, opt-in, reportable, and easy to mute; reward useful participation rather than abuse.

### False precision in ratings

Do not turn sparse feedback into a definitive player ranking. Separate skill, reliability, fun, and fairness signals, and label confidence.

### Venue dependency

Keep sessions and groups portable. A venue partnership should improve discovery, not make the core product unusable without a booking integration.

## 13. Demo narrative

An intermediate player in Whitefield opens a shared CourtMate link and asks for a social pickleball game on Sunday morning. CourtMate recommends a live session at a nearby venue, explains the group fit, and lets the player request to join.

The organizer sees the new request, approves it, and shares the group space. One player drops out two hours before the game; CourtMate finds an opt-in replacement with the right level, locality, and show-up history.

After the game, the players submit the score, rate the game for fun and fairness, and post a playful recap. The home feed shows that another venue is running a Friday mixer and that this group has a rematch forming. The organizer then opens a 12-player venue tournament, generates fixtures, and updates the live standings.

The final message is clear: CourtMate did not sell a court. It turned scattered court time into a living community with momentum.
