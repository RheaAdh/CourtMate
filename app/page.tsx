"use client";

import { FormEvent, useEffect, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { auth, isFirebaseConfigured, storage } from "../firebase";
import { PostGameFeedbackPanel } from "./post-game-feedback";
import { TournamentHub } from "./tournament-hub";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";

const sportOptions: { value: Sport; label: string }[] = [
  { value: "pickleball", label: "Pickleball" },
  { value: "badminton", label: "Badminton" },
  { value: "tennis", label: "Tennis" },
  { value: "padel", label: "Padel" },
  { value: "squash", label: "Squash" },
  { value: "table_tennis", label: "Table tennis" },
];

const sportLabel = (sport: Sport | string) => sportOptions.find((option) => option.value === sport)?.label ?? sport.replaceAll("_", " ");
const sportFromText = (text: string): Sport | null => {
  const lowered = text.toLowerCase();
  return sportOptions.find((option) => lowered.includes(option.label.toLowerCase()))?.value ?? (lowered.includes("ping pong") ? "table_tennis" : null);
};

type Session = {
  id: string;
  organizer_id: string;
  group_name: string;
  sport: Sport;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  venue_name?: string | null;
  session_date: string;
  start_time: string;
  end_time: string;
  skill_min: number;
  skill_max: number;
  style: string;
  capacity: number;
  confirmed_player_ids: string[];
  waitlist_player_ids?: string[];
  external_booking_url?: string;
  status?: string;
  open_slots: number;
  score: number;
  explanation: string;
};

type GroupProposal = {
  group_name: string;
  sport: Sport;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  venue_name?: string | null;
  session_date?: string;
  start_time?: string;
  end_time?: string;
  skill_min: number;
  skill_max: number;
  style: string;
  explanation: string;
};

type CreateGroupDraft = {
  sport: Sport;
  area: string;
  session_date: string;
  start_time: string;
  end_time: string;
  skill_min: string;
  skill_max: string;
  style: "casual" | "social" | "competitive";
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
  profile_image_url?: string | null;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  travel_radius_km?: number;
  skill_levels?: Record<string, "beginner" | "intermediate" | "advanced">;
  dupr_rating?: number | null;
  sport_ratings?: Record<string, number>;
  cmr_ratings?: Record<string, number>;
  cmr_game_counts?: Record<string, number>;
  cmr_history?: Record<string, CMRHistoryPoint[]>;
  rating_source: string;
  style: string;
  availability: string[];
  reliability: number;
};

type PublicPlayerProfile = {
  id: string;
  display_name: string;
  profile_image_url?: string | null;
  area: string;
  dupr_rating?: number | null;
  rating_source: string;
  sport_ratings?: Record<string, number>;
  rating_sources?: Record<string, string>;
  style: string;
  reliability: number;
  community_score?: number | null;
  community_rating_count: number;
  community_scores?: Record<string, number>;
  community_rating_counts?: Record<string, number>;
  cmr_ratings?: Record<string, number>;
  cmr_game_counts?: Record<string, number>;
  followers_count: number;
  following_count: number;
  is_following: boolean;
  follows_you: boolean;
  recent_games: ProfileGameSummary[];
  activity_by_date: Record<string, number>;
};

type ProfileGameSummary = {
  id: string;
  group_name: string;
  sport: Sport;
  area: string;
  session_date: string;
  start_time: string;
  status: string;
};

type JoinRequest = {
  id: string;
  session_id: string;
  player_id: string;
  player_display_name?: string;
  status: "pending" | "approved" | "declined" | "waitlisted" | "withdrawn";
  created_at?: string;
};

type ActivityGroup = {
  id: string;
  organizer_id: string;
  group_name: string;
  sport: Sport;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  venue_name?: string | null;
  session_date: string;
  start_time: string;
  end_time: string;
  skill_min: number;
  skill_max: number;
  style: string;
  capacity: number;
  confirmed_player_ids: string[];
  waitlist_player_ids?: string[];
  external_booking_url?: string;
  status: string;
};

type ActivityRequest = {
  request: JoinRequest;
  session: ActivityGroup;
};

type PastGame = {
  session: ActivityGroup;
  rank?: number | null;
  score?: number | null;
  ratings_count: number;
  group_size: number;
};

type ChatPost = {
  id: string;
  player_id: string;
  player_display_name: string;
  message: string;
  created_at: string;
};

type AppNotification = {
  id: string;
  kind: "game_match" | "join_request" | "request_update" | "follow";
  title: string;
  message: string;
  session_id: string;
  request_id?: string | null;
  actor_id?: string | null;
  read: boolean;
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
    cmr_ratings?: Record<string, number>;
    cmr_game_counts?: Record<string, number>;
  };
};

type CMRHistoryPoint = {
  session_id: string;
  session_date: string;
  group_name: string;
  game_rating?: number | null;
  rating?: number | null;
  delta?: number | null;
};

type ActivityTab = "requests" | "groups" | "games" | "incoming";
type AppTab = "home" | "games" | "profile" | "tournaments" | "about";
type GamesViewTab = "pending" | "upcoming" | "history" | "requested" | "confirmed" | "past" | "incoming";

type ProfileDraft = {
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  travel_radius_km: string;
  style: "casual" | "social" | "competitive";
  availability: string[];
};

type GroupMember = PublicPlayerProfile & { rating_confidence: number };

type GroupView = {
  session: Session;
  members: GroupMember[];
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const availabilityOptions = ["weekday mornings", "weekday evenings", "weekend mornings", "weekend evenings"];

function cmrLevelForRating(rating: number): string {
  return rating < 26 ? "Beginner" : rating < 47 ? "Intermediate" : "Advanced";
}

function cmrGraphPoints(history: CMRHistoryPoint[]): string {
  const width = 560;
  const height = 190;
  const padding = 28;
  const ratedHistory = history.filter((point) => point.rating != null);
  return ratedHistory.map((point, index) => {
    const x = ratedHistory.length === 1 ? width / 2 : padding + (index * (width - padding * 2)) / (ratedHistory.length - 1);
    const y = height - padding - (Math.max(0, Math.min(100, point.rating ?? 0)) * (height - padding * 2)) / 100;
    return `${x},${y}`;
  }).join(" ");
}

function localDateInput(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

function SearchGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 5 5" /></svg>;
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

function activityDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ActivityHeatmap({ activity }: { activity: Record<string, number> }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 77);
  const days = Array.from({ length: 84 }, (_, index) => {
    const value = new Date(start);
    value.setDate(start.getDate() + index);
    const key = activityDateKey(value);
    return { key, value, count: activity[key] ?? 0, future: value > today };
  });
  const activeDays = Object.values(activity).filter((count) => count > 0).length;
  return <div className="activity-heatmap"><div className="activity-heatmap-labels"><span>{activeDays} active day{activeDays === 1 ? "" : "s"}</span><span>12 weeks</span></div><div className="activity-heatmap-grid" aria-label="Recent activity calendar">{days.map((day) => <span className={`activity-cell activity-level-${Math.min(day.count, 4)} ${day.future ? "future" : ""}`} key={day.key} title={`${day.key}: ${day.count} game${day.count === 1 ? "" : "s"}`} aria-label={`${day.key}: ${day.count} game${day.count === 1 ? "" : "s"}`} />)}</div><div className="activity-heatmap-legend"><span>Less</span><i className="activity-cell activity-level-0" /><i className="activity-cell activity-level-1" /><i className="activity-cell activity-level-2" /><i className="activity-cell activity-level-3" /><i className="activity-cell activity-level-4" /><span>More</span></div></div>;
}

function RecentGames({ games }: { games: ProfileGameSummary[] }) {
  if (!games.length) return <p className="profile-activity-empty">No completed games yet. Their activity will appear here after they play.</p>;
  return <div className="recent-games-list">{games.map((game) => <article className="recent-game-row" key={game.id}><span className="recent-game-date"><strong>{new Date(`${game.session_date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit" })}</strong><small>{new Date(`${game.session_date}T00:00:00`).toLocaleDateString("en-IN", { month: "short" })}</small></span><div><strong>{game.group_name}</strong><small>{sportLabel(game.sport)} · {game.area} · {game.start_time}</small></div><span className="recent-game-status">{game.status === "played" ? "Played" : game.status}</span></article>)}</div>;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [selectedSport, setSelectedSport] = useState<Sport>("pickleball");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groupProposal, setGroupProposal] = useState<GroupProposal | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [createGroupDraft, setCreateGroupDraft] = useState<CreateGroupDraft>({ sport: "pickleball", area: "", session_date: localDateInput(), start_time: "19:00", end_time: "21:00", skill_min: "3.0", skill_max: "3.5", style: "casual" });
  const [createQuery, setCreateQuery] = useState("");
  const [showCreateGame, setShowCreateGame] = useState(false);
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ area: "Whitefield", travel_radius_km: "10", style: "casual", availability: [] });
  const [profilePictureUploading, setProfilePictureUploading] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [managedGroupId, setManagedGroupId] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [viewedGroup, setViewedGroup] = useState<GroupView | null>(null);
  const [loadingGroupId, setLoadingGroupId] = useState<string | null>(null);
  const [myRequests, setMyRequests] = useState<ActivityRequest[]>([]);
  const [myGroups, setMyGroups] = useState<ActivityGroup[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ActivityRequest[]>([]);
  const [approvedGames, setApprovedGames] = useState<ActivityGroup[]>([]);
  const [pastGames, setPastGames] = useState<PastGame[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [workspaceGroup, setWorkspaceGroup] = useState<ActivityGroup | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [chatPosts, setChatPosts] = useState<ChatPost[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [groupLeaderboard, setGroupLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [localLeaderboard, setLocalLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [socialProfile, setSocialProfile] = useState<PublicPlayerProfile | null>(null);
  const [viewedProfile, setViewedProfile] = useState<PublicPlayerProfile | null>(null);
  const [profileLoadingId, setProfileLoadingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [gamesViewTab, setGamesViewTab] = useState<GamesViewTab>("upcoming");
  const [toast, setToast] = useState("");

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      if (process.env.NODE_ENV === "production") {
        void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      } else {
        void navigator.serviceWorker.getRegistration("/sw.js").then((registration) => registration?.unregister());
      }
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
        void loadSocialProfile(nextUser);
        void loadActivity("requests", nextUser);
        void loadNotifications(nextUser);
        void search(undefined, `Show me nearby ${selectedSport} games that match my saved preferences`, false, nextUser);
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    const interval = window.setInterval(() => void loadNotifications(user), 30000);
    return () => window.clearInterval(interval);
  }, [user]);

  useEffect(() => {
    if (!workspaceGroup && !viewedGroup && !viewedProfile) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceGroup(null);
        setViewedGroup(null);
        setViewedProfile(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [workspaceGroup, viewedGroup, viewedProfile]);

  async function authorizedFetch(url: string, options: RequestInit = {}, authUser: User | null = user) {
    if (!authUser) throw new Error("Sign in required");
    const token = await authUser.getIdToken();
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  }

  async function uploadProfilePicture(file: File) {
    if (!user) return;
    if (!storage) {
      setToast("Firebase Storage is not configured");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setToast("Choose a JPG, PNG, or WebP image");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setToast("Profile photos must be smaller than 5 MB");
      return;
    }
    try {
      setProfilePictureUploading(true);
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const imageRef = ref(storage, `profile-images/${user.uid}/${crypto.randomUUID()}.${extension}`);
      const upload = await uploadBytes(imageRef, file, { contentType: file.type });
      const imageUrl = await getDownloadURL(upload.ref);
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_image_url: imageUrl }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Profile photo could not be saved");
      }
      const savedProfile = await response.json() as PlayerProfile;
      setProfile(savedProfile);
      setSocialProfile((current) => current ? { ...current, profile_image_url: imageUrl } : current);
      setToast("Profile photo updated");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not upload profile photo");
    } finally {
      setProfilePictureUploading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function loadNotifications(authUser: User = user as User) {
    if (!authUser) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/notifications`, {}, authUser);
      if (!response.ok) throw new Error("Notifications unavailable");
      const payload = await response.json() as { notifications: AppNotification[] };
      setNotifications(payload.notifications);
    } catch {
      // Notifications are supplementary; keep the rest of the app usable if unavailable.
    }
  }

  async function loadSocialProfile(authUser: User = user as User) {
    if (!authUser) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/players/${authUser.uid}`, {}, authUser);
      if (!response.ok) throw new Error("Social profile unavailable");
      setSocialProfile(await response.json() as PublicPlayerProfile);
    } catch {
      // Social details are supplementary to the editable profile.
    }
  }

  async function viewPlayerProfile(playerId: string) {
    setProfileLoadingId(playerId);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/players/${playerId}`);
      if (!response.ok) throw new Error("Player profile unavailable");
      setViewedProfile(await response.json() as PublicPlayerProfile);
    } catch {
      setToast("Could not load this player profile");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setProfileLoadingId(null);
    }
  }

  async function toggleFollowProfile() {
    if (!viewedProfile || !user || viewedProfile.id === user.uid) return;
    const wasFollowing = viewedProfile.is_following;
    try {
      const action = wasFollowing ? "unfollow" : "follow";
      const response = await authorizedFetch(`${apiUrl}/v1/players/${viewedProfile.id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error("Follow update failed");
      const nextProfile = await response.json() as PublicPlayerProfile;
      setViewedProfile(nextProfile);
      setSocialProfile((current) => current ? { ...current, following_count: Math.max(0, current.following_count + (wasFollowing ? -1 : 1)) } : current);
    } catch {
      setToast(wasFollowing ? "Could not unfollow this player" : "Could not follow this player");
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function markNotificationRead(notificationId: string) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/notifications/${notificationId}/read`, { method: "POST" });
      if (!response.ok) throw new Error("Notification update failed");
      setNotifications((items) => items.map((item) => item.id === notificationId ? { ...item, read: true } : item));
    } catch {
      setToast("Could not update this notification");
    }
  }

  async function decideNotificationRequest(notification: AppNotification, status: "approved" | "declined") {
    if (!notification.request_id) return;
    await markNotificationRead(notification.id);
    await decideJoinRequest(notification.request_id, status, notification.session_id);
    setNotificationsOpen(false);
  }

  function openNotification(notification: AppNotification) {
    if (!notification.read) void markNotificationRead(notification.id);
    setNotificationsOpen(false);
    if (notification.kind === "join_request") {
      setActiveTab("games");
      setGamesViewTab("upcoming");
      void loadActivity("incoming");
      return;
    }
    if (notification.kind === "request_update") {
      setActiveTab("games");
      setGamesViewTab("pending");
      void loadActivity("requests");
      return;
    }
    if (notification.kind === "follow" && notification.actor_id) {
      void viewPlayerProfile(notification.actor_id);
      return;
    }
    setActiveTab("home");
    setQuery("");
    void search(undefined, `Show me nearby ${selectedSport} games that match my saved preferences`, false);
  }

  async function loadProfile(authUser: User = user as User) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me`, {}, authUser);
      if (!response.ok) throw new Error("Profile unavailable");
      const nextProfile = await response.json() as PlayerProfile;
      setProfile(nextProfile);
      setProfileDraft({ area: nextProfile.area, latitude: nextProfile.latitude, longitude: nextProfile.longitude, travel_radius_km: nextProfile.travel_radius_km?.toString() ?? "10", style: nextProfile.style as ProfileDraft["style"], availability: nextProfile.availability ?? [] });
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
    setProfileDraft({ area: "Whitefield", travel_radius_km: "10", style: "casual", availability: [] });
    setManagedGroupId(null);
    setWorkspaceGroup(null);
    setChatPosts([]);
    setGroupMembers([]);
    setGroupLeaderboard([]);
    setLocalLeaderboard([]);
    setJoinRequests([]);
    setMyRequests([]);
    setMyGroups([]);
    setIncomingRequests([]);
    setApprovedGames([]);
    setPastGames([]);
    setNotifications([]);
    setNotificationsOpen(false);
    setSocialProfile(null);
    setViewedProfile(null);
  }

  async function saveProfile(event?: FormEvent) {
    event?.preventDefault();
    if (!user) {
      setToast("Sign in with Google before updating your profile");
      return;
    }
    const travelRadius = Number(profileDraft.travel_radius_km);
    if (!Number.isFinite(travelRadius) || travelRadius < 1 || travelRadius > 100) {
      setToast("Travel radius must be between 1 and 100 km");
      return;
    }
    const body: { area: string; style: string; availability: string[]; travel_radius_km: number; latitude?: number; longitude?: number } = {
      area: profileDraft.area.trim() || "Whitefield",
      style: profileDraft.style,
      availability: profileDraft.availability,
      travel_radius_km: travelRadius,
    };
    if (profileDraft.latitude != null && profileDraft.longitude != null) {
      body.latitude = profileDraft.latitude;
      body.longitude = profileDraft.longitude;
    }
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("Profile update failed");
      const updatedProfile = await response.json() as PlayerProfile;
      setProfile(updatedProfile);
      setProfileDraft({ area: updatedProfile.area, latitude: updatedProfile.latitude, longitude: updatedProfile.longitude, travel_radius_km: updatedProfile.travel_radius_km?.toString() ?? "10", style: updatedProfile.style as ProfileDraft["style"], availability: updatedProfile.availability ?? [] });
      setToast("Profile preferences saved");
    } catch {
      setToast("Could not save your profile preferences");
    }
  }

  function toggleAvailability(slot: string) {
    setProfileDraft((draft) => ({ ...draft, availability: draft.availability.includes(slot) ? draft.availability.filter((item) => item !== slot) : [...draft.availability, slot] }));
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setToast("Location access is not supported in this browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setProfileDraft((draft) => ({ ...draft, latitude: position.coords.latitude, longitude: position.coords.longitude }));
        setToast("Coordinates captured. Save your profile to use them for matching.");
        window.setTimeout(() => setToast(""), 2600);
      },
      () => setToast("Could not access your location. You can keep using locality search."),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }

  function selectDetectedSport(sport: Sport) {
    setSelectedSport(sport);
  }

  async function search(event?: FormEvent, nextQuery?: string, exact = true, authUser: User | null = user) {
    event?.preventDefault();
    if (!authUser) {
      setToast("Sign in with Google before searching");
      return;
    }
    const requestQuery = nextQuery ?? query;
    const requestSport = sportFromText(requestQuery) ?? selectedSport;
    selectDetectedSport(requestSport);
    setShowCreateGame(false);
    setLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: requestQuery, sport: requestSport, mode: exact ? "exact" : "profile" }),
      }, authUser);
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
      setCreateQuery(requestQuery);
      if (payload.group_proposal) {
        setCreateGroupDraft({
          sport: payload.group_proposal.sport,
          area: payload.group_proposal.area,
          session_date: payload.group_proposal.session_date ?? localDateInput(),
          start_time: payload.group_proposal.start_time ?? "19:00",
          end_time: payload.group_proposal.end_time ?? "21:00",
          skill_min: payload.group_proposal.skill_min.toString(),
          skill_max: payload.group_proposal.skill_max.toString(),
          style: payload.group_proposal.style as CreateGroupDraft["style"],
        });
      }
      setToast(payload.message || "Gemini searched live session data");
    } catch {
      setSessions([]);
      setGroupProposal(null);
      setGroupNameDraft("");
      setToast("Could not search live groups. Check that the API is running.");
    } finally {
      setLoading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function openCreateGame() {
    if (!user) {
      setToast("Sign in with Google before creating a game");
      return;
    }
    const requestSport = sportFromText(query) ?? selectedSport;
    const area = profile?.area || "Whitefield";
    const rating = profile?.cmr_ratings?.[requestSport] ?? 3.25;
    const nextProposal: GroupProposal = {
      group_name: `${area} ${sportLabel(requestSport)} Game`,
      sport: requestSport,
      area,
      session_date: localDateInput(),
      start_time: "19:00",
      end_time: "21:00",
      skill_min: Math.max(1, Math.round((rating - 0.3) * 10) / 10),
      skill_max: Math.min(8, Math.round((rating + 0.3) * 10) / 10),
      style: profile?.style ?? "casual",
      explanation: "Set the details for your game. CourtMate will keep the group organized and help you find compatible players.",
    };
    setSelectedSport(requestSport);
    setGroupProposal(nextProposal);
    setGroupNameDraft(nextProposal.group_name);
    setCreateQuery(query.trim() || `Create a ${sportLabel(requestSport)} game near ${area}`);
    setCreateGroupDraft({ sport: nextProposal.sport, area: nextProposal.area, session_date: nextProposal.session_date ?? localDateInput(), start_time: nextProposal.start_time ?? "19:00", end_time: nextProposal.end_time ?? "21:00", skill_min: nextProposal.skill_min.toString(), skill_max: nextProposal.skill_max.toString(), style: nextProposal.style as CreateGroupDraft["style"] });
    setShowCreateGame(true);
  }

  function changeCreateSport(sport: Sport) {
    const rating = profile?.cmr_ratings?.[sport] ?? 3.25;
    const skillMin = Math.max(1, Math.round((rating - 0.3) * 10) / 10);
    const skillMax = Math.min(8, Math.round((rating + 0.3) * 10) / 10);
    setSelectedSport(sport);
    setCreateGroupDraft((draft) => ({ ...draft, sport, skill_min: skillMin.toString(), skill_max: skillMax.toString() }));
    setGroupProposal((proposal) => proposal ? { ...proposal, sport, skill_min: skillMin, skill_max: skillMax } : proposal);
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
        body: JSON.stringify({
          query: createQuery || query || `Create a ${sportLabel(selectedSport)} game near ${createGroupDraft.area || "Whitefield"}`,
          sport: createGroupDraft.sport,
          group_name: groupNameDraft.trim() || undefined,
          area: createGroupDraft.area.trim() || undefined,
          session_date: createGroupDraft.session_date || undefined,
          start_time: createGroupDraft.start_time || undefined,
          end_time: createGroupDraft.end_time || undefined,
          skill_min: Number(createGroupDraft.skill_min),
          skill_max: Number(createGroupDraft.skill_max),
          style: createGroupDraft.style,
        }),
      });
      if (!response.ok) throw new Error("Unable to create group");
      const payload = await response.json() as { session: Omit<Session, "open_slots" | "score" | "explanation">; message: string };
      const createdSession: Session = {
        ...payload.session,
        open_slots: payload.session.capacity - payload.session.confirmed_player_ids.length,
        score: 1,
        explanation: `You are the organizer. CourtMate can now invite nearby players in the same ${sportLabel(selectedSport)} skill band.`,
      };
      setSessions([createdSession]);
      setGroupProposal(null);
      setShowCreateGame(false);
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
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = Array.from({ length: event.results.length }, (_, index) => event.results[index][0].transcript).join(" ").trim();
      if (!transcript) return;
      setQuery(transcript);
      const detectedSport = sportFromText(transcript);
      if (detectedSport) selectDetectedSport(detectedSport);
      if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) {
        void search(undefined, transcript);
      }
    };
    recognition.start();
  }

  async function joinSession(sessionId: string, name: string, organizerId?: string) {
    if ((organizerId ?? sessions.find((session) => session.id === sessionId)?.organizer_id) === user?.uid) {
      setToast("You created this group");
      window.setTimeout(() => setToast(""), 2600);
      return;
    }
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) throw new Error("Unable to join");
      const payload = await response.json() as { status: JoinRequest["status"] };
      void loadActivity("requests");
      setViewedGroup(null);
      setToast(payload.status === "waitlisted" ? `You are on the waitlist for ${name}` : `Join request sent to ${name}`);
    } catch {
      setToast(`Could not request to join ${name}`);
    } finally {
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function leaveGame(sessionId: string, name: string) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/leave`, { method: "POST" });
      if (!response.ok) throw new Error("Unable to leave");
      setWorkspaceGroup(null);
      await Promise.all([loadActivity("requests"), loadActivity("games")]);
      setToast(`You backed out of ${name}`);
    } catch {
      setToast(`Could not back out of ${name}`);
    } finally {
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function completeGame(sessionId: string, name: string) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/complete`, { method: "POST" });
      if (!response.ok) throw new Error("Unable to close game");
      if (workspaceGroup?.id === sessionId) {
        const completedSession = await response.json() as Session;
        setWorkspaceGroup(toActivityGroup(completedSession));
      }
      await loadActivity("groups");
      setToast(`${name} is now closed. Players can still leave feedback.`);
    } catch {
      setToast(`Could not close ${name}`);
    } finally {
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function viewGroup(sessionId: string) {
    setLoadingGroupId(sessionId);
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
      setLoadingGroupId(null);
    }
  }

  function toActivityGroup(group: ActivityGroup | Session): ActivityGroup {
    return {
      id: group.id,
      organizer_id: group.organizer_id,
      group_name: group.group_name,
      sport: group.sport,
      area: group.area,
      latitude: group.latitude,
      longitude: group.longitude,
      venue_name: group.venue_name,
      session_date: group.session_date,
      start_time: group.start_time,
      end_time: group.end_time,
      skill_min: group.skill_min,
      skill_max: group.skill_max,
      style: group.style,
      capacity: group.capacity,
      confirmed_player_ids: group.confirmed_player_ids,
      waitlist_player_ids: group.waitlist_player_ids ?? [],
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
      const [chatResponse, membersResponse, groupResponse, localResponse] = await Promise.all([
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/chat`),
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/group`),
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/leaderboard`),
        authorizedFetch(`${apiUrl}/v1/leaderboards/local?area=${encodeURIComponent(normalizedGroup.area)}&sport=${encodeURIComponent(normalizedGroup.sport)}`),
      ]);
      if (!chatResponse.ok || !membersResponse.ok || !groupResponse.ok || !localResponse.ok) throw new Error("Group space unavailable");
      const chatPayload = await chatResponse.json() as { posts: ChatPost[] };
      const membersPayload = await membersResponse.json() as GroupView;
      const groupPayload = await groupResponse.json() as { entries: LeaderboardEntry[] };
      const localPayload = await localResponse.json() as { entries: LeaderboardEntry[] };
      setChatPosts(chatPayload.posts);
      setGroupMembers(membersPayload.members);
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
    if (workspaceGroup.status === "completed") {
      setToast("This game is closed. Feedback is still available below.");
      return;
    }
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
      const endpoint = tab === "requests" ? "/v1/me/requests" : tab === "groups" ? "/v1/me/groups" : tab === "incoming" ? "/v1/me/incoming-requests" : "/v1/me/games";
      const response = await authorizedFetch(`${apiUrl}${endpoint}`, {}, authUser);
      if (!response.ok) throw new Error("Activity unavailable");
      if (tab === "requests") {
        const payload = await response.json() as { requests: ActivityRequest[] };
        setMyRequests(payload.requests);
      } else if (tab === "groups") {
        const payload = await response.json() as { groups: ActivityGroup[] };
        setMyGroups(payload.groups);
      } else if (tab === "incoming") {
        const payload = await response.json() as { requests: ActivityRequest[] };
        setIncomingRequests(payload.requests);
      } else {
        const payload = await response.json() as { games: ActivityGroup[]; past_games: PastGame[] };
        setApprovedGames(payload.games);
        setPastGames(payload.past_games ?? []);
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
    calendarUrl.searchParams.set("text", `${sportLabel(game.sport)} · ${game.group_name}`);
    calendarUrl.searchParams.set("dates", `${start}/${end}`);
    calendarUrl.searchParams.set("details", "CourtMate confirmed game. Book the court through your group or venue platform.");
    calendarUrl.searchParams.set("location", `${game.venue_name ? `${game.venue_name}, ` : ""}${game.area}, Bengaluru`);
    window.open(calendarUrl.toString(), "_blank", "noopener,noreferrer");
  }

  async function decideJoinRequest(requestId: string, status: "approved" | "declined", groupId: string | null = managedGroupId) {
    if (!groupId) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${groupId}/join-requests/${requestId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error("Decision failed");
      if (groupId === managedGroupId) await loadJoinRequests(groupId);
      await Promise.all([loadActivity("groups"), loadActivity("incoming"), loadActivity("games")]);
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
    if (tab === "home" && user) {
      setQuery("");
      void search(undefined, `Show me nearby ${selectedSport} games that match my saved preferences`, false);
    }
    if (tab === "games") {
      void Promise.all([loadActivity("requests"), loadActivity("games"), loadActivity("groups"), loadActivity("incoming")]);
    }
  }

  const requestedGames = myRequests.filter(({ request }) => request.status === "pending" || request.status === "waitlisted");
  const today = new Date().toISOString().slice(0, 10);
  const upcomingGames = Array.from(new Map([...approvedGames, ...myGroups.filter((group) => group.session_date >= today && group.status !== "completed" && group.status !== "cancelled")].map((game) => [game.id, game])).values()).sort((a, b) => `${a.session_date} ${a.start_time}`.localeCompare(`${b.session_date} ${b.start_time}`));
  const profileHistory = profile?.cmr_history?.[selectedSport] ?? [];
  const currentCmr = profile?.cmr_ratings?.[selectedSport];
  const ratedSports = sportOptions.filter((sport) => profile?.cmr_ratings?.[sport.value] != null);
  const unreadNotifications = notifications.filter((notification) => !notification.read).length;

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">CM</span><span>CourtMate</span></div>
        <div className="nav-right"><button className={`about-link ${activeTab === "about" ? "active" : ""}`} onClick={() => selectTab("about")}>About</button><span className="location-pill"><span className="dot" /> Whitefield, Bengaluru</span>{user ? <><div className="notification-wrap">
          <button className={`notification-button ${notificationsOpen ? "active" : ""}`} type="button" onClick={() => { setNotificationsOpen((open) => !open); if (!notifications.length) void loadNotifications(); }} aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`} title="Notifications"><BellIcon />{unreadNotifications > 0 && <span className="notification-count">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
          {notificationsOpen && <div className="notification-popover" role="dialog" aria-label="Notifications">
            <div className="notification-popover-heading"><div><span className="kicker">COURTMATE ALERTS</span><strong>Your activity</strong></div><button type="button" className="notification-close" onClick={() => setNotificationsOpen(false)} aria-label="Close notifications">×</button></div>
            {notifications.length ? <div className="notification-list">{notifications.map((notification) => <div className={`notification-item ${notification.read ? "" : "unread"}`} key={notification.id}><button type="button" className="notification-item-main" onClick={() => openNotification(notification)}><span className="notification-mark"><BellIcon /></span><span><strong>{notification.title}</strong><small>{notification.message}</small><em>{new Date(notification.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</em></span></button>{notification.kind === "join_request" && notification.request_id && <div className="notification-actions"><button type="button" onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "approved"); }}>Confirm</button><button type="button" onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "declined"); }}>Decline</button></div>}</div>)}</div> : <p className="notification-empty">No alerts yet. We&apos;ll let you know when a game fits your preferences or someone requests to join.</p>}
          </div>}
        </div><span className="user-name">{user.displayName ?? user.email}</span><button className="avatar" onClick={() => selectTab("profile")} title="Open profile">{(user.displayName ?? user.email ?? "C")[0].toUpperCase()}</button></> : <button className="sign-in-button" onClick={() => void signIn()}>{authReady ? "Sign in with Google" : "Loading auth"}</button>}</div>
      </nav>
      <nav className="app-tabs" aria-label="CourtMate sections">
        <button className={activeTab === "home" ? "active" : ""} onClick={() => selectTab("home")} title="Home">Home</button>
        <button className={activeTab === "games" ? "active" : ""} onClick={() => selectTab("games")} title="Your games">Games</button>
        <button className={activeTab === "tournaments" ? "active" : ""} onClick={() => selectTab("tournaments")} title="Tournaments">Tournaments</button>
        <button className={activeTab === "profile" ? "active" : ""} onClick={() => selectTab("profile")}>Profile</button>
      </nav>
      {activeTab === "home" && <>
      <section className="hero search-hero">
        <div className="eyebrow">FIND YOUR PEOPLE</div>
        <h1 className="compact-hero-title">Find a game <em>you&apos;ll enjoy.</em></h1>
        <p className="hero-copy">Games around you are matched to your saved preferences. Search when you have something specific in mind.</p>
          <div className="search-tip"><span className="search-tip-mark">✦</span><span><strong>Better matches:</strong> include your level, sport, timing preference, date, location, and mood.</span></div>
          <form className="search-box" onSubmit={search}>
          <div className="search-icon"><SearchGlyph /></div>
          <input value={query} placeholder="Try: intermediate pickleball near Whitefield Sunday morning" onChange={(event) => { setQuery(event.target.value); const detectedSport = sportFromText(event.target.value); if (detectedSport) selectDetectedSport(detectedSport); }} aria-label={`Search ${sportLabel(selectedSport)} groups`} />
          <button type="button" className={`mic ${isListening ? "listening" : ""}`} onClick={startVoice} aria-label={isListening ? "Listening" : "Search by voice"} title={isListening ? "Listening" : "Search by voice"}><MicrophoneIcon /><span>{isListening ? "Listening" : ""}</span></button>
          <button className="search-button" type="submit">{loading ? "Searching" : "Search exact matches"}<span>↗</span></button>
          </form>
          <div className="home-actions"><button className="create-game-action" type="button" onClick={openCreateGame}>+ Create game</button><button className="refresh-home-action" type="button" onClick={() => { setQuery(""); void search(undefined, `Show me nearby ${selectedSport} games that match my saved preferences`, false); }}>{loading ? "Refreshing" : "Refresh matches"}</button></div>
      </section>

      <section className="content-grid search-layout">
        <div className="results-column">
          <div className="section-heading"><div><span className="kicker">{query.trim() ? "EXACT SEARCH" : "AROUND YOU"}</span><h2>{sessions.length ? query.trim() ? "Exact matches" : "Games matching your preferences" : query.trim() ? "No exact match" : "No matching games yet"}</h2></div><span className="result-count">{sessions.length} good fits</span></div>
          {!sessions.length && query.trim() && !showCreateGame && <div className="empty-state"><span className="empty-icon">?</span><span className="kicker">NO EXACT MATCH</span><h3>Start the game you want.</h3><p>Nothing matches every part of that search yet. Create a game with those details and let compatible players find it.</p><button className="join-button create-button" onClick={openCreateGame}>Create this game <span>↗</span></button></div>}
          {showCreateGame && groupProposal && <div className="empty-state"><span className="empty-icon">+</span><span className="kicker">CREATE A GAME</span><label className="create-sport-field"><span>Sport</span><select value={createGroupDraft.sport} onChange={(event) => changeCreateSport(event.target.value as Sport)}>{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label><label className="group-name-editor"><span>Game name</span><input value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} aria-label="Game name" /></label><div className="create-details-grid"><label><span>Area</span><input value={createGroupDraft.area} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Date</span><input type="date" value={createGroupDraft.session_date} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, session_date: event.target.value })} /></label><label><span>Starts</span><input type="time" value={createGroupDraft.start_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, start_time: event.target.value })} /></label><label><span>Ends</span><input type="time" value={createGroupDraft.end_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, end_time: event.target.value })} /></label><label><span>Skill from</span><input type="number" min="1" max="8" step="0.1" value={createGroupDraft.skill_min} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, skill_min: event.target.value })} /></label><label><span>Skill to</span><input type="number" min="1" max="8" step="0.1" value={createGroupDraft.skill_max} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, skill_max: event.target.value })} /></label><label><span>Game mood</span><select value={createGroupDraft.style} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, style: event.target.value as CreateGroupDraft["style"] })}><option value="casual">Casual</option><option value="social">Social</option><option value="competitive">Competitive</option></select></label></div><p>{groupProposal.explanation}</p><div className="tags"><span className="tag rating">{sportLabel(groupProposal.sport)} {createGroupDraft.skill_min}–{createGroupDraft.skill_max}</span><span className="tag">{createGroupDraft.style}</span><span className="tag open">{createGroupDraft.area}</span></div><div className="create-form-actions"><button className="join-button create-button" disabled={!groupNameDraft.trim() || createGroupLoading} onClick={() => void createGroup()}>{createGroupLoading ? "Creating game" : "Create game"}<span>↗</span></button><button className="text-button" type="button" onClick={() => setShowCreateGame(false)}>Cancel</button></div></div>}
          <div className="session-list">
            {sessions.map((session, index) => <article className={`session-card ${index === 0 ? "featured" : ""}`} key={session.id}>
              <div className="card-top"><span className="date-badge"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(session.session_date).getDate()}</small></span><div className="session-meta"><div className="session-title-row"><h3>{session.group_name}</h3><span className="fit-score">{Math.round(session.score * 100)}% fit</span></div><p>{sportLabel(session.sport)} · {session.start_time} – {session.end_time} · {session.area}</p></div><button className="more">•••</button></div>
              <div className="tags"><span className="tag rating">{sportLabel(session.sport)} skill {session.skill_min.toFixed(1)}–{session.skill_max.toFixed(1)}</span><span className="tag">{session.style}</span><span className="tag open">{session.open_slots} spots open</span></div>
              <div className="card-bottom"><div className="member-stack"><span className="member coral">A</span><span className="member green">K</span><span className="member blue">R</span><span className="member-count">+{session.confirmed_player_ids.length + 2}</span></div><div className="card-actions"><button className="join-button secondary-button" onClick={() => void viewGroup(session.id)} disabled={loadingGroupId === session.id}>{loadingGroupId === session.id ? "Loading" : "View group"}</button>{session.organizer_id === user?.uid ? <span className="status-badge approved">Your group</span> : <button className="join-button" onClick={() => void joinSession(session.id, session.group_name, session.organizer_id)}>{session.open_slots > 0 ? "Request to join" : "Join waitlist"} <span>↗</span></button>}</div></div>
            </article>)}
          </div>
        </div>

      </section>
      </>}

      {activeTab === "games" && <section className="page-view games-page">
        <div className="page-heading"><span className="kicker">YOUR GAMES</span><h1>Know where you stand.</h1><p>Upcoming games, pending requests, and history.</p></div>
        <div className="page-tabs"><button className={gamesViewTab === "upcoming" ? "active" : ""} onClick={() => setGamesViewTab("upcoming")}>Upcoming <span>{upcomingGames.length}</span></button><button className={gamesViewTab === "pending" ? "active" : ""} onClick={() => setGamesViewTab("pending")}>Pending <span>{requestedGames.length}</span></button><button className={gamesViewTab === "history" ? "active" : ""} onClick={() => setGamesViewTab("history")}>History <span>{pastGames.length}</span></button></div>
        {!activityLoading && gamesViewTab === "upcoming" && <div className="game-list">{upcomingGames.length ? upcomingGames.map((game) => { const owned = myGroups.some((group) => group.id === game.id); const groupRequests = incomingRequests.filter(({ session }) => session.id === game.id); const waitlistCount = game.waitlist_player_ids?.length ?? 0; return <article className="game-row upcoming-game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p><small className="waitlist-summary">{waitlistCount ? `${waitlistCount} player${waitlistCount === 1 ? "" : "s"} on waitlist` : "Waitlist empty"}</small></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button>{owned && <button className="manage-group-button" onClick={() => { if (managedGroupId === game.id) { setManagedGroupId(null); setJoinRequests([]); } else { setManagedGroupId(game.id); void loadJoinRequests(game.id); } }}>{managedGroupId === game.id ? "Hide requests" : `${groupRequests.length ? `${groupRequests.length} ` : ""}Review requests`}</button>}{!owned && <><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></>}</div>{managedGroupId === game.id && <div className="inline-request-list">{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved", game.id)}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined", game.id)}>Decline</button></div>}</div>) : <p className="request-empty">No requests waiting for approval.</p>}</div>}</article>; }) : <div className="page-empty"><strong>No upcoming games yet.</strong><p>Join a nearby game or create a game from Home.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "pending" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p><small className="waitlist-summary">{request.status === "waitlisted" ? "On waitlist" : "Waiting for organizer approval"}</small></div><div className="game-row-actions"><span className={`status-badge ${request.status}`}>{request.status}</span><button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name)}>{request.status === "waitlisted" ? "Leave waitlist" : "Withdraw"}</button></div></article>) : <div className="page-empty"><strong>No pending requests.</strong><p>Games you request will stay here until the organizer approves them.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "history" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions"><span className="status-badge completed">Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No history yet.</strong><p>Played games and your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {activityLoading && <p className="page-loading">Refreshing your games...</p>}
        {!activityLoading && gamesViewTab === "past" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions"><span className="status-badge completed">Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No past games yet.</strong><p>Once a completed game has been played, your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "requested" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><span className={`status-badge ${request.status}`}>{request.status}</span>{["pending", "waitlisted"].includes(request.status) && <button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name)}>{request.status === "waitlisted" ? "Leave waitlist" : "Back out"}</button>}</div></article>) : <div className="page-empty"><strong>No open requests.</strong><p>Confirmed games live in the Confirmed tab. New requests will appear here until the organizer responds.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "confirmed" && <div className="game-list">{approvedGames.length ? approvedGames.map((game) => <article className="game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></div></article>) : <div className="page-empty"><strong>No confirmed games yet.</strong><p>Once an organizer accepts your request, the game will appear here ready for your calendar.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "incoming" && <div className="game-list">{incomingRequests.length ? incomingRequests.map(({ request, session }) => <article className="game-row incoming-request-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{request.player_display_name ?? request.player_id.slice(0, 10)} wants to join</h2><p>{session.group_name} · {sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void decideJoinRequest(request.id, "approved", session.id)}>Approve</button><button className="leave-game-button" onClick={() => void decideJoinRequest(request.id, "declined", session.id)}>Decline</button></div></article>) : <div className="page-empty"><strong>No incoming requests.</strong><p>When someone requests to join one of your groups, you can approve them here.</p><button className="dark-button" onClick={() => { selectTab("home"); openCreateGame(); }}>Create a game <span>→</span></button></div>}</div>}
        {myGroups.length > 0 && <div className="organizer-page-card"><div><span className="kicker">ORGANIZER</span><h2>Your groups</h2><p>Manage requests, chat, and feedback for groups you created.</p></div>{myGroups.map((group) => <div className="organizer-page-row" key={group.id}><div><strong>{group.group_name}</strong><small>{sportLabel(group.sport)} · {group.session_date} · {group.confirmed_player_ids.length}/{group.capacity} players</small></div><div className="organizer-page-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(group)}>Group space</button><button className="manage-group-button" onClick={() => { setManagedGroupId(group.id); void loadJoinRequests(group.id); }}>Requests</button></div></div>)}{managedGroupId && <div className="request-card page-request-card"><p>Requests for <strong>{myGroups.find((group) => group.id === managedGroupId)?.group_name ?? "your group"}</strong>. Approve a player before they join.</p>{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? <div className="request-list">{joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved")}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined")}>Decline</button></div>}</div>)}</div> : <p className="request-empty">No requests waiting for approval.</p>}</div>}</div>}
      </section>}

      {activeTab === "tournaments" && <TournamentHub apiUrl={apiUrl} currentUserId={user?.uid} authorizedFetch={authorizedFetch} onToast={setToast} onSignIn={() => void signIn()} />}

      {activeTab === "about" && <section className="page-view about-page">
        <div className="about-hero"><span className="kicker">THE COURTMATE IDEA</span><h1>Don&apos;t just find a court. <em>Find your people.</em></h1><p>CourtMate helps you discover the group you&apos;ll actually enjoy playing with. Ask by voice or text, see the best-fit games, and let your rating improve through real play.</p></div>
        <div className="about-grid"><article><span>01</span><h2>Describe the game</h2><p>Say the sport, place, time, and energy you want. Gemini understands the request and turns it into a search.</p></article><article><span>02</span><h2>See the group fit</h2><p>Results are ranked using distance, skill, availability, reliability, and the people you have enjoyed playing with.</p></article><article><span>03</span><h2>Keep the group alive</h2><p>Request to join, invite friends, coordinate in the group space, and replace dropouts without rebuilding a WhatsApp group.</p></article><article><span>04</span><h2>Build CMR by playing</h2><p>Your CourtMate Rating is computed from completed games and peer feedback. It is not a number you have to invent for yourself.</p></article></div>
        <div className="about-note"><strong>Works with your existing habits.</strong><span>Use WhatsApp to share the link. Book on Playo, Hudle, or directly with the venue. CourtMate is the layer that helps make the game worth showing up for.</span></div>
      </section>}

      {activeTab === "profile" && <section className="page-view profile-page">
        <div className="page-heading"><span className="kicker">YOUR PROFILE</span><h1>Make the game fit.</h1><p>Set your location, availability, and playing style.</p></div>
        {user && profile && <section className="profile-photo-card"><div className="profile-photo-avatar">{profile.profile_image_url ? <img src={profile.profile_image_url} alt={`${profile.display_name} profile`} /> : profile.display_name[0].toUpperCase()}</div><div className="profile-photo-copy"><span className="kicker">PROFILE PHOTO</span><strong>{profile.display_name}</strong><small>Help the people you play with recognise you.</small><label className="profile-photo-upload"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProfilePicture(file); event.currentTarget.value = ""; }} disabled={profilePictureUploading} />{profilePictureUploading ? "Uploading..." : profile.profile_image_url ? "Change photo" : "Add profile photo"}</label></div></section>}
        {user && profile && <section className="profile-insights"><div className="cmr-sport-heading"><div><span className="kicker">YOUR RATINGS</span><h2>CMR by sport</h2></div><span>0–100 scale</span></div>{socialProfile && <div className="social-stats"><button type="button" onClick={() => void viewPlayerProfile(user.uid)}><strong>{socialProfile.followers_count}</strong><span>Followers</span></button><button type="button" onClick={() => void viewPlayerProfile(user.uid)}><strong>{socialProfile.following_count}</strong><span>Following</span></button><span><strong>{Math.round(profile.reliability * 100)}%</strong><span>Reliability</span></span></div>}{socialProfile && <div className="profile-activity-grid"><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Show up streak</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={socialProfile.activity_by_date} /></section><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">RECENT GAMES</span><h2>Where you played</h2></div><span>{socialProfile.recent_games.length} shown</span></div><RecentGames games={socialProfile.recent_games} /></section></div>}{ratedSports.length ? <div className="cmr-sport-grid">{ratedSports.map((sport) => { const rating = profile.cmr_ratings?.[sport.value] as number; const games = profile.cmr_game_counts?.[sport.value] ?? 0; return <button type="button" className={`cmr-sport-card ${selectedSport === sport.value ? "selected" : ""}`} key={sport.value} onClick={() => setSelectedSport(sport.value)}><span>{sport.label}</span><strong>{rating.toFixed(1)}</strong><small>{cmrLevelForRating(rating)} · {games} game{games === 1 ? "" : "s"}</small></button>; })}</div> : <div className="cmr-no-ratings"><strong>No sport ratings yet.</strong><span>Complete a game and submit feedback to build your first CMR.</span></div>}<p className="cmr-summary">Current {sportLabel(selectedSport)} CMR: <strong>{currentCmr?.toFixed(1) ?? "not built"} / 100</strong><span>{currentCmr ? ` · ${cmrLevelForRating(currentCmr)}` : " · Search by level to get started"}</span></p>{profileHistory.length ? <><div className="cmr-chart-heading"><div><span className="kicker">CMR JOURNEY</span><h2>How your game is moving</h2></div><span>{profileHistory.length} game{profileHistory.length === 1 ? "" : "s"}</span></div><div className="cmr-chart"><svg viewBox="0 0 560 190" role="img" aria-label={`CMR trend for ${sportLabel(selectedSport)}`}><line x1="28" y1="28" x2="28" y2="162" /><line x1="28" y1="162" x2="532" y2="162" /><polyline points={cmrGraphPoints(profileHistory)} fill="none" /><g>{profileHistory.filter((point) => point.rating != null).map((point, index, ratedHistory) => { const x = ratedHistory.length === 1 ? 280 : 28 + (index * 504) / (ratedHistory.length - 1); const y = 162 - ((Math.max(0, Math.min(100, point.rating ?? 0)) * 134) / 100); return <circle key={point.session_id} cx={x} cy={y} r="5"><title>{`${point.group_name}: ${(point.rating ?? 0).toFixed(1)} / 100 (${(point.delta ?? 0) >= 0 ? "+" : ""}${(point.delta ?? 0).toFixed(1)})`}</title></circle>; })}</g></svg><div className="cmr-chart-scale"><span>100</span><span>0</span></div></div><div className="cmr-history-list">{profileHistory.slice().reverse().map((point) => <article className="cmr-history-row" key={point.session_id}><div><strong>{point.group_name}</strong><small>{point.session_date} · {point.game_rating != null ? `game rating ${point.game_rating.toFixed(1)} / 100` : "awaiting player feedback"}</small></div><div>{point.rating != null ? <b>{point.rating.toFixed(1)}</b> : <b>--</b>}{point.delta != null ? <span className={point.delta >= 0 ? "positive" : "negative"}>{point.delta >= 0 ? "+" : ""}{point.delta.toFixed(1)}</span> : <span className="pending">Pending</span>}</div></article>)}</div></> : <div className="profile-empty-insight"><strong>Your CMR starts after your first completed game.</strong><p>CMR is tracked separately from 0 to 100 for each sport; this view follows the sport you last searched.</p></div>}</section>}
        {!user && <div className="page-empty"><strong>Sign in to manage your profile.</strong><p>Your rating and preferences are saved securely to your CourtMate profile.</p><button className="dark-button" onClick={() => void signIn()}>Sign in with Google <span>→</span></button></div>}
        {user && profile && <form className="profile-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Locality label</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation}>{profileDraft.latitude != null && profileDraft.longitude != null ? "Location saved" : "Use my current location"}<span>⌖</span></button></label></div><p className="location-note">These preferences apply across all court sports. CMR is computed separately from completed games for each sport.</p><label><span>How do you like to play?</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>When are you usually available?</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save profile <span>→</span></button><span>General preferences</span><button className="text-button" type="button" onClick={() => void signOutUser()}>Sign out</button></div></form>}
      </section>}

      <footer className="footer"><span>CourtMate finds the people. Your venue handles the court.</span><button className="about-footer-link" onClick={() => selectTab("about")}>How it works <span>→</span></button></footer>
      {workspaceGroup && <div className="group-modal-backdrop" onClick={() => setWorkspaceGroup(null)}><section className="workspace-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">{sportLabel(workspaceGroup.sport).toUpperCase()} GROUP SPACE</span><h2>{workspaceGroup.group_name}</h2><p>{workspaceGroup.session_date} · {workspaceGroup.start_time}–{workspaceGroup.end_time} · {workspaceGroup.area}</p></div><button className="close-button" onClick={() => setWorkspaceGroup(null)}>×</button></div>{workspaceLoading ? <p className="page-loading">Loading group space...</p> : <div className="workspace-grid"><section className="workspace-panel chat-panel"><div className="workspace-panel-heading"><div><span className="kicker">LIVE POSTING CHAT</span><h3>Coordinate the session</h3></div><button className="workspace-refresh" onClick={() => void openGroupSpace(workspaceGroup)}>Refresh</button></div><div className="chat-feed">{chatPosts.length ? chatPosts.map((post) => <article className={`chat-post ${post.player_id === user?.uid ? "mine" : ""}`} key={post.id}><div className="chat-avatar">{post.player_display_name[0]}</div><div><strong>{post.player_display_name}</strong><p>{post.message}</p><small>{new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div></article>) : <p className="activity-empty">No posts yet. Start coordinating the game.</p>}</div><form className="chat-composer" onSubmit={postChat}><input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} maxLength={500} placeholder="Post an update to the group..." aria-label="Group chat message" /><button className="dark-button" type="submit" disabled={!chatDraft.trim()}>Post</button></form></section><section className="workspace-panel leaderboard-panel"><div className="workspace-panel-heading"><div><span className="kicker">{sportLabel(workspaceGroup.sport).toUpperCase()} LEADERBOARD</span><h3>Local legends in this group</h3></div></div><div className="leaderboard-list">{groupLeaderboard.length ? groupLeaderboard.map((entry) => <div className="leaderboard-row" key={entry.player.id}><span className="rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count ? `${entry.ratings_count} community rating(s)` : `${sportLabel(workspaceGroup.sport)} skill rating ${entry.score.toFixed(1)}`}</small></div><b>{entry.score.toFixed(1)}</b></div>) : <p className="activity-empty">Leaderboard scores appear after players have ratings.</p>}</div><div className="local-leaderboard"><span className="kicker">{workspaceGroup.area.toUpperCase()} · {sportLabel(workspaceGroup.sport).toUpperCase()} LEADERBOARD</span>{localLeaderboard.slice(0, 5).map((entry) => <div className="local-row" key={entry.player.id}><span>#{entry.rank}</span><strong>{entry.player.display_name}</strong><b>{entry.score.toFixed(1)}</b></div>)}</div></section><form className="workspace-panel feedback-panel" onSubmit={submitGroupFeedback}><div className="workspace-panel-heading"><div><span className="kicker">POST-GAME FEEDBACK</span><h3>Was this a fun, fair group?</h3></div></div><div className="feedback-fields"><label><span>Fun</span><select value={feedbackFun} onChange={(event) => setFeedbackFun(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label><label><span>Fairness</span><select value={feedbackFairness} onChange={(event) => setFeedbackFairness(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label></div><label className="return-check"><input type="checkbox" checked={feedbackWouldReturn} onChange={(event) => setFeedbackWouldReturn(event.target.checked)} /><span>Would you play with this group again?</span></label><fieldset className="player-rating-fields"><legend>Rate other players</legend>{groupMembers.filter((member) => member.id !== user?.uid).map((member) => <label key={member.id}><span>{member.display_name}</span><select value={playerRatings[member.id] ?? ""} onChange={(event) => setPlayerRatings({ ...playerRatings, [member.id]: event.target.value })}><option value="">Skip</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label>)}</fieldset><button className="dark-button" type="submit">Save feedback <span>→</span></button></form></div>}</section></div>}
      {viewedGroup && <div className="group-modal-backdrop" onClick={() => setViewedGroup(null)}><section className="group-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">{sportLabel(viewedGroup.session.sport).toUpperCase()} GROUP PREVIEW</span><h2>{viewedGroup.session.group_name}</h2><p>{viewedGroup.session.start_time} – {viewedGroup.session.end_time} · {viewedGroup.session.area}</p></div><button className="close-button" onClick={() => setViewedGroup(null)}>×</button></div><div className="group-summary"><span><strong>{viewedGroup.members.length}/{viewedGroup.session.capacity}</strong><small>PLAYERS</small></span><span><strong>{viewedGroup.session.skill_min.toFixed(1)}–{viewedGroup.session.skill_max.toFixed(1)}</strong><small>SKILL BAND</small></span><span><strong>{viewedGroup.session.style}</strong><small>INTENSITY</small></span></div><div className="member-grid">{viewedGroup.members.map((member) => { const memberCmr = member.cmr_ratings?.[viewedGroup.session.sport]; const memberRating = memberCmr ?? member.sport_ratings?.[viewedGroup.session.sport] ?? (viewedGroup.session.sport === "pickleball" ? member.dupr_rating : undefined); return <button type="button" className="member-profile profile-link" key={member.id} onClick={() => void viewPlayerProfile(member.id)} disabled={profileLoadingId === member.id}><div className="member-profile-avatar">{member.display_name[0]}</div><div className="member-profile-copy"><h3>{member.display_name}</h3><p>{member.area} · {member.style}</p><div className="member-profile-meta"><strong>{memberCmr != null ? `CMR ${memberCmr.toFixed(1)} / 100` : memberRating ? `${sportLabel(viewedGroup.session.sport)} ${memberRating.toFixed(1)}` : "Rating not set"}</strong><span>{member.is_following ? "Following" : "View profile"}</span></div></div></button>; })}</div>{viewedGroup.session.organizer_id === user?.uid ? <span className="status-badge approved modal-join">You created this group</span> : <button className="dark-button modal-join" onClick={() => void joinSession(viewedGroup.session.id, viewedGroup.session.group_name, viewedGroup.session.organizer_id)}>Request to join <span>→</span></button>}</section></div>}
      {viewedProfile && <div className="group-modal-backdrop" onClick={() => setViewedProfile(null)}><section className="group-modal profile-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div className="profile-modal-heading"><div className="profile-modal-avatar">{viewedProfile.display_name[0]}</div><div><span className="kicker">PLAYER PROFILE</span><h2>{viewedProfile.display_name}</h2><p>{viewedProfile.area} · {viewedProfile.style}</p></div></div><button className="close-button" onClick={() => setViewedProfile(null)} aria-label="Close profile">×</button></div><div className="social-profile-stats"><span><strong>{viewedProfile.followers_count}</strong><small>FOLLOWERS</small></span><span><strong>{viewedProfile.following_count}</strong><small>FOLLOWING</small></span><span><strong>{Math.round(viewedProfile.reliability * 100)}%</strong><small>RELIABILITY</small></span></div><div className="profile-activity-grid"><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Show up streak</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={viewedProfile.activity_by_date} /></section><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">RECENT GAMES</span><h2>Where they played</h2></div><span>{viewedProfile.recent_games.length} shown</span></div><RecentGames games={viewedProfile.recent_games} /></section></div><div className="profile-sport-ratings"><span className="kicker">SPORT RATINGS</span>{Object.entries(viewedProfile.cmr_ratings ?? {}).length ? <div className="profile-rating-list">{Object.entries(viewedProfile.cmr_ratings ?? {}).map(([sport, rating]) => <span key={sport}><strong>{sportLabel(sport)}</strong><b>{rating.toFixed(1)} / 100</b></span>)}</div> : <p>No CMR ratings yet. Play a completed game to build one.</p>}</div>{viewedProfile.id === user?.uid ? <span className="status-badge approved modal-join">This is your profile</span> : <div className="profile-modal-actions"><button className={`dark-button ${viewedProfile.is_following ? "following-button" : ""}`} onClick={() => void toggleFollowProfile()}>{viewedProfile.is_following ? "Following" : "Follow"}<span>{viewedProfile.is_following ? "✓" : "+"}</span></button>{viewedProfile.follows_you && <span className="follows-you">Follows you</span>}</div>}</section></div>}
      {toast && <div className="toast">{toast}</div>}
      {workspaceGroup?.status === "completed" && <PostGameFeedbackPanel sessionId={workspaceGroup.id} members={groupMembers} currentUserId={user?.uid} authorizedFetch={authorizedFetch} onSaved={() => void openGroupSpace(workspaceGroup)} onToast={setToast} />}
    </main>
  );
}

interface SpeechRecognitionEvent extends Event { results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } } }
interface SpeechRecognition { lang: string; interimResults: boolean; continuous: boolean; onstart: () => void; onend: () => void; onresult: (event: SpeechRecognitionEvent) => void; start: () => void }
