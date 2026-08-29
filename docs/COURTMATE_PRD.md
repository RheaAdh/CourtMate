# CourtMate Product Requirements

**Version:** Hackathon MVP
**Market:** Bangalore, beginning with Whitefield and nearby localities
**Category:** Racket-sports community, game discovery, and tournament operations

## 1. Product Thesis

CourtMate helps a player turn "I want to play" into a game with people they will enjoy. It is the intelligent group layer between social distribution channels such as WhatsApp and Instagram and booking platforms such as Playo, Hudle, or a venue's own system.

CourtMate does not replace court booking. It solves the harder social problem: finding a compatible group, keeping it alive as attendance changes, and creating a record of enjoyable play.

> **CourtMate: find your people, find your game, make every court count.**

## 2. Problem

- A player can find a court but not a reliable group at a similar level.
- WhatsApp groups lose structured knowledge when members change.
- Organizers manually collect confirmations, replace dropouts, and balance games.
- Players cannot judge whether a session is casual, social, competitive, or beginner-friendly.
- Scores, feedback, progress, rivalries, and tournament standings disappear after the game.
- Venues want full, enjoyable sessions and repeat communities, not only isolated bookings.

## 3. Target Users

**Solo player:** wants a credible game nearby without joining many groups.
**Organizer:** creates recurring or one-off sessions, approves players, and fills vacancies.
**Venue or community lead:** runs open games, tournaments, ladders, and venue activity.
**Regular competitor:** wants CMR progress, rematches, scores, and leaderboards.

## 4. MVP Experience

### 4.1 Chat-first home

The home page is a conversational concierge, not a form. A player types or uses push-to-talk voice:

> "Find a casual intermediate pickleball game near Whitefield this Sunday at 8 AM."

Gemini extracts sport, locality, date, time, skill, and mood. The assistant shows quick suggestions, a search loader, and result cards. It must understand follow-ups such as "make it more casual" or "show games after 7 PM." Questions unrelated to finding racket-sport games, players, courts, or the user's own performance are redirected without fabricated answers.

### 4.2 Match or create

Python applies deterministic filters for sport, coordinates/travel radius, date, time, open spots, skill overlap, play style, reliability, and familiarity. Existing open games appear first with understandable reasons. If no suitable game exists, the assistant proposes a named game using the search request, asks for missing details conversationally, allows edits through chat, and posts only after explicit confirmation. Booking remains an external link.

### 4.3 Group continuity

Each game has a persistent group space with confirmed players, pending requests, waitlist, member profiles, and a posting chat. Organizers approve requests, invite friends, and see replacements. Players can withdraw; the next waitlisted player can be promoted. A game closes after its end time.

### 4.4 Play, score, and CMR

In the group chat or home score flow, players can write who played and the score naturally, for example, "Ananya beat Kavya 11 to 8." Participating players confirm or dispute the result. Once confirmed, Python updates sport-specific CourtMate Rating (CMR) on a 0-100 scale. Players give qualitative feedback such as beginner, intermediate, or advanced rather than inventing a numeric skill rating. Profiles show active sports, CMR circles, green/red movement, recent games, activity calendar, and CMR history.

### 4.5 Social and tournaments

Players may share completed sessions with photos or videos, then like, comment, follow, and share. A venue organizer can create a racket-sports tournament, accept registrations and waitlist players, generate round-robin fixtures, enter or confirm scores, view a draw sheet, and see live standings. The organizer can correct a result; the leaderboard recalculates immediately.

## 5. Functional Requirements

- Firebase Google sign-in and profile bootstrap.
- Sport-aware support for pickleball, badminton, tennis, padel, squash, and table tennis.
- Google Maps coordinates for locality matching; never expose exact home coordinates.
- Responsive PWA behavior on phone, tablet, and desktop.
- Upcoming, pending, and history game views.
- In-app notifications for game matches, requests, approvals, follows, and tournament activity.
- Profile photo upload through protected cloud storage URLs; initials when no photo exists.
- Optional Gemini analysis of wearable screenshots attached to a completed game.
- Chat, search, and score actions must be usable without structured creation or score forms.

## 6. Safety and Trust

AI cannot override capacity, privacy, approval, score confirmation, or tournament rules. It cannot invent players, games, ratings, or performance metrics. Profiles expose approximate locality and consent-based social information only. Users can hide, block, or report where those controls are available.

## 7. Hackathon Demo and Success

The demo should show one complete story: search by voice, view compatible groups, request to join, approve the request, coordinate in chat, record and confirm a score, see CMR and leaderboard movement, then register for or create a tournament draw.

Primary signals are successful search-to-request conversion, organizer time to fill a game, confirmed attendance, repeat group participation, score completion, and tournament engagement.

## 8. Monetization Direction

Keep player discovery free. Monetize the organizer and venue layer first: recurring-group management, waitlist replacement, analytics, branded tournament pages, promoted open games, and retention insights. Avoid booking commissions until CourtMate has proven value independent of booking platforms.
