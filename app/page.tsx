"use client";

import { FormEvent, useEffect, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";

import { auth, isFirebaseConfigured } from "../lib/firebase";

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

type ReplacementResponse = {
  candidates: ReplacementCandidate[];
};

type ReplacementCandidate = {
  player: {
    id: string;
    display_name: string;
    area: string;
    dupr_rating?: number | null;
    reliability: number;
  };
  explanation: string;
};

type GroupProposal = {
  group_name: string;
  area: string;
  session_date?: string;
  start_time?: string;
  end_time?: string;
  skill_min: number;
  skill_max: number;
  style: string;
  explanation: string;
};

type SearchResponse = {
  action: "join_existing" | "create_group";
  message: string;
  recommendations: { session: Session; score: number; reasons: { explanation: string } }[];
  group_proposal?: GroupProposal;
};

type PlayerProfile = {
  id: string;
  display_name: string;
  area: string;
  dupr_rating?: number | null;
  rating_source: string;
  style: string;
};

type JoinRequest = {
  id: string;
  player_id: string;
  player_display_name?: string;
  status: string;
};

type GroupMember = {
  id: string;
  display_name: string;
  area: string;
  dupr_rating?: number | null;
  rating_source: string;
  rating_confidence: number;
  style: string;
  reliability: number;
};

type GroupView = {
  session: Session;
  members: GroupMember[];
};

const demoSessions: Session[] = [
  { id: "s1", group_name: "Sunday Rally Crew", area: "Whitefield", session_date: "2026-08-30", start_time: "08:00", end_time: "10:00", skill_min: 3, skill_max: 3.5, style: "casual", capacity: 8, confirmed_player_ids: ["p1", "p2", "p3", "p6"], open_slots: 4, score: .925, explanation: "Matches your area, Sunday morning, casual style, and intermediate skill band. 4 open slots." },
  { id: "s2", group_name: "East Bengaluru Social", area: "Brookefield", session_date: "2026-08-30", start_time: "09:00", end_time: "11:00", skill_min: 2.8, skill_max: 3.4, style: "social", capacity: 8, confirmed_player_ids: ["p3", "p5"], open_slots: 6, score: .748, explanation: "A nearby social group with a wider skill range and plenty of room to join." },
];

const demoReplacements: Replacement[] = [
  { id: "p4", display_name: "Meera", area: "Brookefield", rating: "DUPR 3.5", reliability: .96, explanation: "Strong skill fit with 96% attendance reliability. Opted into replacement sessions." },
  { id: "p5", display_name: "Vikram", area: "Kadugodi", rating: "Unrated / provisional", reliability: .8, explanation: "Casual style and nearby area. Organizer approval recommended because the player is unrated." },
];

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function Home() {
  const [query, setQuery] = useState("Find me a casual intermediate game near Whitefield this Sunday morning");
  const [sessions, setSessions] = useState(demoSessions);
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showReplacement, setShowReplacement] = useState(false);
  const [replacements, setReplacements] = useState(demoReplacements);
  const [replacementLoading, setReplacementLoading] = useState(false);
  const [groupProposal, setGroupProposal] = useState<GroupProposal | null>(null);
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [createdGroupId, setCreatedGroupId] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [viewedGroup, setViewedGroup] = useState<GroupView | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (process.env.NODE_ENV === "development" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => void registration.unregister());
      });
    }
    if (!auth) {
      setAuthReady(true);
      return;
    }
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) void loadProfile(nextUser);
    });
  }, []);

  async function authorizedFetch(url: string, options: RequestInit = {}, authUser: User | null = user) {
    if (!authUser) throw new Error("Sign in required");
    const token = await authUser.getIdToken();
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  }

  async function loadProfile(authUser: User = user as User) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me`, {}, authUser);
      if (!response.ok) throw new Error("Profile unavailable");
      setProfile(await response.json() as PlayerProfile);
    } catch {
      setToast("Could not load your CourtMate profile");
    }
  }

  async function signIn() {
    if (!auth || !isFirebaseConfigured) {
      setToast("Add Firebase web config to .env.local first");
      return;
    }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch {
      setToast("Google sign-in was cancelled or failed");
    }
  }

  async function signOutUser() {
    if (auth) await signOut(auth);
    setProfile(null);
    setCreatedGroupId(null);
    setJoinRequests([]);
  }

  async function setDUPRRating() {
    if (!profile) return;
    const value = window.prompt("Enter your DUPR rating", profile.dupr_rating?.toString() ?? "3.2");
    if (!value) return;
    const rating = Number(value);
    if (!Number.isFinite(rating) || rating < 1 || rating > 8) {
      setToast("DUPR rating must be between 1.0 and 8.0");
      return;
    }
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dupr_rating: rating }) });
      if (!response.ok) throw new Error("Profile update failed");
      setProfile(await response.json() as PlayerProfile);
      setToast("DUPR profile updated");
    } catch {
      setToast("Could not update your DUPR profile");
    }
  }

  async function search(event?: FormEvent, nextQuery?: string) {
    event?.preventDefault();
    if (!user) {
      setToast("Sign in with Google before searching");
      return;
    }
    const requestQuery = nextQuery ?? query;
    setLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: requestQuery }),
      });
      if (!response.ok) throw new Error("API unavailable");
      const payload = (await response.json()) as SearchResponse;
      setSessions(payload.recommendations.map((item: { session: Session; score: number; reasons: { explanation: string } }) => ({
        ...item.session,
        open_slots: item.session.capacity - item.session.confirmed_player_ids.length,
        score: item.score,
        explanation: item.reasons.explanation,
      })));
      setGroupProposal(payload.group_proposal ?? null);
      setToast(payload.message || "Gemini searched live session data");
    } catch {
      setSessions(demoSessions);
      setGroupProposal(null);
      setToast("Demo mode: showing seeded Whitefield groups");
    } finally {
      setLoading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function createGroup() {
    if (!user) {
      setToast("Sign in with Google before creating a group");
      return;
    }
    setCreateGroupLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) throw new Error("Unable to create group");
      const payload = await response.json() as { session: Omit<Session, "open_slots" | "score" | "explanation">; message: string };
      const createdSession: Session = {
        ...payload.session,
        open_slots: payload.session.capacity - payload.session.confirmed_player_ids.length,
        score: 1,
        explanation: "You are the organizer. CourtMate can now invite nearby players in the same DUPR band.",
      };
      setSessions([createdSession]);
      setGroupProposal(null);
      setCreatedGroupId(createdSession.id);
      setToast(payload.message);
    } catch {
      setToast("Could not create the group. Check that the API is running.");
    } finally {
      setCreateGroupLoading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function loadReplacements() {
    setShowReplacement(true);
    setReplacementLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/s1/replacement`);
      if (!response.ok) throw new Error("API unavailable");
      const payload = (await response.json()) as ReplacementResponse;
      setReplacements(payload.candidates.map((candidate) => ({
        id: candidate.player.id,
        display_name: candidate.player.display_name,
        area: candidate.player.area,
        rating: candidate.player.dupr_rating ? `DUPR ${candidate.player.dupr_rating.toFixed(1)}` : "Unrated / provisional",
        reliability: candidate.player.reliability,
        explanation: candidate.explanation,
      })));
      setToast("Live replacement suggestions loaded from Firestore");
    } catch {
      setReplacements(demoReplacements);
      setToast("Demo mode: showing seeded replacement suggestions");
    } finally {
      setReplacementLoading(false);
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

  async function joinSession(sessionId: string, name: string) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) throw new Error("Unable to join");
      setToast(`Join request sent to ${name}`);
    } catch {
      setToast(`Could not request to join ${name}`);
    } finally {
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function viewGroup(sessionId: string) {
    setGroupLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/group`);
      if (!response.ok) {
        if (response.status === 401) throw new Error("Your sign-in session expired. Sign in again.");
        if (response.status === 404) throw new Error("This group no longer exists.");
        throw new Error(`Group request failed (${response.status})`);
      }
      setViewedGroup(await response.json() as GroupView);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not load this group");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setGroupLoading(false);
    }
  }

  async function loadJoinRequests() {
    if (!createdGroupId) return;
    setRequestsLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${createdGroupId}/join-requests`);
      if (!response.ok) throw new Error("Requests unavailable");
      const payload = await response.json() as { requests: JoinRequest[] };
      setJoinRequests(payload.requests);
      setToast(`${payload.requests.length} join request(s) loaded`);
    } catch {
      setToast("Only the group organizer can view these requests");
    } finally {
      setRequestsLoading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function inviteCandidate(name: string) {
    setToast(`Invite prepared for ${name}`);
    window.setTimeout(() => setToast(""), 2600);
  }

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">CM</span><span>CourtMate</span></div>
        <div className="nav-right"><span className="location-pill"><span className="dot" /> Whitefield, Bengaluru</span>{user ? <><span className="user-name">{user.displayName ?? user.email}</span><button className="avatar" onClick={() => setShowProfile(!showProfile)} title="Open profile">{(user.displayName ?? user.email ?? "C")[0].toUpperCase()}</button></> : <button className="sign-in-button" onClick={() => void signIn()}>{authReady ? "Sign in with Google" : "Loading auth"}</button>}</div>
      </nav>
      {showProfile && profile && <section className="profile-popover"><div className="profile-popover-top"><span className="kicker">YOUR PROFILE</span><button className="close-button" onClick={() => setShowProfile(false)}>×</button></div><h3>{profile.display_name}</h3><p>{user?.email}</p><div className="profile-stats"><span><strong>{profile.dupr_rating ? profile.dupr_rating.toFixed(1) : "--"}</strong><small>DUPR</small></span><span><strong>{profile.area}</strong><small>AREA</small></span><span><strong>{profile.style}</strong><small>STYLE</small></span></div><button className="dark-button" onClick={() => void setDUPRRating()}>Update DUPR <span>→</span></button><button className="text-button" onClick={() => void signOutUser()}>Sign out</button></section>}

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
          <div className="section-heading"><div><span className="kicker">MATCHES FOR YOU</span><h2>{sessions.length ? "Open games nearby" : "No exact match yet"}</h2></div><span className="result-count">{sessions.length} good fits</span></div>
          <div className="reason-strip"><span className="spark">✦</span><span><strong>AI read:</strong> {profile?.dupr_rating ? `Your DUPR ${profile.dupr_rating.toFixed(1)} profile is being used for skill matching.` : "Set your DUPR rating so CourtMate can make skill-aware recommendations."}</span>{profile && <button className="profile-action" onClick={() => void setDUPRRating()}>{profile.dupr_rating ? "Update" : "Set DUPR"}</button>}</div>
          {!sessions.length && groupProposal && <div className="empty-state"><span className="empty-icon">+</span><span className="kicker">START THE NEXT GROUP</span><h3>{groupProposal.group_name}</h3><p>{groupProposal.explanation}</p><div className="tags"><span className="tag rating">DUPR {groupProposal.skill_min.toFixed(1)}–{groupProposal.skill_max.toFixed(1)}</span><span className="tag">{groupProposal.style}</span><span className="tag open">{groupProposal.area}</span></div><button className="join-button create-button" onClick={() => void createGroup()}>{createGroupLoading ? "Creating group" : "Create this group"}<span>↗</span></button></div>}
          <div className="session-list">
            {sessions.map((session, index) => <article className={`session-card ${index === 0 ? "featured" : ""}`} key={session.id}>
              <div className="card-top"><span className="date-badge"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(session.session_date).getDate()}</small></span><div className="session-meta"><div className="session-title-row"><h3>{session.group_name}</h3><span className="fit-score">{Math.round(session.score * 100)}% fit</span></div><p>{session.start_time} – {session.end_time} · {session.area}</p></div><button className="more">•••</button></div>
              <div className="tags"><span className="tag rating">DUPR {session.skill_min.toFixed(1)}–{session.skill_max.toFixed(1)}</span><span className="tag">{session.style}</span><span className="tag open">{session.open_slots} spots open</span></div>
              <p className="explanation"><span>✦</span>{session.explanation}</p>
              <div className="card-bottom"><div className="member-stack"><span className="member coral">A</span><span className="member green">K</span><span className="member blue">R</span><span className="member-count">+{session.confirmed_player_ids.length + 2}</span></div><div className="card-actions"><button className="join-button secondary-button" onClick={() => void viewGroup(session.id)}>{groupLoading ? "Loading" : "View group"}</button><button className="join-button" onClick={() => void joinSession(session.id, session.group_name)}>Request to join <span>↗</span></button></div></div>
            </article>)}
          </div>
        </div>

        <aside className="side-column">
          <div className="side-card rescue-card"><div className="side-card-header"><span className="icon-box orange">↗</span><span className="kicker">ORGANIZER VIEW</span></div><h3>Keep the game alive.</h3><p>Someone dropped from <strong>Sunday Rally Crew</strong>. CourtMate found {replacements.length} players who fit the session.</p><button className="dark-button" onClick={() => showReplacement ? setShowReplacement(false) : void loadReplacements()}>{showReplacement ? "Hide suggestions" : replacementLoading ? "Finding players" : "See replacements"}<span>→</span></button>{showReplacement && <div className="replacement-list">{replacements.map((candidate) => <div className="replacement" key={candidate.id}><div className="candidate-avatar">{candidate.display_name[0]}</div><div><strong>{candidate.display_name}</strong><small>{candidate.rating} · {Math.round(candidate.reliability * 100)}% reliable</small></div><button onClick={() => inviteCandidate(candidate.display_name)}>Invite</button></div>)}</div>}</div>
          <div className="side-card trust-card"><div className="side-card-header"><span className="icon-box green-bg">✦</span><span className="kicker">WHY COURTMATE</span></div><h3>Built around the group, not the booking.</h3><div className="trust-row"><span>01</span><p><strong>DUPR-aware</strong><br />Skill is a signal, not a guess.</p></div><div className="trust-row"><span>02</span><p><strong>Group memory</strong><br />It remembers who you enjoy.</p></div><div className="trust-row"><span>03</span><p><strong>Always filling</strong><br />Dropouts become invitations.</p></div></div>
          {createdGroupId && <div className="side-card request-card"><div className="side-card-header"><span className="icon-box green-bg">✓</span><span className="kicker">YOUR GROUP</span></div><h3>Join requests</h3><p>Other signed-in players can request to join your new group. Refresh here to see them.</p><button className="dark-button" onClick={() => void loadJoinRequests()}>{requestsLoading ? "Loading requests" : "View requests"}<span>→</span></button>{joinRequests.length > 0 && <div className="request-list">{joinRequests.map((request) => <div className="request-row" key={request.id}><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small>{request.status}</small></div>)}</div>}</div>}
        </aside>
      </section>

      <footer className="footer"><span>CourtMate is not a booking app.</span><span>Book your court on Playo, Hudle, or with your venue.</span></footer>
      {viewedGroup && <div className="group-modal-backdrop" onClick={() => setViewedGroup(null)}><section className="group-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">GROUP PREVIEW</span><h2>{viewedGroup.session.group_name}</h2><p>{viewedGroup.session.start_time} – {viewedGroup.session.end_time} · {viewedGroup.session.area}</p></div><button className="close-button" onClick={() => setViewedGroup(null)}>×</button></div><div className="group-summary"><span><strong>{viewedGroup.members.length}/{viewedGroup.session.capacity}</strong><small>PLAYERS</small></span><span><strong>{viewedGroup.session.skill_min.toFixed(1)}–{viewedGroup.session.skill_max.toFixed(1)}</strong><small>DUPR BAND</small></span><span><strong>{viewedGroup.session.style}</strong><small>INTENSITY</small></span></div><div className="member-grid">{viewedGroup.members.map((member) => <article className="member-profile" key={member.id}><div className="member-profile-avatar">{member.display_name[0]}</div><div className="member-profile-copy"><h3>{member.display_name}</h3><p>{member.area} · {member.style}</p><div className="member-profile-meta"><strong>{member.dupr_rating ? `DUPR ${member.dupr_rating.toFixed(1)}` : "DUPR not set"}</strong><span>{Math.round(member.reliability * 100)}% reliable</span></div></div></article>)}</div><button className="dark-button modal-join" onClick={() => void joinSession(viewedGroup.session.id, viewedGroup.session.group_name)}>Request to join <span>→</span></button></section></div>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

interface SpeechRecognitionEvent extends Event { results: { [index: number]: { [index: number]: { transcript: string } } } }
interface SpeechRecognition { lang: string; onstart: () => void; onend: () => void; onresult: (event: SpeechRecognitionEvent) => void; start: () => void }
