import os
import re
from datetime import date
import logging

from .models import ActivityProofAnalysis, Player, SearchDecision, SearchIntent, Session, SessionRecommendation, Sport, rating_for_sport


logger = logging.getLogger(__name__)


class GeminiIntentParser:
    """Gemini adapter with a deterministic fallback when no key is configured."""

    def __init__(self) -> None:
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.model = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
        self._client = None
        if self.api_key:
            try:
                from google import genai
                self._client = genai.Client(api_key=self.api_key)
            except ImportError:
                self._client = None

    @property
    def image_analysis_available(self) -> bool:
        return self._client is not None

    def parse(self, query: str, sport: Sport | None = None) -> SearchIntent:
        if self._client:
            try:
                parsed = self._parse_with_gemini(query)
                return parsed.model_copy(update={"sport": sport}) if sport else parsed
            except Exception as error:
                logger.warning("Gemini intent parsing failed (%s); using deterministic fallback", error)
        parsed = self._fallback_parse(query)
        return parsed.model_copy(update={"sport": sport}) if sport else parsed

    def _parse_with_gemini(self, query: str) -> SearchIntent:
        prompt = """Extract a racket-sport session search into JSON matching this schema: sport, area, date, start_time, end_time, skill_min, skill_max, style, open_slots_required. Supported sports are pickleball, badminton, tennis, padel, squash, and table_tennis. Use null for unknown values. User request: """ + query
        response = self._client.models.generate_content(model=self.model, contents=prompt, config={"response_mime_type": "application/json", "response_schema": SearchIntent.model_json_schema()})
        return SearchIntent.model_validate_json(response.text)

    def decide(self, query: str, intent: SearchIntent, sessions: list[Session], recommendations: list[SessionRecommendation], player: Player | None = None) -> SearchDecision:
        fallback_action = "join_existing" if recommendations else "create_group"
        fallback_name = f"{intent.area} {intent.style.title()} {intent.sport.replace('_', ' ').title()}" if not recommendations else None
        fallback = SearchDecision(
            action=fallback_action,
            summary=(f"Found {len(recommendations)} existing group(s) that fit your request." if recommendations else "No open group matches all of those requirements. You can create the first group and invite nearby players."),
            ranked_session_ids=[item.session.id for item in recommendations],
            proposed_group_name=fallback_name,
        )
        if not self._client:
            return fallback

        score_by_id = {item.session.id: item.score for item in recommendations}
        snapshot = [
            {
                "id": session.id,
                "group_name": session.group_name,
                "sport": session.sport,
                "area": session.area,
                "date": session.session_date.isoformat(),
                "start_time": session.start_time.isoformat(),
                "end_time": session.end_time.isoformat(),
                "skill_band": f"{session.skill_min:.1f}-{session.skill_max:.1f}",
                "style": session.style,
                "open_slots": session.open_slots,
                "status": session.status,
                "deterministic_score": score_by_id.get(session.id),
            }
            for session in sessions
        ]
        user_rating = rating_for_sport(player, intent.sport) if player else None
        prompt = f"""You are CourtMate's multi-sport court group concierge. The database snapshot below is the only source of truth; do not invent groups or players.
Return JSON matching this schema: action (join_existing or create_group), summary, ranked_session_ids, proposed_group_name.
The Python matcher has already filtered the snapshot for sport, area, date, availability, skill compatibility, and open slots. Explain the best existing groups, or explain why the user should start a new group. Never include an id not present in the snapshot.
User request: {query}
Parsed intent: {intent.model_dump_json()}
User sport rating: {user_rating if user_rating is not None else "unknown"}
Firestore session snapshot: {snapshot}
"""
        try:
            response = self._client.models.generate_content(
                model=self.model,
                contents=prompt,
                config={"response_mime_type": "application/json", "response_schema": SearchDecision.model_json_schema()},
            )
            decision = SearchDecision.model_validate_json(response.text)
            allowed_ids = {item.session.id for item in recommendations}
            decision.ranked_session_ids = [session_id for session_id in decision.ranked_session_ids if session_id in allowed_ids]
            decision.action = fallback_action
            if not recommendations:
                decision.ranked_session_ids = []
            return decision
        except Exception as error:
            logger.warning("Gemini search decision failed (%s); using deterministic decision", error)
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
        area = next((candidate for candidate in ["Whitefield", "Brookefield", "Kadugodi", "Indiranagar", "Koramangala"] if candidate.lower() in lowered), "Whitefield")
        numbers = [float(value) for value in re.findall(r"\b([1-8](?:\.\d)?)\b", lowered)]
        skill_bands = {
            "beginner": (1.0, 2.9),
            "intermediate": (3.0, 3.5),
            "advanced": (3.5, 5.0),
        }
        skill_level = next((level for level in skill_bands if level in lowered), "")
        skill_min, skill_max = skill_bands.get(skill_level, (None, None))
        if numbers:
            skill_min = min(numbers)
            skill_max = max(numbers) if len(numbers) > 1 else skill_min
        start_time = None
        for hour, meridiem in re.findall(r"\b(\d{1,2})\s*(am|pm)\b", lowered):
            hour = int(hour) % 12 + (12 if meridiem == "pm" else 0)
            start_time = f"{hour:02d}:00"
            break
        if start_time is None:
            start_time = "08:00" if "morning" in lowered else "14:00" if "afternoon" in lowered else "19:00" if "evening" in lowered or "tonight" in lowered else None
        return SearchIntent(sport=sport, area=area, style=style, skill_min=skill_min, skill_max=skill_max, start_time=start_time, date=date(2026, 8, 30) if "sunday" in lowered else None)
