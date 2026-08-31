import os
import re
import base64
from datetime import date, timedelta
import logging

from .models import ActivityProofAnalysis, Player, SearchDecision, SearchIntent, Session, SessionRecommendation, Sport, rating_for_sport


logger = logging.getLogger(__name__)


class GeminiIntentParser:
    """Gemini adapter with a deterministic fallback when no key is configured."""

    _SPORT_TERMS = (
        "pickleball", "pickle ball", "badminton", "tennis", "padel", "squash",
        "table tennis", "table-tennis", "ping pong", "racket", "racquet",
    )
    _DISCOVERY_TERMS = (
        "court", "venue", "club", "group", "groups", "game", "games", "session", "sessions", "player", "players",
        "circle", "circles", "community", "communities", "hub", "hubs", "network", "active players",
        "partner", "teammate", "opponent", "people to play", "open spot", "skill", "level",
        "waitlist", "play with", "looking to play", "want to play", "rally", "rallies",
    )
    _DISCOVERY_ACTIONS = (
        "find", "search", "join", "invite", "organize", "organise", "create",
        "available", "availability", "reserve", "book", "show", "get", "explore",
    )
    _TIME_TERMS = (
        "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "weekend",
        "weekday", "saturday", "sunday", "monday", "tuesday", "wednesday", "thursday",
        "friday", "next week", "after work",
    )
    _NON_COURT_TERMS = (
        "weather", "recipe", "restaurant", "movie", "news", "stock price", "politics",
        "capital of", "python", "javascript", "code", "translate", "joke", "flight",
    )
    _GENERAL_SPORT_TERMS = (
        "sport", "sports", "football", "soccer", "cricket", "basketball", "volleyball", "hockey",
        "baseball", "rugby", "golf", "athletics", "swimming", "running", "cycling", "boxing",
        "mma", "wrestling", "gymnastics", "track and field", "formula 1", "f1", "motorsport",
        "skiing", "snowboarding", "tennis", "badminton", "pickleball", "padel", "squash",
        "table tennis", "ping pong", "racket", "racquet", "dupr", "cmr", "utr",
    )
    _GENERAL_COURT_TERMS = (
        "court", "courts", "venue", "venues", "club", "clubs", "paddle", "shuttle",
        "net", "volley", "serve", "serving", "rally", "ball", "racket", "racquet",
        "kitchen", "dink", "spin", "backhand", "forehand", "smash", "drop",
    )
    _GENERAL_SPORT_QUESTION_TERMS = (
        "what", "why", "how", "explain", "rule", "rules", "tip", "tips", "improve", "difference", "strategy",
        "technique", "drill", "drills", "training", "practice", "score", "scoring", "serve", "grip",
        "equipment", "benefit", "compare", "best", "meaning", "definition", "who", "when",
        "can", "should", "tell me", "about", "describe", "overview", "information", "learn",
        "asking about", "warmup", "injury", "prevent",
    )

    _VENUE_INFORMATION_PATTERNS = (
        r"\btell me about\b",
        r"\basking about\b",
        r"\b(?:i am|i'm|im) asking\b",
        r"\binformation about\b",
        r"\bwhat are the\b",
        r"\bwhich are the\b",
        r"\brecommend(?:ed)?\b",
        r"\bwhere can i play\b",
        r"\b(?:venue|venues|club|clubs)\s+(?:near|nearby|around|in)\b",
        r"\bhow (?:do|can) i (?:book|reserve|choose)\b",
        r"\b(?:cost|price|pricing|opening hours|amenities|surface)\b",
    )

    def __init__(self) -> None:
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self.use_gemini_intent = os.getenv("COURTMATE_USE_GEMINI_INTENT", "false").lower() in {"1", "true", "yes"}
        self.use_grounded_response = os.getenv("COURTMATE_GROUNDED_RESPONSE_WITH_GEMINI", "false").lower() in {"1", "true", "yes"}
        self._client = None
        use_vertex = os.getenv("COURTMATE_USE_VERTEX_AI", "false").lower() in {"1", "true", "yes"} or os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "false").lower() in {"1", "true", "yes"}
        try:
            from google import genai

            if use_vertex:
                self._client = genai.Client(
                    vertexai=True,
                    project=os.getenv("GOOGLE_CLOUD_PROJECT"),
                    location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
                )
            elif self.api_key:
                self._client = genai.Client(api_key=self.api_key)
        except (ImportError, ValueError, TypeError) as error:
            logger.warning("Gemini is unavailable: %s", error)
            self._client = None

    @property
    def image_analysis_available(self) -> bool:
        return self._client is not None

    @classmethod
    def is_in_scope(cls, query: str, context: str | None = None) -> bool:
        """Allow court-sport discovery and circle requests into the search workflow."""
        current = " ".join(query.lower().split())
        if not current:
            return False
        if any(term in current for term in cls._NON_COURT_TERMS):
            return False
        if cls._is_venue_information_query(current):
            return False
        lowered = f"{current} {context or ''}".strip()
        has_sport = any(term in lowered for term in cls._SPORT_TERMS)
        has_court_object = any(term in lowered for term in cls._DISCOVERY_TERMS)
        has_action = any(term in lowered for term in cls._DISCOVERY_ACTIONS)
        has_time_context = any(term in lowered for term in cls._TIME_TERMS)
        has_location_context = bool(re.search(r"\b(near|nearby|around|local|area|location|within|in)\b", lowered))
        has_play_intent = any(term in lowered for term in ("want to play", "looking to play", "people to play", "where can i play", "who can i play", "circles", "communities", "groups"))

        if re.search(r"\b(explain|what is|what are|why is|how does|rules? of|how to play)\b", current) and not re.search(r"\b(near|nearby|around|find|search|join|open|available|circles?|groups?|communities)\b", current):
            return False
        if has_action and has_court_object:
            return True
        if has_court_object and has_location_context:
            return True
        if re.search(r"\b(similar|like me|compatible|best fit|good fit|match me|matching)\b", current) and has_court_object:
            return True
        if has_play_intent:
            return True
        if context and (has_time_context or has_location_context or any(term in current for term in ("same", "another", "more", "only", "instead", "after", "before"))):
            return True
        return has_sport and (has_time_context or has_location_context or has_play_intent)

    @classmethod
    def is_general_sports_query(cls, query: str, context: str | None = None) -> bool:
        """Identify informational sports questions that do not need CourtMate records."""
        current = " ".join(query.lower().split())
        if not current or any(term in current for term in cls._NON_COURT_TERMS):
            return False
        if cls._is_venue_information_query(current):
            return True
        if cls.is_in_scope(current, context):
            return False
        has_sport = any(term in current for term in cls._GENERAL_SPORT_TERMS)
        has_court_topic = any(term in current for term in cls._GENERAL_COURT_TERMS)
        has_question_signal = "?" in query or any(term in current for term in cls._GENERAL_SPORT_QUESTION_TERMS)
        has_session_discovery_request = bool(
            re.search(r"\b(find|search|show|join|invite|create|book|nearby|around|available)\b", current)
            and re.search(r"\b(game|games|group|groups|session|sessions|player|players|people|match|matches)\b", current)
        )
        return (has_sport or has_court_topic) and has_question_signal and not has_session_discovery_request

    @classmethod
    def _is_venue_information_query(cls, query: str) -> bool:
        """Detect informational venue questions without stealing court discovery."""
        has_venue = bool(re.search(r"\b(court|courts|venue|venues|club|clubs)\b|\bwhere can i play\b", query))
        has_information_signal = any(re.search(pattern, query) for pattern in cls._VENUE_INFORMATION_PATTERNS)
        has_game_request = bool(re.search(r"\b(find|search|show|join|create|book)\b.*\b(game|games|group|groups|session|sessions|match|matches|circles?)\b", query))
        return has_venue and has_information_signal and not has_game_request

    def parse(self, query: str, sport: Sport | None = None, context: str | None = None) -> SearchIntent:
        parsed = self._fallback_parse(f"{query} {context or ''}")
        if self._client and self.use_gemini_intent:
            try:
                parsed_by_model = self._parse_with_gemini(query, context)
                return parsed_by_model.model_copy(update={"sport": sport}) if sport else parsed_by_model
            except Exception as error:
                logger.warning("Gemini intent parsing failed (%s); using deterministic fallback", error)
        return parsed.model_copy(update={"sport": sport}) if sport else parsed

    def _parse_with_gemini(self, query: str, context: str | None = None) -> SearchIntent:
        prompt = """You are a strict intent parser for CourtMate, a racket-sport game discovery app.
Extract only a session-search request into JSON matching this schema: sport, area, date, start_time, end_time, skill_min, skill_max, style, open_slots_required.
Supported sports are pickleball, badminton, tennis, padel, squash, and table_tennis. Use null for unknown values. Never answer the user, invent requirements, or infer a date, location, skill, or sport that is not stated. The result will be used only to filter a database.
Use the previous request only to resolve a reference such as "same time" or "make it more casual". Do not copy a previous requirement when the current request changes it.
Current request: """ + query + "\nPrevious request context: " + (context or "none")
        response = self._client.models.generate_content(model=self.model, contents=prompt, config={"response_mime_type": "application/json", "response_schema": SearchIntent.model_json_schema()})
        return SearchIntent.model_validate_json(response.text)

    def decide(self, query: str, intent: SearchIntent, sessions: list[Session], recommendations: list[SessionRecommendation], player: Player | None = None) -> SearchDecision:
        fallback_action = "join_existing" if recommendations else "create_group"
        fallback_name = f"{intent.area} {intent.style.title()} {intent.sport.replace('_', ' ').title()}" if not recommendations else None
        sport_name = intent.sport.replace("_", " ")
        location_clause = f" near {intent.area}" if intent.area else " nearby"
        fallback = SearchDecision(
            action=fallback_action,
            summary=(f"Found {len(recommendations)} {sport_name} group(s){location_clause} that fit your request." if recommendations else f"No open {sport_name} group matches all of those requirements. You can create the first group and invite nearby players."),
            ranked_session_ids=[item.session.id for item in recommendations],
            proposed_group_name=fallback_name,
        )
        if recommendations:
            lead = recommendations[0].session
            date_label = lead.session_date.strftime("%a %d %b")
            time_label = f"{lead.start_time.strftime('%I:%M %p').lstrip('0')}–{lead.end_time.strftime('%I:%M %p').lstrip('0')}"
            return fallback.model_copy(update={
                "summary": f"I found {len(recommendations)} {sport_name} game{'s' if len(recommendations) != 1 else ''} that fit. Best fit: {lead.group_name} on {date_label}, {time_label} in {lead.area}, with {lead.open_slots} spot{'s' if lead.open_slots != 1 else ''} open.",
            })
        return fallback

    def grounded_search_answer(self, query: str, intent: SearchIntent, recommendations: list[SessionRecommendation], matched_circles: list[dict] | None = None) -> str:
        """Explain verified Firestore records that survived retrieval and Python validation."""
        sport_name = intent.sport.replace("_", " ").title()
        area_name = intent.area or "nearby"

        if matched_circles and len(matched_circles) > 0:
            circle_lines = []
            for circle in matched_circles[:3]:
                name = circle.get("name") or f"{circle.get('area')} {sport_name} Circle"
                players = circle.get("active_player_count", 0)
                games = circle.get("upcoming_game_count", 0)
                quality = circle.get("quality_score", 0.0)
                circle_lines.append(f"• **{name}** ({circle.get('area', area_name)}): {players} active players, {games} upcoming games (Quality score: {quality:.1f}/100)")
            circles_text = "\n".join(circle_lines)

            if recommendations:
                lead = recommendations[0].session
                return f"### {sport_name} Circles & Games in {area_name}\n\nHere are the active community circles in your area:\n{circles_text}\n\n• **Recommended match**: **{lead.group_name}** in {lead.area} with **{lead.open_slots}** spot{'s' if lead.open_slots != 1 else ''} open."
            return f"### {sport_name} Circles in {area_name}\n\nHere are the active community circles in your area:\n{circles_text}\n\nYou can request to join an active group or create a new rally to gather nearby players."

        if recommendations:
            lead = recommendations[0].session
            fallback = f"I found {len(recommendations)} {intent.sport.replace('_', ' ')} game{'s' if len(recommendations) != 1 else ''}. Best fit: {lead.group_name} in {lead.area} with {lead.open_slots} spot{'s' if lead.open_slots != 1 else ''} open."
        else:
            fallback = f"I could not find a {intent.sport.replace('_', ' ')} game matching those details in {area_name}."

        if not self._client or not self.use_grounded_response:
            return fallback

        records = [
            {
                "id": item.session.id,
                "type": "game",
                "name": item.session.group_name,
                "sport": item.session.sport,
                "area": item.session.area,
                "date": item.session.session_date.isoformat(),
                "start": item.session.start_time.isoformat(),
                "end": item.session.end_time.isoformat(),
                "open_slots": item.session.open_slots,
                "skill_min": item.session.skill_min,
                "skill_max": item.session.skill_max,
            }
            for item in recommendations
        ]
        prompt = f"""You are CourtMate's grounded search concierge. Answer in one concise sentence using only the verified records below. Never invent a venue, date, time, player, rating, availability, or result. If records is empty, say no matching record was found. Do not answer unrelated questions and do not mention embeddings or internal IDs.
User request: {query}
Parsed intent: {intent.model_dump(mode='json')}
Verified records: {records}
"""
        try:
            response = self._client.models.generate_content(model=self.model, contents=prompt)
            answer = response.text.strip()
            return answer or fallback
        except Exception as error:
            logger.warning("Grounded Gemini response failed (%s); using deterministic summary", error)
            return fallback

    def general_sports_answer(self, query: str) -> str:
        """Answer general sports and racket sports questions like normal Gemini."""
        if self._client:
            prompt = f"""You are CourtMate's expert, friendly sports and racket-sports AI concierge.
Answer the user's question with deep, structured, helpful sports knowledge.
Cover rules, technique, strategy, footwork, equipment selection, scoring, differences, and drills whenever applicable.
Provide clear Markdown with:
1. A direct, informative opening explanation.
2. Section headers with `###` where helpful.
3. 2-5 concise, actionable bullet points.
4. A practical "Pro Tip" at the end.

Keep the tone encouraging, modern, and expert. Avoid filler or medical diagnosis.

User Question: {query}
"""
            try:
                response = self._client.models.generate_content(model=self.model, contents=prompt)
                answer = response.text.strip()
                if answer:
                    return answer
            except Exception as error:
                logger.warning("Gemini sports answer generation failed (%s); using structured knowledge base", error)

        return self._structured_sports_knowledge(query)

    @classmethod
    def _structured_sports_knowledge(cls, query: str) -> str:
        """Rich, high-quality structured sports knowledge engine for offline / fallback mode."""
        lowered = query.lower()

        # Venue / Court discovery informational queries
        if re.search(r"\b(court|courts|venue|venues|club|clubs)\b|\bwhere can i play\b", lowered):
            sport = next((name for name in ("pickleball", "badminton", "tennis", "padel", "squash", "table tennis") if name in lowered), "racket-sport")
            area_match = re.search(r"\b(?:near|around|in|at)\s+([a-z][a-z .'-]+?)(?:\?|$)", lowered)
            area = area_match.group(1).strip().title() if area_match else "your area"
            if area.lower() in {"me", "here", "my area", "my location"}:
                area = "your area"
            if re.search(r"\b(?:cost|price|pricing)\b", lowered):
                return f"### {sport.title()} Court Pricing in {area}\n\n{sport.title()} court prices in {area} depend on the venue, time, and whether equipment or coaching is included. Check the venue directly for live rates and availability."
            if re.search(r"\b(?:book|reserve)\b", lowered):
                return f"### How to Book a {sport.title()} Court in {area}\n\nTo book a {sport} court in {area}, compare the surface, lighting, cancellation policy, and equipment rental before choosing a time. CourtMate can help find players, but live court booking needs a connected venue directory."
            return f"### {sport.title()} Courts and Clubs in {area}\n\n{area} may have {sport} courts and clubs, but live availability, pricing, and booking need a connected venue directory; tell me the sport and time and I can help narrow the options."

        # Shoes
        if re.search(r"\b(shoe|shoes)\b", lowered):
            return (
                "### Court Shoes Guide\n\n"
                "Choose non-marking court shoes with stable side-to-side support and a comfortable fit. "
                "Match the court shoes to your sport surface (hard court, clay, or indoor court) to prioritize lateral stability and prevent ankle rolls."
            )

        # Equipment and Gear
        if re.search(r"\b(equipment|gear|paddle|paddles|racket|rackets|racquet|racquets|strings?|grip|grips)\b", lowered):
            if "pickleball" in lowered or "paddle" in lowered:
                return (
                    "### Choosing the Right Pickleball Paddle\n\n"
                    "Pickleball paddles vary primarily by core material, surface texture, and weight:\n\n"
                    "• **Core Material**: Polypropylene honeycomb cores offer the best balance of touch, control, and vibration dampening.\n"
                    "• **Facing Material**: Raw Carbon Fiber provides maximum spin and control, while Graphite offers quick response, and Fiberglass gives explosive power.\n"
                    "• **Weight**: Midweight paddles (7.8–8.2 oz) provide the ideal blend of maneuverability at the kitchen and power from the baseline.\n"
                    "• **Grip & Shoes**: Always use non-marking court shoes with lateral support to prevent ankle rolls.\n\n"
                    "**Pro Tip**: Beginners should start with a 16mm thick carbon-fiber paddle for a larger sweet spot and forgiving control."
                )
            if "tennis" in lowered:
                return (
                    "### Tennis Racket & Gear Selection Guide\n\n"
                    "Choosing the right tennis equipment significantly enhances performance and protects against injuries:\n\n"
                    "• **Head Size**: 98–100 sq inches offers a sweet spot for both control and forgiveness.\n"
                    "• **Weight**: 280–300g unstrung is ideal for intermediate players seeking swing speed without sacrificing stability.\n"
                    "• **String Tension**: Lower tension (48–52 lbs) generates more power and comfort; higher tension (53–58 lbs) enhances precision.\n"
                    "• **Shoes**: Hard court tennis shoes with herringbone tread and reinforced toe caps ensure stability during rapid directional changes.\n\n"
                    "**Pro Tip**: If you experience forearm discomfort, switch to a multifilament string strung at 50 lbs to reduce shock."
                )
            if "badminton" in lowered:
                return (
                    "### Badminton Racket & String Essentials\n\n"
                    "Badminton gear revolves around balance, flexibility, and string tension:\n\n"
                    "• **Racket Balance**: Head-heavy for offensive smashes, head-light for quick net play/doubles defense, and even-balance for versatile all-around play.\n"
                    "• **Flexibility**: Medium flex shafts help generate effortless power for recreational and intermediate players.\n"
                    "• **String Tension**: 22–24 lbs for beginners/intermediates gives repulsion power; 26+ lbs is for advanced players with clean technique.\n\n"
                    "**Pro Tip**: Never wear running shoes on badminton wooden or synthetic courts; always choose gum-rubber court shoes."
                )
            return (
                "### Racket Sports Gear Essentials\n\n"
                "• **Court Shoes**: Choose non-marking court shoes with stable side-to-side support and a comfortable fit.\n"
                "• **Rackets & Paddles**: Match the racket, paddle, or strings to your level, and prioritize control and durability before extra power.\n"
                "• **Grip**: Replace overgrips regularly to maintain tackiness and prevent excessive squeeze pressure."
            )

        # Rules and Scoring
        if re.search(r"\b(rule|rules|scoring|score|serve|serving|kitchen|non-volley|let|fault|deuce|tiebreak)\b", lowered):
            if "pickleball" in lowered or "kitchen" in lowered:
                return (
                    "### Pickleball Rules & Kitchen Breakdown\n\n"
                    "Pickleball is easy to learn with a few foundational rules:\n\n"
                    "• **The Kitchen (Non-Volley Zone)**: The 7-foot zone on both sides of the net. You cannot volley (hit the ball out of the air) while touching or stepping into the kitchen or on the line.\n"
                    "• **Two-Bounce Rule**: The serve must bounce once on the return side, and the return of serve must bounce once on the serving side before anyone can volley.\n"
                    "• **Underhand Serve**: Serves must be underhand with contact below the waist, hit diagonally into the opponent's court.\n"
                    "• **Scoring**: Traditional scoring gives points only to the serving side, commonly played to 11, win by 2 (called as server score, receiver score, server 1/2).\n\n"
                    "**Pro Tip**: After hitting your return of serve, rush immediately up to the kitchen line to claim the offensive position."
                )
            if "padel" in lowered:
                return (
                    "### Padel Rules & Wall Play Guide\n\n"
                    "Padel is played in an enclosed court with glass and mesh walls using tennis-style scoring:\n\n"
                    "• **Scoring**: Traditional tennis scoring (15, 30, 40, Game, Sets, and Matches).\n"
                    "• **Serve**: Underarm serve hit at or below waist level after bouncing behind the service line into the diagonal service box.\n"
                    "• **Wall Rebounds**: The ball can rebound off the glass walls after bouncing once, and you can play it off your own back glass back to the opponent's side.\n"
                    "• **Net Play**: Controlling the net is the main tactical goal; use lobs and bandejas to push opponents back.\n\n"
                    "**Pro Tip**: When defending off the glass, stay calm and let the ball pass you before stepping into the rebound."
                )
            if "badminton" in lowered:
                return (
                    "### Badminton Rules & Rally Scoring\n\n"
                    "Badminton uses fast-paced rally scoring:\n\n"
                    "• **Scoring**: Every rally awards a point (rally scoring). Games are played to 21 points, win by 2 (capped at 30).\n"
                    "• **Service**: Hit diagonally from the right court when server's score is even, and left when odd. The shuttle must be struck below 1.15m height.\n"
                    "• **Boundaries**: In singles, the court is long and narrow; in doubles, the court is wide for rallies, but short and wide on the serve.\n\n"
                    "**Pro Tip**: Keep your racket head raised above chest level between shots to react instantly to flat drives."
                )
            if "tennis" in lowered:
                return (
                    "### Tennis Rules & Scoring Overview\n\n"
                    "Tennis is played with a racket and felt ball, using a serve to start each point. Matches are decided across games and sets:\n\n"
                    "• **Game Scoring**: Love (0), 15, 30, 40, and Game. At 40-40 (Deuce), a player must win 2 consecutive points (Advantage → Game).\n"
                    "• **Tiebreakers**: At 6-6 in games, a 7-point tiebreaker is played (first to 7 points, win by 2).\n"
                    "• **Service**: The server has 2 serves per point from behind the baseline diagonally into the opponent's service box.\n\n"
                    "**Pro Tip**: A deep second serve with heavy topspin is much more reliable and harder to attack than a flat tentative serve."
                )
            if "squash" in lowered:
                return (
                    "### Squash Rules & Scoring Overview\n\n"
                    "Squash is played in an enclosed 4-walled court:\n\n"
                    "• **Scoring**: Point-A-Rally Scoring (PARS) to 11 points, win by 2.\n"
                    "• **The Wall**: Every shot must hit the front wall above the tin (19 inches) and below the outline before bouncing on the floor.\n"
                    "• **Interference (Let vs Stroke)**: If an opponent obstructs your swing on a winning shot, you get a 'Stroke' (point). If it's accidental interference, a 'Let' (replay) is called.\n\n"
                    "**Pro Tip**: Always return to the 'T' (center intersection) immediately after hitting your shot to control the court."
                )
            if "table tennis" in lowered or "ping pong" in lowered:
                return (
                    "### Table Tennis Scoring & Service Rules\n\n"
                    "• **Scoring**: Games are played to 11 points, win by 2. Matches are typically best-of-5 or best-of-7 games.\n"
                    "• **Service Rotation**: Service alternates every 2 points (or after every point during deuce).\n"
                    "• **Legal Serve**: The ball must rest freely on an open palm, be tossed vertically at least 16 cm (6 inches), and struck as it falls, bouncing on your side first then the opponent's side.\n\n"
                    "**Pro Tip**: Varying the spin on your serve (sidespin vs underspin) sets up easy third-ball attack opportunities."
                )
            return (
                "### Racket Sports Rules & Scoring\n\n"
                "Most racket sports start each rally with a serve, award the point after every rally, and require the ball or shuttle to land in the opponent's legal court. Tell me the sport for exact scoring rules."
            )

        # Training, Drills, and Improvement
        if re.search(r"\b(improve|training|train|practice|drill|drills|technique|tactic|tactics|strategy|workout|cardio)\b", lowered):
            if "pickleball" in lowered:
                return (
                    "### Top Pickleball Drills for Rapid Improvement\n\n"
                    "1. **Dink-to-Dink Accuracy**: Stand at opposite kitchen lines and sustain 50-shot straight and crosscourt dink rallies without speeding up.\n"
                    "2. **Third-Shot Drop Progression**: One player feeds from the kitchen while the other drops from the baseline, aiming to land softly in the kitchen.\n"
                    "3. **Reset Drill**: Have a partner hit hard drives at your chest while you practice soft hands to absorb pace and reset into the kitchen.\n\n"
                    "**Pro Tip**: Keep your paddle out in front with a relaxed grip (3/10 grip pressure) to absorb hard drives effortlessly."
                )
            if "tennis" in lowered:
                return (
                    "### High-Impact Tennis Drills\n\n"
                    "1. **Crosscourt Consistency**: Rally 20 consecutive balls deep into the opposite crosscourt quadrant beyond the service line.\n"
                    "2. **Serve Target Practice**: Place cones in the 'T' and wide corners of the service boxes to build placement accuracy under pressure.\n"
                    "3. **Split-Step & Recovery**: Practice an explosive split-step as your hitting partner makes contact to cut reaction time.\n\n"
                    "**Pro Tip**: Focus on early racket preparation on your shoulder turn rather than rushing the forward swing."
                )
            if "badminton" in lowered:
                return (
                    "### Essential Badminton Drills\n\n"
                    "1. **6-Point Shadow Footwork**: Practice explosive movement from the center to all 4 corners and 2 mid-court positions with clean recovery.\n"
                    "2. **Clear-Drop Routine**: Partner A hits high deep clears, Partner B hits controlled drop shots, alternating continuously.\n"
                    "3. **Wall Rebound Drill**: Stand 2 meters from a smooth wall and rally flat drives against the wall to build lightning forearm reflex.\n\n"
                    "**Pro Tip**: Keep your wrist relaxed until the exact millisecond of shuttle contact to generate snap power."
                )
            return (
                "### Racket Sport Training Blueprint\n\n"
                "Build improvement around consistent serves and returns, one focused footwork drill, and short games with a clear goal. Record one thing that worked after each session and increase difficulty gradually."
            )

        # Comparisons between sports
        if re.search(r"\b(difference|compare|vs|versus|between)\b", lowered):
            if "padel" in lowered and "pickleball" in lowered:
                return (
                    "### Padel vs. Pickleball: Key Differences\n\n"
                    "• **Court & Walls**: Padel is played in an enclosed court (10x20m) surrounded by glass and wire mesh; Pickleball is played on an open badminton-sized court (6.1x13.4m) with a non-volley zone.\n"
                    "• **Equipment**: Padel uses solid perforated composite rackets and pressurized low-compression balls; Pickleball uses flat paddles and hollow perforated plastic wiffle balls.\n"
                    "• **Game Dynamics**: Padel features long rallies off the glass walls and lobs; Pickleball emphasizes quick kitchen dinking and fast hand battles at the net.\n"
                    "• **Format**: Padel is almost exclusively played as doubles; Pickleball is widely played in both singles and doubles."
                )
            if "tennis" in lowered and ("padel" in lowered or "pickleball" in lowered):
                return (
                    "### Tennis vs. Padel & Pickleball\n\n"
                    "• **Court Size & Physical Demand**: Tennis courts are much larger (23.77m long), requiring extensive endurance and long sprinting; Padel and Pickleball are more compact with emphasis on reflexes and agility.\n"
                    "• **Learning Curve**: Pickleball and Padel have quick learning curves where beginners rally in 15 minutes; Tennis requires substantial technical training for full-stroke groundstrokes and overhead serves.\n"
                    "• **Equipment**: Tennis uses strung rackets and high-pressure felt balls; Padel and Pickleball use solid paddles/rackets."
                )

        # Sport Introductions
        if "padel" in lowered:
            return "### What is Padel?\n\nPadel is a doubles racket sport played on an enclosed court with glass and mesh walls. It uses underarm serves, tennis-style scoring, and lets you play the ball after it rebounds off the walls."
        if "pickleball" in lowered:
            return "### What is Pickleball?\n\nPickleball is played on a smaller court with a perforated paddle and plastic ball. The serve is underarm, points are usually scored only by the serving side, and the non-volley zone is the key tactical area near the net."
        if "badminton" in lowered:
            return "### What is Badminton?\n\nBadminton is a racket sport where you send a shuttle over the net before it lands. Good play combines a high contact point, quick recovery, and changes of pace between clears, drops, drives, and smashes."
        if "tennis" in lowered:
            return "### What is Tennis?\n\nTennis is played with a racket and felt ball, using a serve to start each point. The core tactics are creating space, recovering to a strong position, and changing height, speed, and direction without giving away control."
        if "squash" in lowered:
            return "### What is Squash?\n\nSquash is played against four walls in a small court. Players alternate hitting the ball to the front wall, and the main skills are early preparation, efficient movement, and recovering to the T position."
        if "table tennis" in lowered or "ping pong" in lowered:
            return "### What is Table Tennis?\n\nTable Tennis is played across a table with a small racket and lightweight ball. Spin, placement, and quick transitions matter more than simply hitting hard, especially on the serve and return."

        return "I can answer general sports questions about rules, technique, tactics, training, and equipment across tennis, pickleball, badminton, padel, squash, and table tennis."

    def analyze_activity_image(self, image_bytes: bytes, mime_type: str) -> ActivityProofAnalysis:
        """Extract only visible tracker metrics; never invent values that are not shown."""
        if not self._client:
            raise RuntimeError("Gemini image analysis is not configured")
        from google.genai import types

        prompt = """Read this fitness or sports tracker screenshot and return JSON matching the schema.
Extract only metrics that are clearly visible in the image. Use null for metrics that are missing or unreadable.
Do not estimate calories, duration, distance, steps, or heart rate. Keep summary short and factual.
This screenshot is being attached to a completed racket-sport game."""
        response = self._client.models.generate_content(
            model=self.model,
            contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type=mime_type)],
            config={"response_mime_type": "application/json", "response_schema": ActivityProofAnalysis.model_json_schema()},
        )
        return ActivityProofAnalysis.model_validate_json(response.text)

    @classmethod
    def is_performance_query(cls, query: str) -> bool:
        lowered = " ".join(query.lower().split())
        if not lowered:
            return False
        # Search requests mentioning games or skill should stay in discovery.
        discovery_request = bool(re.search(r"\b(find|search|show|join|invite|create|book|nearby|around)\b", lowered)) and bool(re.search(r"\b(game|games|group|groups|session|sessions|player|players|court|courts|venue|venues|match|matches)\b", lowered))
        own_history_context = bool(re.search(r"\b(my|mine|i've|i have)\b", lowered)) and bool(re.search(r"\b(last|recent|history|played|games|game|activity)\b", lowered))
        if discovery_request and not own_history_context:
            return False
        explicit_metric = bool(re.search(r"\b(cmr|rating|ratings|stats|statistics|calories|steps|heart rate|distance|wearable|progress|trend|fitness|form)\b", lowered))
        personal_history = bool(re.search(r"\b(my|mine|i've|i have)\b", lowered)) and bool(re.search(r"\b(performance|history|played|games|activity|progress|trend|form|improve|rating|stats|fitness)\b", lowered))
        return explicit_metric or personal_history

    def discuss_performance(self, query: str, player: Player, history: dict, activity_proofs: list[dict]) -> str:
        """Answer only from the player's stored game and wearable evidence."""
        context = {
            "player": player.display_name,
            "cmr_ratings": player.cmr_ratings,
            "cmr_game_counts": player.cmr_game_counts,
            "cmr_history": history,
            "wearable_proofs": activity_proofs[:12],
        }
        if not self._client:
            ratings = [
                (sport, rating, player.cmr_game_counts.get(sport, 0))
                for sport, rating in player.cmr_ratings.items()
            ]
            if re.search(r"\bwhat is cmr\b|\bwhat does cmr mean\b|\bexplain cmr\b", query.lower()):
                return "CMR means CourtMate Rating. It is a sport-specific score from 0 to 100 that updates from confirmed match results. It is a guide to progress, not a permanent label."
            if not ratings:
                return "You do not have a CMR history yet. Play a completed racket-sport game and check in to start tracking your form."
            sport, rating, games = max(ratings, key=lambda item: item[1])
            proof_count = len(activity_proofs)
            evidence = f" I also have {proof_count} wearable check-in{'' if proof_count == 1 else 's'} to compare." if proof_count else ""
            return f"Your strongest current signal is {sport.replace('_', ' ').title()} at {rating:.1f}/100 CMR across {games} game{'' if games == 1 else 's'}.{evidence} Ask about a specific sport, rating trend, or wearable metric for a closer read."

        prompt = f"""You are CourtMate's private performance coach for racket-sport players.
Answer the user's question using only the stored context below. Discuss CMR trends, completed games, consistency, and clearly extracted wearable metrics. Do not invent scores, medical advice, or metrics. Explain when the data is too limited. Keep the answer concise, warm, and actionable.
If the request is unrelated to racket-sport performance, say you can only discuss the player's CourtMate history and uploaded wearable activity.

User question: {query}
Stored player context: {context}
"""
        response = self._client.models.generate_content(model=self.model, contents=prompt)
        answer = response.text.strip()
        if not answer:
            raise RuntimeError("Gemini returned an empty performance answer")
        return answer

    def generate_sporty_avatar(self, image_bytes: bytes, mime_type: str, sport: Sport) -> list[str]:
        """Create a few sport-themed avatar options while preserving identity."""
        if not self._client:
            return self._fallback_sporty_avatar_options(image_bytes, mime_type, sport)
        from google import genai

        prompt = (
            f"Create a polished, friendly square profile avatar based on this person's photo, themed for {sport.replace('_', ' ')}. "
            "Keep the person's recognizable face, age, skin tone, and expression. Use a clean illustrated editorial style, "
            "sport-specific clothing or equipment, a bold simple background, and no text, logos, or watermark. Return one avatar image."
        )
        options: list[str] = []
        try:
            for _ in range(3):
                response = self._client.models.generate_content(
                    model=os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.0-flash-preview-image-generation"),
                    contents=[prompt, genai.types.Part.from_bytes(data=image_bytes, mime_type=mime_type)],
                    config={"response_modalities": ["TEXT", "IMAGE"]},
                )
                for candidate in response.candidates or []:
                    for part in candidate.content.parts if candidate.content else []:
                        if part.inline_data and part.inline_data.data:
                            image_data = part.inline_data.data
                            if isinstance(image_data, str):
                                image_data = base64.b64decode(image_data)
                            encoded = base64.b64encode(image_data).decode("ascii")
                            options.append(f"data:{part.inline_data.mime_type or 'image/png'};base64,{encoded}")
                            break
                    if options:
                        break
        except Exception as error:
            logger.warning("Gemini avatar generation failed; using local avatar renderer: %s", error)
            return self._fallback_sporty_avatar_options(image_bytes, mime_type, sport)
        if not options:
            return self._fallback_sporty_avatar_options(image_bytes, mime_type, sport)
        return options[:3]

    @staticmethod
    def _fallback_sporty_avatar_options(image_bytes: bytes, mime_type: str, sport: Sport) -> list[str]:
        """Create useful local previews when Gemini is not configured or unavailable."""
        photo = base64.b64encode(image_bytes).decode("ascii")
        sport_name = sport.replace("_", " ").title()
        palettes = (("#d7ff22", "#10231d"), ("#b8e84b", "#173b2c"), ("#f0d36b", "#14201d"))
        options: list[str] = []
        for index, (accent, ink) in enumerate(palettes):
            svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
<defs><clipPath id="portrait"><circle cx="400" cy="360" r="250"/></clipPath><linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop stop-color="{accent}"/><stop offset="1" stop-color="{ink}"/></linearGradient></defs>
<rect width="800" height="800" rx="120" fill="url(#wash)"/><circle cx="400" cy="360" r="278" fill="none" stroke="{accent}" stroke-width="16" opacity=".85"/>
<image href="data:{mime_type};base64,{photo}" x="150" y="110" width="500" height="500" preserveAspectRatio="xMidYMid slice" clip-path="url(#portrait)"/>
<circle cx="400" cy="360" r="250" fill="none" stroke="#fff" stroke-width="14" opacity=".88"/>
<path d="M95 650h610" stroke="#fff" stroke-width="8" opacity=".55"/><text x="100" y="718" fill="#fff" font-family="sans-serif" font-size="44" font-weight="700">{sport_name}</text><circle cx="690" cy="690" r="26" fill="{accent}"/><text x="683" y="704" fill="{ink}" font-family="sans-serif" font-size="30" font-weight="700">{index + 1}</text>
</svg>'''
            encoded_svg = base64.b64encode(svg.encode("utf-8")).decode("ascii")
            options.append(f"data:image/svg+xml;base64,{encoded_svg}")
        return options

    @staticmethod
    def _fallback_parse(query: str) -> SearchIntent:
        lowered = query.lower()
        sport_aliases = {
            "pickleball": ("pickleball", "pickle ball"),
            "badminton": ("badminton",),
            "tennis": ("tennis",),
            "padel": ("padel",),
            "squash": ("squash",),
            "table_tennis": ("table tennis", "table-tennis", "ping pong"),
        }
        sport = next((candidate for candidate, aliases in sport_aliases.items() if any(alias in lowered for alias in aliases)), "pickleball")
        style = "competitive" if "competitive" in lowered else "social" if "social" in lowered else "casual" if "casual" in lowered else "any"
        locality_match = re.search(
            r"\b(?:near|around|in)\s+([a-z0-9][a-z0-9'. -]*?)(?=\s+(?:this|next|on|at|for|with|today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|morning|afternoon|evening|tonight|beginner|intermediate|advanced|casual|social|competitive|skill|level|cmr)\b|\s*[,.!?]|$)",
            lowered,
        )
        area = locality_match.group(1).strip(" ,.-").title() if locality_match else "Whitefield"
        skill_bands = {
            "beginner": (1.0, 2.9),
            "intermediate": (3.0, 3.5),
            "advanced": (3.5, 5.0),
        }
        skill_level = next((level for level in skill_bands if level in lowered), "")
        skill_min, skill_max = skill_bands.get(skill_level, (None, None))
        numeric_range = re.search(r"\b([1-8](?:\.\d)?)\s*(?:-|to)\s*([1-8](?:\.\d)?)\b", lowered)
        numeric_rating = re.search(r"\b(?:skill|level|rating|cmr)\s*(?:of|is|at|around|:)?\s*([1-8](?:\.\d)?)\b", lowered)
        if numeric_range:
            skill_min = float(numeric_range.group(1))
            skill_max = float(numeric_range.group(2))
        elif numeric_rating:
            skill_min = float(numeric_rating.group(1))
            skill_max = skill_min
        start_time = None
        for hour, meridiem in re.findall(r"\b(\d{1,2})\s*(am|pm)\b", lowered):
            hour = int(hour) % 12 + (12 if meridiem == "pm" else 0)
            start_time = f"{hour:02d}:00"
            break
        if start_time is None:
            start_time = "08:00" if "morning" in lowered else "14:00" if "afternoon" in lowered else "19:00" if "evening" in lowered or "tonight" in lowered else None
        parsed_date = None
        today = date.today()
        if "today" in lowered:
            parsed_date = today
        elif "tomorrow" in lowered:
            parsed_date = today + timedelta(days=1)
        else:
            weekday_names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
            weekday_match = re.search(r"\b(this|next)?\s*(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b", lowered)
            if weekday_match:
                target = next(index for index, name in enumerate(weekday_names) if name.startswith(weekday_match.group(2)))
                days_ahead = (target - today.weekday()) % 7
                prefix = weekday_match.group(1)
                if prefix == "next" or (prefix is None and days_ahead == 0):
                    days_ahead += 7
                parsed_date = today + timedelta(days=days_ahead)
        return SearchIntent(sport=sport, area=area, style=style, skill_min=skill_min, skill_max=skill_max, start_time=start_time, date=parsed_date)
