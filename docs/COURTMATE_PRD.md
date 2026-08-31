# CourtMate Product Requirements

**Version:** Hackathon MVP, August 2026
**Market:** Bengaluru, beginning with Whitefield
**Category:** Racket-sports discovery, community, CMR, and activity sharing

## 1. Product Thesis

CourtMate helps a player find the right nearby game, join it with low friction, show up, rate the experience, and improve their sport-specific CourtMate Rating (CMR). It adds a portable layer of skill, quality, attendance, and motivation across fragmented sports communities.

> **Find community → join game → play → rate → improve CMR → get better matches.**

CourtMate is not a court-booking replacement. External booking providers and WhatsApp communities may remain useful distribution channels, while CourtMate owns the player fit, game record, feedback, and CMR loop.

## 2. Users And Problems

- **Solo player:** wants a credible nearby game with people at a compatible level.
- **Organizer:** wants to create a game, share it privately, approve players, coordinate attendance, and collect feedback.
- **Community player:** wants to discover active local circles without joining many unrelated groups.
- **Regular player:** wants sport-specific CMR, streak motivation, trajectory, reliability, and better recommendations.

Attendance is scattered across chat groups, skill labels are inconsistent, dropouts are difficult to replace, and games and feedback disappear after play. Existing sports communities do not provide a portable quality signal across groups.

## 3. Core Experience

### Home: Rally Circles

Signed-in players land on **Rally Circles**, with **Discover**, **Following**, and **My rallies** views. Completed game activity appears as a shared rally with the lineup, session leaderboard, CMR movement, reactions, comments, and optional session photos. My rallies is limited to the signed-in player’s completed games.

The home feed is activity-first, not a generic post composer. A player can follow another player, receive follow-request notifications, and accept or decline requests. Notification counts remain visible on the bell.

### Assistant and game creation

The Assistant accepts typed or voice requests such as “find an intermediate padel game near Whitefield this Saturday evening.” It returns verified games, group previews, and explicit creation proposals. It must not invent a player, venue, game, score, or rating.

Games also provides a structured create-game modal. The form validates that the start is after now and the end is after the start. It supports:

- sport, area, date, start time, and end time;
- sport-specific preferred player CMR range, defaulting to the creator’s CMR minus and plus 20;
- singles or doubles;
- total player capacity, with open spots derived automatically from confirmed players;
- casual, social, or competitive style;
- visibility: discoverable on Explore, followers can discover, or private link only.

### Games and Rally Circles

Games uses compact tabs for **Explore**, **My games**, **Pending**, and **Feedback**. Explore shows all eligible public games, ranked by fit and location, and supports text search, sport, CMR skill band, date, and time-of-day availability filters. Filters are applied with an explicit **See results** action.

Every confirmed game has a Rally Circle for the lineup, CMR, chat, waitlist, and completion. A confirmed player can mark the game complete. The game then moves to Feedback, where players rate every other player, submit match quality and satisfaction feedback, and upload session photos. After the feedback round, CMR is updated and the completed rally is published to Home with the leaderboard and photo carousel.

### Private games

Private games are designed for apartment groups, friends, and small communities. They do not appear in Explore and do not send nearby-player discovery notifications. The organizer can copy or share the Rally Circle link immediately. A friend opening the link can view the preview and request to join; the organizer approves the request in My games. Once confirmed, the friend participates in the same chat, completion, feedback, CMR, and Home-publishing flow as any other game.

The share link is the access path, but authorization, capacity, approval, lifecycle, and membership checks remain server-enforced.

### Communities

Communities is the player-first local matching layer. It shows:

- “Players like you nearby” density for the selected sport;
- a custom SVG/CSS radar map with the current approximate location, zoom, pan, distance rings, and aggregated neighbourhood hotspots;
- a five-kilometre default radius, with larger radius choices;
- a CMR compatibility toggle and sport selector;
- a community leaderboard scoped by sport and area;
- an optional collapsed directory of nearby courts and booking links.

The map never exposes individual player pins. Areas with fewer than three visible players are hidden, and displayed data is aggregated by neighbourhood. If location permission is denied, CourtMate uses saved profile coordinates, locality, or the Whitefield fallback.

The community leaderboard ranks quality rather than popularity. A community needs at least three completed games and five submitted ratings. Ranking signals include match quality, feedback completion, repeat play, reliability, CMR improvement, completed games, and active members. Private individual feedback is never exposed.

## 4. CMR, Motivation, And Profile

CMR is a 0–100 rating calculated separately for each sport. It is built from completed games and private peer feedback, not from a single person’s opinion. The product shows current CMR by sport, a trajectory graph with session name and rating on point hover/touch, CMR movement on completed rallies, a weekly play streak, and an activity heatmap.

Profiles are compact and combine the player card, sport-specific CMR, streak heatmap, trajectory, reliability, followers, and recent game activity without duplicate sections. Sign out is at the bottom of the profile page. Sporty avatars may be generated from a user-provided image and selected sport, but the original image remains optional.

## 5. Privacy, Trust, And Performance

Firebase authentication, authorized API calls, session visibility, private profiles, approximate location, capacity, and organizer approval protect players. Exact coordinates are not rendered in community views. PIN/ZIP or locality may be used as a lower-precision location alternative to GPS.

The app keeps light mode as the default and maintains readable dark mode. Mobile pages use responsive spacing, centered bold tabs, sticky navigation where appropriate, scrollable modals, and no accidental desktop margins. Loading states are contextual and should not wait indefinitely for unrelated APIs.

The primary success loop is: discover or create a game, share or request access, confirm the lineup, coordinate in a Rally Circle, play, complete, collect feedback, update CMR, publish the rally, and return for a better match.
