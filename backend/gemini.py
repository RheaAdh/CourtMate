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
        "court", "venue", "club", "group", "game", "match", "session", "player",
        "partner", "teammate", "opponent", "tournament", "people to play", "open spot", "skill", "level",
        "waitlist", "play with", "looking to play", "want to play",
    )
    _DISCOVERY_ACTIONS = (
        "find", "search", "join", "invite", "organize", "organise", "create",
        "available", "availability", "reserve", "book", "show", "get",
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
        "table tennis", "ping pong", "racket", "racquet",
    )
    _GENERAL_COURT_TERMS = (
        "court", "courts", "venue", "venues", "club", "clubs", "paddle", "shuttle",
        "net", "volley", "serve", "serving", "rally", "ball", "racket", "racquet",
    )
    _GENERAL_SPORT_QUESTION_TERMS = (
        "what", "why", "how", "explain", "rule", "tip", "improve", "difference", "strategy",
        "technique", "drill", "training", "practice", "score", "scoring", "serve", "grip",
        "equipment", "benefit", "compare", "best", "meaning", "definition", "who", "when",
        "can", "should", "tell me", "about", "describe", "overview", "information", "learn",
        "asking about",
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
        self.model = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
        # Common discovery phrases are parsed locally to keep every search to
        # one network hop at most. Enable the model parser for more ambiguous
        # language when the richer interpretation is worth the latency.
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
        """Allow only court-sport discovery requests into the search workflow."""
        current = " ".join(query.lower().split())
        if not current:
            return False
        # A new unrelated question must never inherit discovery context from a
        # previous message. Context is only for short follow-ups such as
        # "make it more casual" or "this weekend".
        if any(term in current for term in cls._NON_COURT_TERMS):
            return False
        # Venue questions framed as requests for information belong to the
        # general assistant. Keep direct discovery such as "what courts are
        # nearby?" in the CourtMate search workflow.
        if cls._is_venue_information_query(current):
            return False
        lowered = f"{current} {context or ''}".strip()
        has_sport = any(term in lowered for term in cls._SPORT_TERMS)
        has_court_object = any(term in lowered for term in cls._DISCOVERY_TERMS)
        has_action = any(term in lowered for term in cls._DISCOVERY_ACTIONS)
        has_time_context = any(term in lowered for term in cls._TIME_TERMS)
        has_location_context = bool(re.search(r"\b(near|nearby|around|local|area|location|within)\b", lowered))
        has_play_intent = any(term in lowered for term in ("want to play", "looking to play", "people to play", "where can i play", "who can i play"))

        # Object words alone are not enough. This prevents questions such as
        # "explain the rules of tennis" or "what is a club?" from becoming a
        # fabricated session search.
        if re.search(r"\b(explain|what is|what are|why is|how does|rules? of|how to play)\b", current) and not re.search(r"\b(near|nearby|around|find|search|join|open|available)\b", current):
            return False
        if has_action and has_court_object:
            return True
        if has_court_object and has_location_context:
            return True
        if re.search(r"\b(similar|like me|compatible|best fit|good fit|match me|matching)\b", current) and has_court_object:
            return True
        if has_play_intent:
            return True
        # Resolve terse follow-ups against the previous discovery request.
        if context and (has_time_context or has_location_context or any(term in current for term in ("same", "another", "more", "only", "instead", "after", "before"))):
            return True
        # A sport plus timing, location, skill, or a clear wish to play is an
        # implicit request to discover a game.
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
            and re.search(r"\b(game|games|group|groups|session|sessions|player|players|people|match|matches|tournament|tournaments)\b", current)
        )
        return (has_sport or has_court_topic) and has_question_signal and not has_session_discovery_request

    @classmethod
    def _is_venue_information_query(cls, query: str) -> bool:
        """Detect informational venue questions without stealing court discovery."""
        has_venue = bool(re.search(r"\b(court|courts|venue|venues|club|clubs)\b|\bwhere can i play\b", query))
        has_information_signal = any(re.search(pattern, query) for pattern in cls._VENUE_INFORMATION_PATTERNS)
        has_game_request = bool(re.search(r"\b(find|search|show|join|create|book)\b.*\b(game|games|group|groups|session|sessions|match|matches)\b", query))
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
        # Keep the final answer grounded in the Python-filtered records. Gemini
        # extracts language above; it must not override availability, ranking,
        # or the explanation shown to the player.
        if recommendations:
            lead = recommendations[0].session
            date_label = lead.session_date.strftime("%a %d %b")
            time_label = f"{lead.start_time.strftime('%I:%M %p').lstrip('0')}–{lead.end_time.strftime('%I:%M %p').lstrip('0')}"
            return fallback.model_copy(update={
                "summary": f"I found {len(recommendations)} {sport_name} game{'s' if len(recommendations) != 1 else ''} that fit. Best fit: {lead.group_name} on {date_label}, {time_label} in {lead.area}, with {lead.open_slots} spot{'s' if lead.open_slots != 1 else ''} open.",
            })
        return fallback

    def grounded_search_answer(self, query: str, intent: SearchIntent, recommendations: list[SessionRecommendation], tournaments: list[object]) -> str:
        """Explain only records that survived retrieval and Python validation."""
        if recommendations:
            lead = recommendations[0].session
            fallback = f"I found {len(recommendations)} {intent.sport.replace('_', ' ')} game{'s' if len(recommendations) != 1 else ''}. Best fit: {lead.group_name} in {lead.area} with {lead.open_slots} spot{'s' if lead.open_slots != 1 else ''} open."
        elif tournaments:
            lead = tournaments[0]
            fallback = f"I found {len(tournaments)} tournament{'s' if len(tournaments) != 1 else ''}. Best match: {lead.name} on {lead.tournament_date.strftime('%a %d %b')} in {lead.area}."
        else:
            fallback = f"I could not find a {intent.sport.replace('_', ' ')} game or tournament matching those details."
        # The deterministic sentence above is already built from validated
        # records. Keep search to one model hop by default; opt into a second
        # prose-generation request only when the product needs it.
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
        ] + [
            {
                "id": item.id,
                "type": "tournament",
                "name": item.name,
                "sport": item.sport,
                "area": item.area,
                "date": item.tournament_date.isoformat(),
            }
            for item in tournaments
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
        """Answer general sports questions without implying CourtMate has matching records."""
        fallback = "I can answer general sports questions about rules, technique, tactics, training, and equipment."
        if not self._client:
            lowered = query.lower()
            if re.search(r"\b(court|courts|venue|venues|club|clubs)\b|\bwhere can i play\b", lowered):
                sport = next((name for name in ("pickleball", "badminton", "tennis", "padel", "squash", "table tennis") if name in lowered), "racket-sport")
                area_match = re.search(r"\b(?:near|around|in|at)\s+([a-z][a-z .'-]+?)(?:\?|$)", lowered)
                area = area_match.group(1).strip().title() if area_match else "your area"
                if area.lower() in {"me", "here", "my area", "my location"}:
                    area = "your area"
                if re.search(r"\b(?:cost|price|pricing)\b", lowered):
                    return f"{sport.title()} court prices in {area} depend on the venue, time, and whether equipment or coaching is included. Check the venue directly for live rates and availability."
                if re.search(r"\b(?:book|reserve)\b", lowered):
                    return f"To book a {sport} court in {area}, compare the surface, lighting, cancellation policy, and equipment rental before choosing a time. CourtMate can help find players, but live court booking needs a connected venue directory."
                return f"{area} may have {sport} courts and clubs, but live availability, pricing, and booking need a connected venue directory; tell me the sport and time and I can help narrow the options."
            if re.search(r"\b(?:shoe|shoes|equipment|gear|paddle|racket|racquet)\b", lowered):
                return "Choose non-marking court shoes with stable side-to-side support and a comfortable fit. Match the racket, paddle, or strings to your level, and prioritize control and durability before extra power."
            if re.search(r"\b(?:rule|rules|scoring|score|serve|serving)\b", lowered):
                if "pickleball" in lowered:
                    return "In pickleball, the serve is underarm and must land diagonally beyond the non-volley zone. Traditional scoring gives points only to the serving side, and games are commonly played to 11, win by 2."
                if "badminton" in lowered:
                    return "Badminton uses rally scoring: every rally awards a point, and a game is usually played to 21, win by 2 up to 30. The serve is diagonal, and the shuttle must land inside the opponent's court."
                if "table tennis" in lowered or "ping pong" in lowered:
                    return "Table tennis uses rally scoring, with games commonly played to 11, win by 2. Serves alternate every two points, and the ball must bounce on both sides in a legal serve."
                if "padel" in lowered:
                    return "Padel uses tennis-style scoring and an underarm serve. The ball can rebound off the walls after bouncing, so positioning and patience are as important as hitting power."
                return "Most racket sports start each rally with a serve, award the point after every rally, and require the ball or shuttle to land in the opponent's legal court. Tell me the sport for exact scoring rules."
            if re.search(r"\b(?:improve|training|train|practice|drill|technique|tactic|tactics|strategy)\b", lowered):
                return "Build improvement around consistent serves and returns, one focused footwork drill, and short games with a clear goal. Record one thing that worked after each session and increase difficulty gradually."
            if "padel" in lowered:
                return "Padel is a doubles racket sport played on an enclosed court with glass and mesh walls. It uses underarm serves, tennis-style scoring, and lets you play the ball after it rebounds off the walls."
            if "pickleball" in lowered:
                return "Pickleball is played on a smaller court with a perforated paddle and plastic ball. The serve is underarm, points are usually scored only by the serving side, and the non-volley zone is the key tactical area near the net."
            if "badminton" in lowered:
                return "Badminton is a racket sport where you send a shuttle over the net before it lands. Good play combines a high contact point, quick recovery, and changes of pace between clears, drops, drives, and smashes."
            if "tennis" in lowered:
                return "Tennis is played with a racket and felt ball, using a serve to start each point. The core tactics are creating space, recovering to a strong position, and changing height, speed, and direction without giving away control."
            if "squash" in lowered:
                return "Squash is played against four walls in a small court. Players alternate hitting the ball to the front wall, and the main skills are early preparation, efficient movement, and recovering to the T position."
            if "table tennis" in lowered or "ping pong" in lowered:
                return "Table tennis is played across a table with a small racket and lightweight ball. Spin, placement, and quick transitions matter more than simply hitting hard, especially on the serve and return."
            return fallback
        prompt = f"""You are CourtMate's friendly general sports assistant. Answer the user's informational question using your general sports knowledge, even when the sport or topic is not present in CourtMate's database. Cover rules, technique, tactics, training, equipment, venues, and comparisons when relevant. Do not invent live scores, current fixtures, athlete news, or CourtMate games, players, venues, or tournaments. If the question depends on current information, say that it needs a live source. Avoid medical diagnosis and recommend a qualified professional for injuries. Keep the answer concise, clear, practical, and polite. Use readable Markdown: a short opening sentence, then a brief `###` heading and 2-5 bullet points or numbered steps only when they improve clarity. Do not use horizontal rules, decorative emoji headings, or repeated bold markers.

User question: {query}
"""
        try:
            response = self._client.models.generate_content(model=self.model, contents=prompt)
            answer = response.text.strip()
            return answer or fallback
        except Exception as error:
            logger.warning("General sports response failed (%s); using fallback", error)
            return fallback

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
            raise RuntimeError("Gemini image generation is not configured")
        from google import genai

        prompt = (
            f"Create a polished, friendly square profile avatar based on this person's photo, themed for {sport.replace('_', ' ')}. "
            "Keep the person's recognizable face, age, skin tone, and expression. Use a clean illustrated editorial style, "
            "sport-specific clothing or equipment, a bold simple background, and no text, logos, or watermark. Return one avatar image."
        )
        options: list[str] = []
        for _ in range(3):
            response = self._client.models.generate_content(
                model=os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.0-flash-preview-image-generation"),
                contents=[prompt, genai.types.Part.from_bytes(data=image_bytes, mime_type=mime_type)],
                config={"response_modalities": ["TEXT", "IMAGE"]},
            )
            for candidate in response.candidates or []:
                for part in candidate.content.parts if candidate.content else []:
                    if part.inline_data and part.inline_data.data:
                        encoded = base64.b64encode(part.inline_data.data).decode("ascii")
                        options.append(f"data:{part.inline_data.mime_type or 'image/png'};base64,{encoded}")
                        break
                if options:
                    break
        if not options:
            raise RuntimeError("Gemini did not return avatar images")
        return options[:3]

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
