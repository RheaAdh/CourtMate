# CourtMate Product Requirements

**Version:** Hackathon MVP, August 2026
**Market:** Bengaluru, beginning with Whitefield
**Category:** Racket-sports discovery, community, CMR, local tournaments, and activity sharing

## 1. Product Thesis

CourtMate turns “I want to play” into a compatible real-world game. It closes the gap between a booking platform and a chat group by finding players at a similar level, coordinating attendance, recording what happened, and helping players return.

CourtMate is not a court-booking replacement or an unrestricted general-purpose assistant. Its assistant supports racket-sport discovery, tournaments, courts and venue information, sports questions, groups, and the authenticated player’s own performance. It must not invent a venue, player, game, score, or rating.

## 2. Users And Problems

- **Solo player:** wants a credible nearby game without joining many groups.
- **Organizer:** wants approvals, waitlist replacement, coordination, and low-friction feedback in one place.
- **Tournament organizer:** needs request-based registration, editable knockout draws, winner advancement, optional set scores, draw sheets, and live standings.
- **Regular player:** wants sport-specific CMR, activity history, rematches, followers, and shareable results.

Today, attendance is scattered across chat groups, skill labels are inconsistent, dropouts are difficult to replace, and scores, feedback, progress, and tournament results disappear after play.

## 3. Core Experience

### Home activity feed

For signed-in players, the first tab is **Home** and shows the activity feed. It has Discover and Following views, synthetic/demo activity when configured, recommended players to follow, and activity-only posts from completed games. The former chat-first screen is now the **Assistant** tab and remains available through the chat icon. Home has no generic post composer.

Session activity is published as leaderboard content so followers can see when someone is playing, view the current or final CMR order, and open any player profile from the author, avatar, or ranking row.

### Assistant, match, join, or create

The Assistant is a conversational interface. Players type or use voice to say what they want, for example: “Find a relaxed intermediate padel game near Whitefield Saturday morning.” It asks only useful follow-ups, offers suggestion chips, shows a tennis-ball “Finding your best match” loader, and returns verified game or tournament cards.

Deterministic rules filter by sport, locality or travel radius, date, time, skill, style, capacity, privacy, and lifecycle. Cards support viewing the group, requesting to join, joining a waitlist, and skipping. A request immediately appears in Games and organizers receive an actionable notification.

When no suitable game exists, the Assistant asks conversationally for missing sport, time, area, skill, and vibe. It shows a complete proposal and requires explicit confirmation before creating a game. Creation must not depend on a structured form, although Games includes a form-based create-game FAB for players who prefer direct entry.

Informational sports and venue questions are answered without returning unrelated game results. Follow-ups retain context only when the new message is clearly related; unrelated questions are redirected instead of inheriting old search criteria.

### Games and groups

Games uses the same single-line tab navigator as Tournaments: **Explore, Upcoming, Pending, History**. Explore places suggested nearby games first, followed by the remaining results. The sport control contains only pickleball, badminton, tennis, padel, squash, and table tennis.

Every confirmed game has a full-page Group Space with member profiles, waitlist, venue/time/payment coordination, and voice-enabled chat. It is the main coordination surface before and after play. The organizer marks the game done to publish the activity to Home. After completion, each player can drag the other players into the order they felt played best, starting from sport CMR order, or mark someone as unable to judge; this updates sport-specific CMR without tedious score entry. Fun, fairness, and return intent remain lightweight check-in signals.

### Social activity and sharing

Social is a lightweight activity feed, not a doomscrolling network. Players can:

- share completed game activity from Group Space;
- attach a photo or video only when tagging a game they played in;
- add photos to a session leaderboard only as a confirmed participant;
- react with a fire icon, with an immediate filled-yellow state and updated count;
- view and add comments beneath every post;
- mark a game done from its Group Space to publish one activity card with the venue, date, sport, players, and current/final CMR order;
- share a post or creative leaderboard card through the device share sheet, including each player's CMR uptick or downtick;
- fall back to downloading a branded CourtMate PNG and copying a deep link;
- follow recommended players and open public profiles from avatars, comments, authors, and leaderboard rows.

Followers can see public or follower-visible session activity, subject to the organizer’s default visibility and the player’s private-profile setting.

### Tournaments

The Tournaments area has **Explore, Upcoming, Pending, and History** views with the same compact mobile tab treatment as Games. Organizers create single-elimination tournaments, receive registration requests, approve or decline players, maintain capacity and waitlists, generate seeded knockout draws, edit pairings, select the winner of each match from a player dropdown, and optionally enter match or per-set scores. Byes advance automatically, selected winners populate the next round, and standings and the draw sheet update from stored match results. Older round-robin tournaments remain readable for compatibility.

## 4. Profile, Settings, And Navigation

The top-left brand uses responsive CourtMate logo assets, including light and dark variants. The profile avatar is top-right. A sun/moon control switches between light and dark themes and persists the choice locally. Mobile navigation remains compact and keeps tab labels on one line; desktop uses a left rail.

Profiles show a short bio below the player name, a pencil overlay for changing the profile photo, games played, follower/following counts, reliability, activity calendar, recent sessions, and sport-specific CMR history. Connections has Following and Followers tabs. Public player profiles expose only authorized public activity and provide follow/unfollow actions.

Settings includes age, gender, locality, travel radius, play style, preferred age range, preferred genders, usual availability, private profile, and default game-session visibility: everyone nearby, followers of the organizer, or players in the game.

Settings, Notifications, Activity Calendar, Connections, group spaces, rankings, and public player profiles use history-aware pages with back arrows rather than fragile modal-only navigation. Sign out sits at the end of the profile screen.

## 5. Trust, Privacy, And Success

Firebase sign-in, approximate locations, profile visibility, session visibility, and authorization rules protect players. AI cannot bypass authorization, capacity, privacy, approval, score confirmation, or tournament rules. Uploaded profile, session, and activity-proof media must use approved storage locations and size/type limits.

The demo success path is: open Home, discover or follow a player, use Assistant to find a fit, request to join, approve, coordinate in the full-page Group Space, inspect the waitlist, mark the game done, submit a drag-ordered post-game check-in, see CMR and leaderboard movement on the same activity post, and share the leaderboard image.

Key signals are search-to-request conversion, confirmed attendance, repeat play, completed group feedback, follower engagement, tournament participation, and share-card usage. All loading states use the tennis-ball loader and should communicate the specific operation, such as finding a match, opening a group, loading rankings, or refreshing games.
