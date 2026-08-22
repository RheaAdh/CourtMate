"use client";

import { FormEvent, useState } from "react";

type Session = {
  id: string;
  group_name: string;
  area: string;
  session_date: string;
  start_time: string;
  end_time: string;
  skill_min: number;
  skill_max: number;
  style: string;
  capacity: number;
  confirmed_player_ids: string[];
  external_booking_url?: string;
  open_slots: number;
  score: number;
  explanation: string;
};

type Replacement = {
  id: string;
  display_name: string;
  area: string;
  rating: string;
  reliability: number;
  explanation: string;
};

const demoSessions: Session[] = [
  { id: "s1", group_name: "Sunday Rally Crew", area: "Whitefield", session_date: "2026-08-30", start_time: "08:00", end_time: "10:00", skill_min: 3, skill_max: 3.5, style: "casual", capacity: 8, confirmed_player_ids: ["p1", "p2", "p3", "p6"], open_slots: 4, score: .925, explanation: "Matches your area, Sunday morning, casual style, and intermediate skill band. 4 open slots." },
  { id: "s2", group_name: "East Bengaluru Social", area: "Brookefield", session_date: "2026-08-30", start_time: "09:00", end_time: "11:00", skill_min: 2.8, skill_max: 3.4, style: "social", capacity: 8, confirmed_player_ids: ["p3", "p5"], open_slots: 6, score: .748, explanation: "A nearby social group with a wider skill range and plenty of room to join." },
];

const demoReplacements: Replacement[] = [
  { id: "p4", display_name: "Meera", area: "Brookefield", rating: "DUPR 3.5", reliability: .96, explanation: "Strong skill fit with 96% attendance reliability. Opted into replacement sessions." },
  { id: "p5", display_name: "Vikram", area: "Kadugodi", rating: "Unrated / provisional", reliability: .8, explanation: "Casual style and nearby area. Organizer approval recommended because the player is unrated." },
];

export default function Home() {
  const [query, setQuery] = useState("Find me a casual intermediate game near Whitefield this Sunday morning");
  const [sessions, setSessions] = useState(demoSessions);
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showReplacement, setShowReplacement] = useState(false);
  const [toast, setToast] = useState("");

  async function search(event?: FormEvent, nextQuery?: string) {
    event?.preventDefault();
    const requestQuery = nextQuery ?? query;
    setLoading(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/v1/sessions/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: requestQuery }),
      });
      if (!response.ok) throw new Error("API unavailable");
      const payload = await response.json();
      setSessions(payload.recommendations.map((item: { session: Session; score: number; reasons: { explanation: string } }) => ({
        ...item.session,
        open_slots: item.session.capacity - item.session.confirmed_player_ids.length,
        score: item.score,
        explanation: item.reasons.explanation,
      })));
      setToast("Gemini searched live session data");
    } catch {
      setSessions(demoSessions);
      setToast("Demo mode: showing seeded Whitefield groups");
    } finally {
      setLoading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function startVoice() {
    const SpeechRecognition = (window as Window & { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition
      ?? (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setToast("Voice mode needs Chrome or Safari speech recognition");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setQuery(transcript);
      void search(undefined, transcript);
    };
    recognition.start();
  }

  function joinSession(name: string) {
    setToast(`Join request sent to ${name}`);
    window.setTimeout(() => setToast(""), 2600);
  }

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">CM</span><span>CourtMate</span></div>
        <div className="nav-right"><span className="location-pill"><span className="dot" /> Whitefield, Bengaluru</span><button className="avatar">R</button></div>
      </nav>

      <section className="hero">
        <div className="eyebrow">THE GROUP INTELLIGENCE LAYER FOR PICKLEBALL</div>
        <h1>Find your people.<br /><em>Fill the court.</em></h1>
        <p className="hero-copy">The best game is not just the closest game. Tell CourtMate how you want to play and we&apos;ll find the group that fits.</p>
        <form className="search-box" onSubmit={search}>
          <div className="search-icon">⌕</div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search pickleball groups" />
          <button type="button" className={`mic ${isListening ? "listening" : ""}`} onClick={startVoice} aria-label="Start voice search">{isListening ? "●" : "⌕"}</button>
          <button className="search-button" type="submit">{loading ? "Searching" : "Find a game"}<span>↗</span></button>
        </form>
        <div className="quick-prompts"><span>Try asking</span><button onClick={() => setQuery("Show me groups like my Sunday crew")}>Groups like my Sunday crew</button><button onClick={() => setQuery("Find a replacement for tonight")}>Find a replacement</button></div>
      </section>

      <section className="content-grid">
        <div className="results-column">
          <div className="section-heading"><div><span className="kicker">MATCHES FOR YOU</span><h2>Open games nearby</h2></div><span className="result-count">{sessions.length} good fits</span></div>
          <div className="reason-strip"><span className="spark">✦</span><span><strong>AI read:</strong> You usually choose casual groups on Sunday mornings. We prioritized familiar skill bands and reliable players.</span></div>
          <div className="session-list">
            {sessions.map((session, index) => <article className={`session-card ${index === 0 ? "featured" : ""}`} key={session.id}>
              <div className="card-top"><span className="date-badge"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(session.session_date).getDate()}</small></span><div className="session-meta"><div className="session-title-row"><h3>{session.group_name}</h3><span className="fit-score">{Math.round(session.score * 100)}% fit</span></div><p>{session.start_time} – {session.end_time} · {session.area}</p></div><button className="more">•••</button></div>
              <div className="tags"><span className="tag rating">DUPR {session.skill_min.toFixed(1)}–{session.skill_max.toFixed(1)}</span><span className="tag">{session.style}</span><span className="tag open">{session.open_slots} spots open</span></div>
              <p className="explanation"><span>✦</span>{session.explanation}</p>
              <div className="card-bottom"><div className="member-stack"><span className="member coral">A</span><span className="member green">K</span><span className="member blue">R</span><span className="member-count">+{session.confirmed_player_ids.length + 2}</span></div><button className="join-button" onClick={() => joinSession(session.group_name)}>View group <span>↗</span></button></div>
            </article>)}
          </div>
        </div>

        <aside className="side-column">
          <div className="side-card rescue-card"><div className="side-card-header"><span className="icon-box orange">↗</span><span className="kicker">ORGANIZER VIEW</span></div><h3>Keep the game alive.</h3><p>Someone dropped from <strong>Sunday Rally Crew</strong>. CourtMate found 2 players who fit the session.</p><button className="dark-button" onClick={() => setShowReplacement(!showReplacement)}>{showReplacement ? "Hide suggestions" : "See replacements"}<span>→</span></button>{showReplacement && <div className="replacement-list">{demoReplacements.map((candidate) => <div className="replacement" key={candidate.id}><div className="candidate-avatar">{candidate.display_name[0]}</div><div><strong>{candidate.display_name}</strong><small>{candidate.rating} · {Math.round(candidate.reliability * 100)}% reliable</small></div><button onClick={() => joinSession(candidate.display_name)}>Invite</button></div>)}</div>}</div>
          <div className="side-card trust-card"><div className="side-card-header"><span className="icon-box green-bg">✦</span><span className="kicker">WHY COURTMATE</span></div><h3>Built around the group, not the booking.</h3><div className="trust-row"><span>01</span><p><strong>DUPR-aware</strong><br />Skill is a signal, not a guess.</p></div><div className="trust-row"><span>02</span><p><strong>Group memory</strong><br />It remembers who you enjoy.</p></div><div className="trust-row"><span>03</span><p><strong>Always filling</strong><br />Dropouts become invitations.</p></div></div>
        </aside>
      </section>

      <footer className="footer"><span>CourtMate is not a booking app.</span><span>Book your court on Playo, Hudle, or with your venue.</span></footer>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

interface SpeechRecognitionEvent extends Event { results: { [index: number]: { [index: number]: { transcript: string } } } }
interface SpeechRecognition { lang: string; onstart: () => void; onend: () => void; onresult: (event: SpeechRecognitionEvent) => void; start: () => void }
