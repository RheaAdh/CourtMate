import os
import re
from datetime import date

from .models import SearchIntent


class GeminiIntentParser:
    """Gemini adapter with a deterministic demo fallback when no key is configured."""

    def __init__(self) -> None:
        self.api_key = os.getenv("GEMINI_API_KEY")
        self._client = None
        if self.api_key:
            try:
                from google import genai
                self._client = genai.Client(api_key=self.api_key)
            except ImportError:
                self._client = None

    def parse(self, query: str) -> SearchIntent:
        if self._client:
            return self._parse_with_gemini(query)
        return self._fallback_parse(query)

    def _parse_with_gemini(self, query: str) -> SearchIntent:
        prompt = """Extract a pickleball session search into JSON matching this schema: sport, area, date, start_time, end_time, skill_min, skill_max, style, open_slots_required. Use null for unknown values. Only sport pickleball is supported. User request: """ + query
        response = self._client.models.generate_content(model="gemini-2.5-flash", contents=prompt, config={"response_mime_type": "application/json", "response_schema": SearchIntent.model_json_schema()})
        return SearchIntent.model_validate_json(response.text)

    @staticmethod
    def _fallback_parse(query: str) -> SearchIntent:
        lowered = query.lower()
        style = "competitive" if "competitive" in lowered else "social" if "social" in lowered else "casual" if "casual" in lowered else "any"
        area = next((candidate for candidate in ["Whitefield", "Brookefield", "Kadugodi", "Indiranagar", "Koramangala"] if candidate.lower() in lowered), "Whitefield")
        numbers = [float(value) for value in re.findall(r"\b([1-8](?:\.\d)?)\b", lowered)]
        skill_min = min(numbers) if numbers else None
        skill_max = max(numbers) if len(numbers) > 1 else skill_min
        start_time = None
        for hour, meridiem in re.findall(r"\b(\d{1,2})\s*(am|pm)\b", lowered):
            hour = int(hour) % 12 + (12 if meridiem == "pm" else 0)
            start_time = f"{hour:02d}:00"
            break
        return SearchIntent(area=area, style=style, skill_min=skill_min, skill_max=skill_max, start_time=start_time, date=date(2026, 8, 30) if "sunday" in lowered else None)
