# CourtMate

CourtMate is the intelligent group layer for pickleball organizers. The MVP helps players discover skill-compatible sessions and helps organizers replace dropouts without replacing WhatsApp or court-booking platforms.

## Backend MVP

The first implementation slice is a Python API with:

- Deterministic session search by area, time, skill band, and play style
- DUPR-aware player and replacement ranking
- Unrated-player handling with explicit provenance
- Gemini intent parsing through `google-genai` when `GEMINI_API_KEY` is configured
- A deterministic local parser fallback for development and demos
- In-memory seeded Whitefield data, designed to be replaced by Firestore
- Feedback capture for fun, fairness, and repeat-play learning

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn backend.main:app --reload
```

Without a Gemini key, the API uses the local parser fallback. With a key, intent extraction uses Gemini through the server-side adapter.

## Example requests

```bash
curl http://localhost:8000/health

curl -X POST http://localhost:8000/v1/sessions/search \
  -H 'content-type: application/json' \
  -d '{"query":"Find a casual intermediate pickleball game near Whitefield this Sunday morning"}'

curl http://localhost:8000/v1/sessions/s1/replacement
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

## Google Cloud direction

- Deploy the API container to Cloud Run.
- Use Vertex AI with Application Default Credentials in Cloud Run, instead of shipping an API key.
- Replace `InMemoryRepository` with Firestore behind the same repository contract.
- Add Pub/Sub for reminders and replacement events after the synchronous demo flow is stable.
- Export event records to BigQuery for organizer and venue analytics.

See [CourtMate_Technical_Design_and_Architecture.docx](CourtMate_Technical_Design_and_Architecture.docx) for the full architecture and decision record.
