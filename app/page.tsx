"use client";

import { FormEvent, useEffect, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";

import { auth, isFirebaseConfigured } from "../firebase";

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
  availability: string[];
};

type JoinRequest = {
  id: string;
  session_id: string;
  player_id: string;
  player_display_name?: string;
  status: "pending" | "approved" | "declined";
  created_at?: string;
};

type ActivityGroup = {
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
  status: string;
};

type ActivityRequest = {
  request: JoinRequest;
  session: ActivityGroup;
};

type ChatPost = {
  id: string;
  player_id: string;
  player_display_name: string;
  message: string;
  created_at: string;
};

type LeaderboardEntry = {
  rank: number;
  score: number;
  ratings_count: number;
  player: {
    id: string;
    display_name: string;
    area: string;
    dupr_rating?: number | null;
    community_score?: number | null;
    community_rating_count: number;
  };
};

type ActivityTab = "requests" | "groups" | "games";
type AppTab = "search" | "explore" | "games" | "profile";
type GamesViewTab = "requested" | "approved";

type ProfileDraft = {
  dupr_rating: string;
  area: string;
  style: "casual" | "social" | "competitive";
  availability: string[];
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

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const availabilityOptions = ["weekday mornings", "weekday evenings", "weekend mornings", "weekend evenings"];

export default function Home() {
  const [query, setQuery] = useState("Find me a casual intermediate game near Whitefield this Sunday morning");
  const [sessions, setSessions] = useState(demoSessions);
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groupProposal, setGroupProposal] = useState<GroupProposal | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ dupr_rating: "", area: "Whitefield", style: "casual", availability: [] });
  const [authReady, setAuthReady] = useState(false);
  const [managedGroupId, setManagedGroupId] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [viewedGroup, setViewedGroup] = useState<GroupView | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [myRequests, setMyRequests] = useState<ActivityRequest[]>([]);
  const [myGroups, setMyGroups] = useState<ActivityGroup[]>([]);
  const [approvedGames, setApprovedGames] = useState<ActivityGroup[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [workspaceGroup, setWorkspaceGroup] = useState<ActivityGroup | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [chatPosts, setChatPosts] = useState<ChatPost[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [groupLeaderboard, setGroupLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [localLeaderboard, setLocalLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<AppTab>("search");
  const [gamesViewTab, setGamesViewTab] = useState<GamesViewTab>("requested");
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
      if (nextUser) {
        void loadProfile(nextUser);
        void loadActivity("requests", nextUser);
      }
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
      const nextProfile = await response.json() as PlayerProfile;
      setProfile(nextProfile);
      setProfileDraft({ dupr_rating: nextProfile.dupr_rating?.toString() ?? "", area: nextProfile.area, style: nextProfile.style as ProfileDraft["style"], availability: nextProfile.availability ?? [] });
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
    setProfileDraft({ dupr_rating: "", area: "Whitefield", style: "casual", availability: [] });
    setManagedGroupId(null);
    setWorkspaceGroup(null);
    setChatPosts([]);
    setGroupLeaderboard([]);
    setLocalLeaderboard([]);
    setJoinRequests([]);
    setMyRequests([]);
    setMyGroups([]);
    setApprovedGames([]);
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
      const updatedProfile = await response.json() as PlayerProfile;
      setProfile(updatedProfile);
      setProfileDraft((draft) => ({ ...draft, dupr_rating: rating.toString() }));
      setToast("DUPR profile updated");
    } catch {
      setToast("Could not update your DUPR profile");
    }
  }

  async function saveProfile(event?: FormEvent) {
    event?.preventDefault();
    if (!user) {
      setToast("Sign in with Google before updating your profile");
      return;
    }
    const body: { area: string; style: string; availability: string[]; dupr_rating?: number } = {
      area: profileDraft.area.trim() || "Whitefield",
      style: profileDraft.style,
      availability: profileDraft.availability,
    };
    if (profileDraft.dupr_rating.trim()) {
      const rating = Number(profileDraft.dupr_rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 8) {
        setToast("DUPR rating must be between 1.0 and 8.0");
        return;
      }
      body.dupr_rating = rating;
    }
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("Profile update failed");
      const updatedProfile = await response.json() as PlayerProfile;
      setProfile(updatedProfile);
      setProfileDraft({ dupr_rating: updatedProfile.dupr_rating?.toString() ?? "", area: updatedProfile.area, style: updatedProfile.style as ProfileDraft["style"], availability: updatedProfile.availability ?? [] });
      setToast("Profile preferences saved");
    } catch {
      setToast("Could not save your profile preferences");
    }
  }

  function toggleAvailability(slot: string) {
    setProfileDraft((draft) => ({ ...draft, availability: draft.availability.includes(slot) ? draft.availability.filter((item) => item !== slot) : [...draft.availability, slot] }));
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
      setGroupNameDraft(payload.group_proposal?.group_name ?? "");
      setToast(payload.message || "Gemini searched live session data");
    } catch {
      setSessions(demoSessions);
      setGroupProposal(null);
      setGroupNameDraft("");
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
        body: JSON.stringify({ query, group_name: groupNameDraft.trim() || undefined }),
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
      setManagedGroupId(createdSession.id);
      void loadActivity("groups");
      setToast(payload.message);
    } catch {
      setToast("Could not create the group. Check that the API is running.");
    } finally {
      setCreateGroupLoading(false);
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
      void loadActivity("requests");
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

  function toActivityGroup(group: ActivityGroup | Session): ActivityGroup {
    return {
      id: group.id,
      group_name: group.group_name,
      area: group.area,
      session_date: group.session_date,
      start_time: group.start_time,
      end_time: group.end_time,
      skill_min: group.skill_min,
      skill_max: group.skill_max,
      style: group.style,
      capacity: group.capacity,
      confirmed_player_ids: group.confirmed_player_ids,
      external_booking_url: group.external_booking_url,
      status: "status" in group && group.status ? group.status : "open",
    };
  }

  async function openGroupSpace(group: ActivityGroup | Session) {
    const normalizedGroup = toActivityGroup(group);
    setWorkspaceGroup(normalizedGroup);
    setWorkspaceLoading(true);
    setChatDraft("");
    setPlayerRatings({});
    try {
      const [chatResponse, groupResponse, localResponse] = await Promise.all([
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/chat`),
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/leaderboard`),
        authorizedFetch(`${apiUrl}/v1/leaderboards/local?area=${encodeURIComponent(normalizedGroup.area)}`),
      ]);
      if (!chatResponse.ok || !groupResponse.ok || !localResponse.ok) throw new Error("Group space unavailable");
      const chatPayload = await chatResponse.json() as { posts: ChatPost[] };
      const groupPayload = await groupResponse.json() as { entries: LeaderboardEntry[] };
      const localPayload = await localResponse.json() as { entries: LeaderboardEntry[] };
      setChatPosts(chatPayload.posts);
      setGroupLeaderboard(groupPayload.entries);
      setLocalLeaderboard(localPayload.entries);
    } catch {
      setToast("Only confirmed group members can open this group space");
      setWorkspaceGroup(null);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function postChat(event?: FormEvent) {
    event?.preventDefault();
    if (!workspaceGroup || !chatDraft.trim()) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${workspaceGroup.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: chatDraft.trim() }),
      });
      if (!response.ok) throw new Error("Chat post failed");
      setChatDraft("");
      const refreshed = await authorizedFetch(`${apiUrl}/v1/sessions/${workspaceGroup.id}/chat`);
      if (refreshed.ok) setChatPosts((await refreshed.json() as { posts: ChatPost[] }).posts);
    } catch {
      setToast("Could not post to the group chat");
    }
  }

  async function submitGroupFeedback(event?: FormEvent) {
    event?.preventDefault();
    if (!workspaceGroup) return;
    const ratings = Object.entries(playerRatings).filter(([, rating]) => rating).map(([player_id, rating]) => ({ player_id, rating: Number(rating) }));
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${workspaceGroup.id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fun: Number(feedbackFun), fairness: Number(feedbackFairness), would_return: feedbackWouldReturn, ratings }),
      });
      if (!response.ok) throw new Error("Feedback failed");
      setToast("Feedback saved and leaderboards updated");
      await openGroupSpace(workspaceGroup);
    } catch {
      setToast("Could not save your post-game feedback");
    }
  }

  async function loadJoinRequests(groupId: string | null = managedGroupId) {
    if (!groupId) return;
    setRequestsLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${groupId}/join-requests`);
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

  async function loadActivity(tab: ActivityTab, authUser: User | null = user) {
    if (!authUser) return;
    setActivityLoading(true);
    try {
      const endpoint = tab === "requests" ? "/v1/me/requests" : tab === "groups" ? "/v1/me/groups" : "/v1/me/games";
      const response = await authorizedFetch(`${apiUrl}${endpoint}`, {}, authUser);
      if (!response.ok) throw new Error("Activity unavailable");
      if (tab === "requests") {
        const payload = await response.json() as { requests: ActivityRequest[] };
        setMyRequests(payload.requests);
      } else if (tab === "groups") {
        const payload = await response.json() as { groups: ActivityGroup[] };
        setMyGroups(payload.groups);
      } else {
        const payload = await response.json() as { games: ActivityGroup[] };
        setApprovedGames(payload.games);
      }
    } catch {
      setToast("Could not load your CourtMate activity");
    } finally {
      setActivityLoading(false);
    }
  }

  function addToGoogleCalendar(game: ActivityGroup) {
    const compactDate = game.session_date.replaceAll("-", "");
    const compactTime = (value: string) => `${value.replace(":", "")}00`;
    const start = `${compactDate}T${compactTime(game.start_time)}`;
    const end = `${compactDate}T${compactTime(game.end_time)}`;
    const calendarUrl = new URL("https://calendar.google.com/calendar/render");
    calendarUrl.searchParams.set("action", "TEMPLATE");
    calendarUrl.searchParams.set("text", `Pickleball · ${game.group_name}`);
    calendarUrl.searchParams.set("dates", `${start}/${end}`);
    calendarUrl.searchParams.set("details", "CourtMate confirmed game. Book the court through your group or venue platform.");
    calendarUrl.searchParams.set("location", `${game.area}, Bengaluru`);
    window.open(calendarUrl.toString(), "_blank", "noopener,noreferrer");
  }

  async function decideJoinRequest(requestId: string, status: "approved" | "declined") {
    if (!managedGroupId) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${managedGroupId}/join-requests/${requestId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error("Decision failed");
      await loadJoinRequests(managedGroupId);
      await loadActivity("groups");
      setToast(status === "approved" ? "Player approved for the group" : "Request declined");
    } catch {
      setToast("Could not update this join request");
    } finally {
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function selectTab(tab: AppTab) {
    setActiveTab(tab);
    setViewedGroup(null);
    if (tab === "explore") {
      const exploreQuery = "Find nearby pickleball games matching my DUPR rating in Whitefield";
      setQuery(exploreQuery);
      void search(undefined, exploreQuery);
    }
    if (tab === "games") {
      void Promise.all([loadActivity("requests"), loadActivity("games"), loadActivity("groups")]);
    }
  }

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">CM</span><span>CourtMate</span></div>
        <div className="nav-right"><span className="location-pill"><span className="dot" /> Whitefield, Bengaluru</span>{user ? <><span className="user-name">{user.displayName ?? user.email}</span><button className="avatar" onClick={() => selectTab("profile")} title="Open profile">{(user.displayName ?? user.email ?? "C")[0].toUpperCase()}</button></> : <button className="sign-in-button" onClick={() => void signIn()}>{authReady ? "Sign in with Google" : "Loading auth"}</button>}</div>
      </nav>
      <nav className="app-tabs" aria-label="CourtMate sections">
        <button className={activeTab === "search" ? "active" : ""} onClick={() => selectTab("search")} title="Search game">Search</button>
        <button className={activeTab === "explore" ? "active" : ""} onClick={() => selectTab("explore")} title="Explore nearby games">Explore</button>
        <button className={activeTab === "games" ? "active" : ""} onClick={() => selectTab("games")} title="Your games">Games</button>
        <button className={activeTab === "profile" ? "active" : ""} onClick={() => selectTab("profile")}>Profile</button>
      </nav>
      {(activeTab === "search" || activeTab === "explore") && <>
      <section className="hero">
        <div className="eyebrow">{activeTab === "search" ? "SEARCH THE GROUP LAYER" : "MATCHED TO YOUR PROFILE"}</div>
        <h1>{activeTab === "search" ? <>Find your people.<br /><em>Fill the court.</em></> : <>Games that fit.<br /><em>Your level.</em></>}</h1>
        <p className="hero-copy">{activeTab === "search" ? "Tell CourtMate exactly how you want to play and we&apos;ll find the group that fits." : "Browse nearby pickleball groups filtered by your DUPR rating, locality, and play preference."}</p>
        {activeTab === "search" ? <form className="search-box" onSubmit={search}>
          <div className="search-icon">⌕</div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search pickleball groups" />
          <button type="button" className={`mic ${isListening ? "listening" : ""}`} onClick={startVoice} aria-label="Start voice search">{isListening ? "●" : "⌕"}</button>
          <button className="search-button" type="submit">{loading ? "Searching" : "Find a game"}<span>↗</span></button>
        </form> : <button className="explore-refresh-button" onClick={() => { const exploreQuery = "Find nearby pickleball games matching my DUPR rating in Whitefield"; void search(undefined, exploreQuery); }}>{loading ? "Refreshing matches" : "Refresh nearby matches"}<span>↗</span></button>}
        {activeTab === "search" && <div className="quick-prompts"><span>Try asking</span><button onClick={() => setQuery("Show me groups like my Sunday crew")}>Groups like my Sunday crew</button><button onClick={() => setQuery("Find a replacement for tonight")}>Find a replacement</button></div>}
      </section>

      <section className="content-grid search-layout">
        <div className="results-column">
          <div className="section-heading"><div><span className="kicker">{activeTab === "search" ? "GROUP DISCOVERY" : "MATCHING YOUR PROFILE"}</span><h2>{sessions.length ? activeTab === "search" ? "Groups that fit your ask" : "Nearby games at your level" : "No exact match yet"}</h2></div><span className="result-count">{sessions.length} good fits</span></div>
          <div className="reason-strip"><span className="spark">✦</span><span><strong>AI read:</strong> {profile?.dupr_rating ? `Your DUPR ${profile.dupr_rating.toFixed(1)} profile is being used for skill matching.` : "Set your DUPR rating so CourtMate can make skill-aware recommendations."}</span>{profile && <button className="profile-action" onClick={() => void setDUPRRating()}>{profile.dupr_rating ? "Update" : "Set DUPR"}</button>}</div>
          {!sessions.length && groupProposal && <div className="empty-state"><span className="empty-icon">+</span><span className="kicker">START THE NEXT GROUP</span><label className="group-name-editor"><span>Group name</span><input value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} aria-label="Group name" /></label><p>{groupProposal.explanation}</p><div className="tags"><span className="tag rating">DUPR {groupProposal.skill_min.toFixed(1)}–{groupProposal.skill_max.toFixed(1)}</span><span className="tag">{groupProposal.style}</span><span className="tag open">{groupProposal.area}</span></div><button className="join-button create-button" disabled={!groupNameDraft.trim() || createGroupLoading} onClick={() => void createGroup()}>{createGroupLoading ? "Creating group" : "Create this group"}<span>↗</span></button></div>}
          <div className="session-list">
            {sessions.map((session, index) => <article className={`session-card ${index === 0 ? "featured" : ""}`} key={session.id}>
              <div className="card-top"><span className="date-badge"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(session.session_date).getDate()}</small></span><div className="session-meta"><div className="session-title-row"><h3>{session.group_name}</h3><span className="fit-score">{Math.round(session.score * 100)}% fit</span></div><p>{session.start_time} – {session.end_time} · {session.area}</p></div><button className="more">•••</button></div>
              <div className="tags"><span className="tag rating">DUPR {session.skill_min.toFixed(1)}–{session.skill_max.toFixed(1)}</span><span className="tag">{session.style}</span><span className="tag open">{session.open_slots} spots open</span></div>
              <p className="explanation"><span>✦</span>{session.explanation}</p>
              <div className="card-bottom"><div className="member-stack"><span className="member coral">A</span><span className="member green">K</span><span className="member blue">R</span><span className="member-count">+{session.confirmed_player_ids.length + 2}</span></div><div className="card-actions"><button className="join-button secondary-button" onClick={() => void viewGroup(session.id)}>{groupLoading ? "Loading" : "View group"}</button><button className="join-button" onClick={() => void joinSession(session.id, session.group_name)}>Request to join <span>↗</span></button></div></div>
            </article>)}
          </div>
        </div>

      </section>
      </>}

      {activeTab === "games" && <section className="page-view games-page">
        <div className="page-heading"><span className="kicker">YOUR GAMES</span><h1>Know where you stand.</h1><p>Track requests, accepted games, and the groups you organize in one place.</p></div>
        <div className="page-tabs"><button className={gamesViewTab === "requested" ? "active" : ""} onClick={() => setGamesViewTab("requested")}>Requested <span>{myRequests.length}</span></button><button className={gamesViewTab === "approved" ? "active" : ""} onClick={() => setGamesViewTab("approved")}>Approved <span>{approvedGames.length}</span></button></div>
        {activityLoading && <p className="page-loading">Refreshing your games...</p>}
        {!activityLoading && gamesViewTab === "requested" && <div className="game-list">{myRequests.length ? myRequests.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{session.start_time}–{session.end_time} · {session.area}</p></div><span className={`status-badge ${request.status}`}>{request.status}</span></article>) : <div className="page-empty"><strong>No requests yet.</strong><p>Search for a group and request to join. The organizer will review your request.</p><button className="dark-button" onClick={() => selectTab("search")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "approved" && <div className="game-list">{approvedGames.length ? approvedGames.map((game) => <article className="game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button></div></article>) : <div className="page-empty"><strong>No approved games yet.</strong><p>Once an organizer accepts your request, the game will appear here ready for your calendar.</p><button className="dark-button" onClick={() => selectTab("explore")}>Explore nearby <span>→</span></button></div>}</div>}
        {myGroups.length > 0 && <div className="organizer-page-card"><div><span className="kicker">ORGANIZER</span><h2>Your groups</h2><p>Manage requests, chat, and feedback for groups you created.</p></div>{myGroups.map((group) => <div className="organizer-page-row" key={group.id}><div><strong>{group.group_name}</strong><small>{group.session_date} · {group.confirmed_player_ids.length}/{group.capacity} players</small></div><div className="organizer-page-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(group)}>Group space</button><button className="manage-group-button" onClick={() => { setManagedGroupId(group.id); void loadJoinRequests(group.id); }}>Requests</button></div></div>)}{managedGroupId && <div className="request-card page-request-card"><p>Requests for <strong>{myGroups.find((group) => group.id === managedGroupId)?.group_name ?? "your group"}</strong>. Approve a player before they join.</p>{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? <div className="request-list">{joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved")}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined")}>Decline</button></div>}</div>)}</div> : <p className="request-empty">No requests waiting for approval.</p>}</div>}</div>}
      </section>}

      {activeTab === "profile" && <section className="page-view profile-page">
        <div className="page-heading"><span className="kicker">YOUR PROFILE</span><h1>Set up your best match.</h1><p>CourtMate uses these details to find groups that fit your level, location, schedule, and energy.</p></div>
        {!user && <div className="page-empty"><strong>Sign in to manage your profile.</strong><p>Your rating and preferences are saved securely to your CourtMate profile.</p><button className="dark-button" onClick={() => void signIn()}>Sign in with Google <span>→</span></button></div>}
        {user && profile && <form className="profile-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>DUPR rating</span><input type="number" min="1" max="8" step="0.1" value={profileDraft.dupr_rating} onChange={(event) => setProfileDraft({ ...profileDraft, dupr_rating: event.target.value })} placeholder="e.g. 3.2" /></label><label><span>Locality</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label></div><label><span>How do you like to play?</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>When are you usually available?</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save profile <span>→</span></button><span>Used for skill-aware recommendations</span><button className="text-button" type="button" onClick={() => void signOutUser()}>Sign out</button></div></form>}
      </section>}

      <footer className="footer"><span>CourtMate is not a booking app.</span><span>Book your court on Playo, Hudle, or with your venue.</span></footer>
      {workspaceGroup && <div className="group-modal-backdrop" onClick={() => setWorkspaceGroup(null)}><section className="workspace-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">GROUP SPACE</span><h2>{workspaceGroup.group_name}</h2><p>{workspaceGroup.session_date} · {workspaceGroup.start_time}–{workspaceGroup.end_time} · {workspaceGroup.area}</p></div><button className="close-button" onClick={() => setWorkspaceGroup(null)}>×</button></div>{workspaceLoading ? <p className="page-loading">Loading group space...</p> : <div className="workspace-grid"><section className="workspace-panel chat-panel"><div className="workspace-panel-heading"><div><span className="kicker">LIVE POSTING CHAT</span><h3>Coordinate the session</h3></div><button className="workspace-refresh" onClick={() => void openGroupSpace(workspaceGroup)}>Refresh</button></div><div className="chat-feed">{chatPosts.length ? chatPosts.map((post) => <article className={`chat-post ${post.player_id === user?.uid ? "mine" : ""}`} key={post.id}><div className="chat-avatar">{post.player_display_name[0]}</div><div><strong>{post.player_display_name}</strong><p>{post.message}</p><small>{new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div></article>) : <p className="activity-empty">No posts yet. Start coordinating the game.</p>}</div><form className="chat-composer" onSubmit={postChat}><input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} maxLength={500} placeholder="Post an update to the group..." aria-label="Group chat message" /><button className="dark-button" type="submit" disabled={!chatDraft.trim()}>Post</button></form></section><section className="workspace-panel leaderboard-panel"><div className="workspace-panel-heading"><div><span className="kicker">GROUP LEADERBOARD</span><h3>Local legends in this group</h3></div></div><div className="leaderboard-list">{groupLeaderboard.length ? groupLeaderboard.map((entry) => <div className="leaderboard-row" key={entry.player.id}><span className="rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.player.community_rating_count ? `${entry.ratings_count} community rating(s)` : `DUPR ${entry.player.dupr_rating?.toFixed(1) ?? "unrated"}`}</small></div><b>{entry.score.toFixed(1)}</b></div>) : <p className="activity-empty">Leaderboard scores appear after players have ratings.</p>}</div><div className="local-leaderboard"><span className="kicker">{workspaceGroup.area.toUpperCase()} LEADERBOARD</span>{localLeaderboard.slice(0, 5).map((entry) => <div className="local-row" key={entry.player.id}><span>#{entry.rank}</span><strong>{entry.player.display_name}</strong><b>{entry.score.toFixed(1)}</b></div>)}</div></section><form className="workspace-panel feedback-panel" onSubmit={submitGroupFeedback}><div className="workspace-panel-heading"><div><span className="kicker">POST-GAME FEEDBACK</span><h3>Was this a fun, fair group?</h3></div></div><div className="feedback-fields"><label><span>Fun</span><select value={feedbackFun} onChange={(event) => setFeedbackFun(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label><label><span>Fairness</span><select value={feedbackFairness} onChange={(event) => setFeedbackFairness(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label></div><label className="return-check"><input type="checkbox" checked={feedbackWouldReturn} onChange={(event) => setFeedbackWouldReturn(event.target.checked)} /><span>Would you play with this group again?</span></label><fieldset className="player-rating-fields"><legend>Rate other players</legend>{groupLeaderboard.filter((entry) => entry.player.id !== user?.uid).map((entry) => <label key={entry.player.id}><span>{entry.player.display_name}</span><select value={playerRatings[entry.player.id] ?? ""} onChange={(event) => setPlayerRatings({ ...playerRatings, [entry.player.id]: event.target.value })}><option value="">Skip</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label>)}</fieldset><button className="dark-button" type="submit">Save feedback <span>→</span></button></form></div>}</section></div>}
      {viewedGroup && <div className="group-modal-backdrop" onClick={() => setViewedGroup(null)}><section className="group-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">GROUP PREVIEW</span><h2>{viewedGroup.session.group_name}</h2><p>{viewedGroup.session.start_time} – {viewedGroup.session.end_time} · {viewedGroup.session.area}</p></div><button className="close-button" onClick={() => setViewedGroup(null)}>×</button></div><div className="group-summary"><span><strong>{viewedGroup.members.length}/{viewedGroup.session.capacity}</strong><small>PLAYERS</small></span><span><strong>{viewedGroup.session.skill_min.toFixed(1)}–{viewedGroup.session.skill_max.toFixed(1)}</strong><small>DUPR BAND</small></span><span><strong>{viewedGroup.session.style}</strong><small>INTENSITY</small></span></div><div className="member-grid">{viewedGroup.members.map((member) => <article className="member-profile" key={member.id}><div className="member-profile-avatar">{member.display_name[0]}</div><div className="member-profile-copy"><h3>{member.display_name}</h3><p>{member.area} · {member.style}</p><div className="member-profile-meta"><strong>{member.dupr_rating ? `DUPR ${member.dupr_rating.toFixed(1)}` : "DUPR not set"}</strong><span>{Math.round(member.reliability * 100)}% reliable</span></div></div></article>)}</div><button className="dark-button modal-join" onClick={() => void joinSession(viewedGroup.session.id, viewedGroup.session.group_name)}>Request to join <span>→</span></button></section></div>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

interface SpeechRecognitionEvent extends Event { results: { [index: number]: { [index: number]: { transcript: string } } } }
interface SpeechRecognition { lang: string; onstart: () => void; onend: () => void; onresult: (event: SpeechRecognitionEvent) => void; start: () => void }
