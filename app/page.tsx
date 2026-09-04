"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";
import { usePathname, useRouter } from "next/navigation";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { auth, isFirebaseConfigured, storage } from "../firebase";
import { GroupSpace } from "./group-space";
import { CommunityHub, type NearbyGame } from "./community-hub";
import { PostGameFeedbackPanel } from "./post-game-feedback";
import { copyShareText, createStreakShareCard, isDesktopShareView, shareImageFile, SocialFeed } from "./social-feed";
import { TennisBallLoader } from "./tennis-ball-loader";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type Gender = "woman" | "man" | "non_binary" | "prefer_not_to_say";
type AgeRange = "any" | "18_24" | "25_34" | "35_44" | "45_plus";
type SessionVisibility = "public" | "followers" | "private";
type Theme = "light" | "dark";
type ExploreTimeFilter = "all" | "morning" | "day" | "evening" | "night";
type ExploreCmrFilter = "all" | "beginner" | "intermediate" | "advanced";
type LiveStateKey = "notifications" | "activity" | "connections" | "social-profile" | "profile" | "feed" | "recommendations" | "group-space";
type DiscoveryStep = "sport" | "area" | "date" | "time" | "skill";
type DiscoveryDraft = { sport: Sport | null; area: string; date: string; time: string; skill: string };
type CreationStep = "sport" | "area" | "date" | "time" | "skill" | "vibe" | "format" | "capacity" | "visibility" | "name" | "confirm";

const sportOptions: { value: Sport; label: string }[] = [
  { value: "pickleball", label: "Pickleball" },
  { value: "badminton", label: "Badminton" },
  { value: "tennis", label: "Tennis" },
  { value: "padel", label: "Padel" },
  { value: "squash", label: "Squash" },
  { value: "table_tennis", label: "Table tennis" },
];

const genderOptions: { value: Gender; label: string }[] = [
  { value: "woman", label: "Women" },
  { value: "man", label: "Men" },
  { value: "non_binary", label: "Non-binary players" },
];
const CMR_VERIFICATION_GAME_THRESHOLD = 3;

const ageRangeOptions: { value: AgeRange; label: string }[] = [
  { value: "any", label: "Any age" },
  { value: "18_24", label: "18–24" },
  { value: "25_34", label: "25–34" },
  { value: "35_44", label: "35–44" },
  { value: "45_plus", label: "45+" },
];

const sportLabel = (sport: Sport | string) => sportOptions.find((option) => option.value === sport)?.label ?? sport.replaceAll("_", " ");
const sportFromText = (text: string): Sport | null => {
  const lowered = text.toLowerCase();
  return sportOptions.find((option) => lowered.includes(option.label.toLowerCase()))?.value ?? (lowered.includes("ping pong") ? "table_tennis" : null);
};
const clampCmr = (value: number) => Math.max(1, Math.min(10, Math.round(value * 100) / 100));
// Only raw values from the retired 1-8 API are converted. Sessions, maps, and
// current CMR values already use the canonical 1.00-10.00 scale.
const cmrFromLegacySkillBand = (value: number) => clampCmr(1 + (value - 1) * 9 / 7);
const cmrFromSkillBand = (value: number) => clampCmr(value);
const skillBandFromCmr = (value: number) => clampCmr(value);
const exploreCmrRanges: Record<Exclude<ExploreCmrFilter, "all">, [number, number]> = { beginner: [1, 2.9], intermediate: [3, 5.9], advanced: [6, 10] };
const exploreTimeOfDay = (startTime: string): ExploreTimeFilter => {
  const hour = Number.parseInt(startTime.split(":")[0] ?? "0", 10);
  if (hour < 9) return "morning";
  if (hour < 16) return "day";
  if (hour < 21) return "evening";
  return "night";
};
const ACTIVITY_CACHE_TTL_MS = 30_000;
const SOCIAL_PROFILE_CACHE_TTL_MS = 5 * 60_000;

function hasStateChanged<T>(current: T, next: T) {
  return JSON.stringify(current) !== JSON.stringify(next);
}

function ShareIcon() {
  return <svg className="social-share-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M5 13v7h14v-7" /></svg>;
}

function activityCacheKey(playerId: string) {
  return `courtmate:activity:${playerId}`;
}

function socialProfileCacheKey(playerId: string) {
  return `courtmate:social-profile:${playerId}`;
}

function readSocialProfileCache(playerId: string): PublicPlayerProfile | null {
  try {
    const raw = window.sessionStorage.getItem(socialProfileCacheKey(playerId));
    if (!raw) return null;
    const cached = JSON.parse(raw) as { savedAt?: number; profile?: PublicPlayerProfile };
    return typeof cached.savedAt === "number" && Date.now() - cached.savedAt < SOCIAL_PROFILE_CACHE_TTL_MS && cached.profile ? cached.profile : null;
  } catch {
    return null;
  }
}

function writeSocialProfileCache(playerId: string, profile: PublicPlayerProfile) {
  try {
    window.sessionStorage.setItem(socialProfileCacheKey(playerId), JSON.stringify({ savedAt: Date.now(), profile }));
  } catch {
    // The profile still renders normally when browser storage is unavailable.
  }
}

function renderAssistantInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const isBold = (part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"));
    const isItalic = part.startsWith("*") && part.endsWith("*") && !isBold;
    if (isBold) return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    if (isItalic) return <em key={`${part}-${index}`}>{part.slice(1, -1)}</em>;
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function AssistantReply({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`paragraph-${blocks.length}`}>{renderAssistantInline(paragraph.join(" ").trim())}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const List = list.ordered ? "ol" : "ul";
    blocks.push(<List key={`list-${blocks.length}`}>{list.items.map((item, index) => <li key={`${item}-${index}`}>{renderAssistantInline(item)}</li>)}</List>);
    list = null;
  };

  text.replace(/\r\n?/g, "\n").split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || /^-{3,}$/.test(line)) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(<h4 key={`heading-${blocks.length}`}>{renderAssistantInline(heading[1])}</h4>);
      return;
    }
    const bullet = line.match(/^(?:[-*•])\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((bullet ?? ordered)![1]);
      return;
    }
    flushList();
    paragraph.push(line);
  });
  flushParagraph();
  flushList();
  return <div className="assistant-reply">{blocks}</div>;
}

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
  time_window_start?: string | null;
  time_window_end?: string | null;
  duration_minutes?: number;
  time_finalized?: boolean;
  skill_min: number;
  skill_max: number;
  style: string;
  rating_mode?: "casual" | "competitive";
  game_format: "singles" | "doubles";
  capacity: number;
  confirmed_player_ids: string[];
  waitlist_player_ids?: string[];
  checked_in_player_ids?: string[];
  completed_player_ids?: string[];
  external_booking_url?: string;
  status?: string;
  visibility?: SessionVisibility;
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
  game_format: "singles" | "doubles";
  capacity: number;
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
  rating_mode: "casual" | "competitive";
  game_format: "singles" | "doubles";
  capacity: number;
};

type SearchResponse = {
  action: "join_existing" | "create_group";
  message: string;
  recommendations: { session: Session; score: number; reasons: { explanation: string } }[];
  group_proposal?: GroupProposal;
  scope?: "court_discovery" | "sports_general" | "out_of_scope";
};

type PlayerProfile = {
  id: string;
  display_name: string;
  bio?: string;
  is_profile_private?: boolean;
  default_session_visibility?: SessionVisibility;
  profile_image_url?: string | null;
  area: string;
  age?: number | null;
  gender?: Gender | null;
  preferred_age_range?: AgeRange;
  preferred_genders?: Gender[];
  latitude?: number | null;
  longitude?: number | null;
  travel_radius_km?: number;
  primary_sport?: Sport | null;
  self_assessed_levels?: Record<string, number>;
  skill_levels?: Record<string, "beginner" | "intermediate" | "advanced">;
  dupr_rating?: number | null;
  sport_ratings?: Record<string, number>;
  cmr_ratings?: Record<string, number>;
  cmr_game_counts?: Record<string, number>;
  cmr_confidence?: Record<string, number>;
  cmr_history?: Record<string, CMRHistoryPoint[]>;
  rating_source: string;
  style: string;
  availability: string[];
  reliability: number;
  on_time_check_in_count: number;
  late_check_in_count: number;
  withdrawal_count: number;
  late_withdrawal_count: number;
};

type PublicPlayerProfile = {
  id: string;
  display_name: string;
  bio?: string;
  is_profile_private: boolean;
  profile_image_url?: string | null;
  area: string;
  dupr_rating?: number | null;
  rating_source: string;
  sport_ratings?: Record<string, number>;
  rating_sources?: Record<string, string>;
  style: string;
  reliability: number;
  on_time_check_in_count: number;
  late_check_in_count: number;
  withdrawal_count: number;
  late_withdrawal_count: number;
  community_score?: number | null;
  community_rating_count: number;
  community_scores?: Record<string, number>;
  community_rating_counts?: Record<string, number>;
  cmr_ratings?: Record<string, number>;
  cmr_game_counts?: Record<string, number>;
  cmr_confidence?: Record<string, number>;
  followers_count: number;
  following_count: number;
  is_following: boolean;
  follow_request_pending: boolean;
  follows_you: boolean;
  recent_games: ProfileGameSummary[];
  activity_by_date: Record<string, number>;
  weekly_streak: number;
  weekly_streak_active: boolean;
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

function totalGamesFor(profile: { cmr_game_counts?: Record<string, number>; recent_games?: ProfileGameSummary[] }) {
  const ratedGames = Object.values(profile.cmr_game_counts ?? {}).reduce((total, count) => total + count, 0);
  return ratedGames || profile.recent_games?.length || 0;
}

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
  time_window_start?: string | null;
  time_window_end?: string | null;
  duration_minutes?: number;
  time_finalized?: boolean;
  rating_mode?: "casual" | "competitive";
  game_format?: "singles" | "doubles";
  skill_min: number;
  skill_max: number;
  style: string;
  capacity: number;
  confirmed_player_ids: string[];
  waitlist_player_ids?: string[];
  checked_in_player_ids?: string[];
  external_booking_url?: string;
  status: string;
  visibility?: SessionVisibility;
};

type ShareableGame = Pick<ActivityGroup, "id" | "group_name" | "sport" | "area" | "venue_name" | "session_date" | "start_time" | "end_time">;

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

type ActivitySnapshot = {
  requests: ActivityRequest[];
  incoming_requests: ActivityRequest[];
  groups: ActivityGroup[];
  games: ActivityGroup[];
  awaiting_feedback: ActivityGroup[];
  past_games: PastGame[];
};

type ChatPost = {
  id: string;
  player_id: string;
  player_display_name: string;
  message: string;
  post_type?: "message" | "match_result" | "time_poll" | "system";
  teams?: { name: string; player_ids: string[]; score?: number | null }[];
  result_status?: "pending_confirmation" | "confirmed" | "disputed" | null;
  confirmation_ids?: string[];
  poll_options?: { id: string; label: string; start_time: string; end_time: string; voter_ids: string[] }[];
  poll_participant_ids?: string[];
  poll_status?: "open" | "resolved" | null;
  poll_winner_id?: string | null;
  created_at: string;
};

type AppNotification = {
  id: string;
  kind: "game_match" | "game_reminder" | "game_completed" | "join_request" | "request_update" | "follow";
  title: string;
  message: string;
  session_id: string;
  request_id?: string | null;
  actor_id?: string | null;
  read: boolean;
  action_status?: "pending" | "approved" | "declined" | "waitlisted" | "withdrawn" | null;
  created_at: string;
};

const notificationActionLabels = {
  approved: "Confirmed",
  declined: "Declined",
  waitlisted: "Waitlisted",
  withdrawn: "Withdrawn",
} as const;

type LeaderboardEntry = {
  rank: number;
  score: number;
  ratings_count: number;
  player: {
    id: string;
    display_name: string;
    area: string;
    profile_image_url?: string | null;
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
  confidence?: number | null;
};

type AppTab = "home" | "social" | "games" | "leaderboard" | "profile" | "communities";
type GamesViewTab = "explore" | "pending" | "upcoming" | "awaiting_feedback" | "history" | "requested" | "confirmed" | "past" | "incoming";
type ConnectionsTab = "following" | "followers";
type CircleLeaderboardScope = "circle" | "locality" | "bengaluru";

type ProfileDraft = {
  bio: string;
  is_profile_private: boolean;
  default_session_visibility: SessionVisibility;
  area: string;
  age: string;
  gender: Gender | "";
  preferred_age_range: AgeRange;
  preferred_genders: Gender[];
  latitude?: number | null;
  longitude?: number | null;
  travel_radius_km: string;
  style: "casual" | "social" | "competitive";
  availability: string[];
};

type GroupMember = PublicPlayerProfile & { rating_confidence: number };

type ActivityProof = {
  id: string;
  session_id: string;
  player_id: string;
  image_url: string;
  sport: Sport;
  analysis: {
    calories_burned?: number | null;
    duration_minutes?: number | null;
    active_minutes?: number | null;
    distance_km?: number | null;
    steps?: number | null;
    average_heart_rate?: number | null;
    summary: string;
    confidence: number;
  };
  created_at: string;
};

type GroupView = {
  session: Session;
  members: GroupMember[];
  waitlist?: GroupMember[];
  activity_proofs?: ActivityProof[];
};

type GroupSpaceCacheEntry = {
  cachedAt: number;
  group: ActivityGroup;
  members: GroupMember[];
  waitlist: GroupMember[];
  posts: ChatPost[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const availabilityOptions = ["weekday mornings", "weekday evenings", "weekend mornings", "weekend evenings"];

function cmrLevelForRating(rating: number): string {
  if (rating < 2) return "Complete beginner";
  if (rating < 3) return "Beginner";
  if (rating < 4) return "Learning / recreational";
  if (rating < 5) return "Intermediate";
  if (rating < 6) return "Strong intermediate";
  if (rating < 7) return "Advanced";
  if (rating < 8) return "Very advanced";
  if (rating < 9) return "Expert";
  if (rating < 10) return "Elite";
  return "Competitive / professional";
}

function localDateInput(): string {
  return dateInputValue(new Date());
}

function dateInputValue(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function nextDefaultGameSchedule(now = new Date()): Pick<CreateGroupDraft, "session_date" | "start_time" | "end_time"> {
  const date = new Date(now);
  // A 7 PM game is no longer selectable once that time has passed locally.
  if (now.getHours() >= 19) date.setDate(date.getDate() + 1);
  return { session_date: dateInputValue(date), start_time: "19:00", end_time: "21:00" };
}

function localTimeInput(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function isPerformanceQuery(query: string): boolean {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const hasDiscoveryAction = /\b(find|search|show|join|invite|create|book|nearby|around)\b/.test(normalized);
  const hasDiscoveryObject = /\b(game|games|group|groups|session|sessions|player|players|court|courts|venue|venues|match|matches)\b/.test(normalized);
  const asksAboutOwnGames = /\b(my|mine|i've|i have)\b/.test(normalized) && /\b(last|recent|history|played|games|game)\b/.test(normalized);
  if (hasDiscoveryAction && hasDiscoveryObject) return asksAboutOwnGames;
  return /\b(cmr|rating|ratings|feedback|review|stats|statistics|calories|steps|heart rate|distance|wearable|progress|trend|fitness|form|strongest|weakest|reliability|attendance)\b/.test(normalized)
    || /\bhow (?:am i doing|have i been playing)\b/.test(normalized)
    || (/\b(my|me|i|mine|i've|i have)\b/.test(normalized) && /\b(performance|history|played|games|activity|progress|trend|improve|form)\b/.test(normalized));
}

function isCreateGameQuery(query: string): boolean {
  return /\b(?:create|host|organize|organise|set\s*up|start|make)\b[\s\S]*\b(?:game|match|session|group)\b/i.test(query)
    || /\b(?:game|match|session|group)\b[\s\S]*\b(?:create|host|organize|organise|set\s*up)\b/i.test(query);
}

function isFindGameQuery(query: string): boolean {
  return /\b(?:find|search|show|discover|looking for|want to join|play)\b[\s\S]*\b(?:game|games|match|matches|session|sessions|group|groups)\b/i.test(query)
    || /\b(?:game|games|match|matches|session|sessions|group|groups)\b[\s\S]*\b(?:near me|nearby|available|today|tomorrow|weekend)\b/i.test(query)
    || /\b(?:find|show|play|join|looking for|want to play)\b[\s\S]*\b(?:pickleball|badminton|tennis|padel|squash|table tennis|ping pong)\b/i.test(query);
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.2-10.2a2.2 2.2 0 0 0-3.1-3.1L5.1 15.9 4 20Z" /><path d="m13.8 7.2 3.1 3.1" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" /><circle cx="12" cy="12" r="7" /></svg>;
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function GoogleIcon() {
  return <svg className="google-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.35 12.23c0-.71-.06-1.4-.18-2.05H12v3.88h5.24a4.48 4.48 0 0 1-1.94 2.94v2.51h3.14c1.84-1.69 2.91-4.18 2.91-7.28Z" /><path fill="#34A853" d="M12 21.75c2.63 0 4.84-.87 6.45-2.37l-3.14-2.51c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.72-5.46-4.03H3.3v2.59A9.75 9.75 0 0 0 12 21.75Z" /><path fill="#FBBC05" d="M6.54 13.76A5.86 5.86 0 0 1 6.23 12c0-.61.11-1.2.31-1.76V7.65H3.3A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05 1.05 4.35l3.24-2.59Z" /><path fill="#EA4335" d="M12 6.21c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.83 3.3 14.62 2.25 12 2.25A9.75 9.75 0 0 0 3.3 7.65l3.24 2.59C7.31 7.93 9.46 6.21 12 6.21Z" /></svg>;
}

function InstagramIcon() {
  return <svg className="guest-footer-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" /><circle cx="12" cy="12" r="4" /><circle cx="17.4" cy="6.7" r=".9" fill="currentColor" stroke="none" /></svg>;
}

function MailIcon() {
  return <svg className="guest-footer-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="m4.5 7 7.5 6 7.5-6" /></svg>;
}

function HomeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10Z" /></svg>;
}

function PickleballPaddleIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 3.2h2.3a5 5 0 0 1 5 5v2.7a5 5 0 1 1-10 0V8.2a5 5 0 0 1 2.7-5Z" transform="rotate(-35 9.8 9.5)" /><path d="M13.5 14.6 20 21M17.7 18.8l-1.8 1.8M19.2 20.3l-1.8 1.8M8.3 7.5h.01M11.1 8.5h.01M8.8 10.6h.01M11.7 11.5h.01" /></svg>;
}

function SocialIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.3 21c4.3 0 7.2-2.8 7.2-6.6 0-2.7-1.5-4.8-3.9-6.8.1 2.2-.8 3.5-2 4.2.3-3.5-1.1-6.1-4.1-8.8.2 3.2-1.2 4.8-2.5 6.5A8 8 0 0 0 5 14.5C5 18.3 7.9 21 12.3 21Z" /><path d="M12 20.8c-1.8-.8-2.8-2.2-2.8-3.9 0-1.4.7-2.5 1.8-3.7.2 1.2.7 2 1.5 2.5.1-1.3.7-2.3 1.5-3.2.8 1.2 1.2 2.3 1.2 3.5 0 2.1-1.2 3.9-3.2 4.8Z" /></svg>;
}

function ChatIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" /><path d="M7 10h10M7 13.5h6" /></svg>;
}

function LeaderboardIcon() {
  return <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="M3 21h18M4 21v-7h5v7M9.5 21V4h5v17M15 21V10h5v11" /><path d="M11.25 7h1.5" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>;
}

function ProfileIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
}

function OverviewTrendIcon() {
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 25V19M12 25V15M18 25V11" /><path d="m8 13 6-6 4 4 8-8" /><path d="M20 3h6v6" /></svg>;
}

function activityDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ActivityHeatmap({ activity, playerName, weeklyStreak, onToast }: { activity: Record<string, number>; playerName: string; weeklyStreak: number; onToast: (message: string) => void }) {
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
  async function shareActivity() {
    try {
      if (isDesktopShareView()) {
        await copyShareText(`${window.location.origin}/home`);
        onToast("Copied link to clipboard");
        return;
      }
      const file = await createStreakShareCard(playerName, weeklyStreak, activity);
      if (!file) throw new Error("Could not create the streak image");
      const title = `${playerName}'s CourtMate streak`;
      const text = `${weeklyStreak}-week CourtMate streak with ${activeDays} active day${activeDays === 1 ? "" : "s"} recorded.`;
      const outcome = await shareImageFile(file, title, text, `${window.location.origin}/home`);
      if (outcome === "copied") onToast("Copied link to clipboard");
      if (outcome === "downloaded") onToast("CourtMate streak image downloaded");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast(error instanceof Error ? error.message : "Could not share this streak");
    }
  }
  return <div className="activity-heatmap"><div className="activity-heatmap-labels"><span>{activeDays} active day{activeDays === 1 ? "" : "s"}</span><span>12 weeks</span><button type="button" className="activity-share-button" onClick={() => void shareActivity()}>Share streak</button></div><div className="activity-heatmap-grid" aria-label="Recent activity calendar">{days.map((day) => <span className={`activity-cell activity-level-${Math.min(day.count, 4)} ${day.future ? "future" : ""}`} key={day.key} title={`${day.key}: ${day.count} game${day.count === 1 ? "" : "s"}`} aria-label={`${day.key}: ${day.count} game${day.count === 1 ? "" : "s"}`} />)}</div><div className="activity-heatmap-legend"><span>Less</span><i className="activity-cell activity-level-0" /><i className="activity-cell activity-level-1" /><i className="activity-cell activity-level-2" /><i className="activity-cell activity-level-3" /><i className="activity-cell activity-level-4" /><span>More</span></div></div>;
}

function ActivityCalendar({ activity }: { activity: Record<string, number> }) {
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).getDay();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthLabel = today.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const activeDays = Object.entries(activity).filter(([key, count]) => key.startsWith(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-`) && count > 0).length;
  const cells = Array.from({ length: firstDay + daysInMonth }, (_, index) => index < firstDay ? null : index - firstDay + 1);
  return <section className="activity-calendar" aria-label="Activity calendar"><div className="activity-calendar-summary"><div><span className="kicker">ACTIVITY</span><h2>{monthLabel}</h2></div><span>{activeDays} active day{activeDays === 1 ? "" : "s"}</span></div><div className="activity-calendar-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="activity-calendar-grid">{cells.map((day, index) => { const date = day == null ? null : new Date(today.getFullYear(), today.getMonth(), day); const key = date ? activityDateKey(date) : `empty-${index}`; const count = date ? activity[key] ?? 0 : 0; return <span className={`activity-calendar-day activity-level-${Math.min(count, 4)} ${date && day === today.getDate() ? "today" : ""}`} key={key} title={date ? `${key}: ${count} game${count === 1 ? "" : "s"}` : undefined}>{day}</span>; })}</div><div className="activity-calendar-legend"><span>Less</span><i className="activity-cell activity-level-0" /><i className="activity-cell activity-level-1" /><i className="activity-cell activity-level-2" /><i className="activity-cell activity-level-3" /><i className="activity-cell activity-level-4" /><span>More</span></div></section>;
}

function RecentGames({ games, sport }: { games: ProfileGameSummary[]; sport?: Sport }) {
  const visibleGames = sport ? games.filter((game) => game.sport === sport) : games;
  if (!visibleGames.length) return <p className="profile-activity-empty">No completed {sport ? `${sportLabel(sport).toLowerCase()} ` : ""}games yet.</p>;
  return <div className="recent-games-list">{visibleGames.map((game) => <article className="recent-game-row" key={game.id}><span className="recent-game-date"><strong>{new Date(`${game.session_date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit" })}</strong><small>{new Date(`${game.session_date}T00:00:00`).toLocaleDateString("en-IN", { month: "short" })}</small></span><div><strong>{game.group_name}</strong><small>{sportLabel(game.sport)} · {game.area} · {game.start_time}</small></div><span className="recent-game-status">{game.status === "played" ? "Played" : game.status}</span></article>)}</div>;
}

function ProfileSportOverview({ profile, sports, selectedSport, onSelect, headingLabel = "YOUR SPORTS" }: { profile: { cmr_history?: Record<string, CMRHistoryPoint[]>; cmr_game_counts?: Record<string, number>; cmr_ratings?: Record<string, number> }; sports: { value: Sport; label: string }[]; selectedSport: Sport | null; onSelect: (sport: Sport | null) => void; headingLabel?: string }) {
  const cards = sports.map((sport) => {
    const history = profile.cmr_history?.[sport.value] ?? [];
    const ratedHistory = history.filter((point) => point.rating != null);
    const games = profile.cmr_game_counts?.[sport.value] ?? ratedHistory.length;
    return {
      ...sport,
      rating: profile.cmr_ratings?.[sport.value] ?? ratedHistory[ratedHistory.length - 1]?.rating ?? 1,
      games,
      locked: games === 0,
    };
  });

  const totalSessions = cards.reduce((sum, sport) => sum + sport.games, 0);
  return <section className="profile-sport-overview" aria-label="Sport-wise CMR stats"><div className="profile-sport-overview-heading"><div><span className="kicker">{headingLabel}</span><h2>CMR by sport</h2></div><span>Built from completed-game feedback</span></div><div className="profile-sport-overview-grid"><button type="button" className={`profile-sport-stat profile-sport-all ${selectedSport === null ? "selected" : ""}`} onClick={() => onSelect(null)} aria-label={`All sports overview, ${totalSessions} sessions`} aria-pressed={selectedSport === null}><span className="cmr-ring cmr-all-ring"><span><OverviewTrendIcon /></span></span><strong>Overview</strong><small>{totalSessions} session{totalSessions === 1 ? "" : "s"}</small></button>{cards.map((sport) => <button type="button" className={`profile-sport-stat ${selectedSport === sport.value ? "selected" : ""} ${sport.locked ? "locked" : ""}`} key={sport.value} onClick={() => { if (!sport.locked) onSelect(sport.value); }} disabled={sport.locked} aria-label={`${sport.label}, ${sport.locked ? "yet to unlock" : `${sport.rating.toFixed(2)} CMR`}`} aria-pressed={selectedSport === sport.value}><span className="cmr-ring" style={{ background: sport.locked ? "var(--line)" : `conic-gradient(var(--lime) ${Math.max(0, Math.min(100, ((sport.rating - 1) / 9) * 100))}%, #e5eadc 0)` }}><span>{sport.locked ? <span className="cmr-locked-icon" aria-hidden="true"><LockIcon /></span> : <b>{sport.rating.toFixed(2)}</b>}</span></span><strong>{sport.label}</strong>{sport.locked && <small>Play a game to unlock</small>}</button>)}</div></section>;
}

function dropoutChance(profile: { on_time_check_in_count: number; late_check_in_count: number; withdrawal_count: number }) {
  const committedGames = profile.on_time_check_in_count + profile.late_check_in_count + profile.withdrawal_count;
  return committedGames ? Math.round((profile.withdrawal_count / committedGames) * 100) : 0;
}

function ProfileReliability({ profile }: { profile: PlayerProfile }) {
  const showUpCount = profile.on_time_check_in_count + profile.late_check_in_count;
  return <section className="profile-reliability-card" aria-label="Dropout and attendance record">
    <header><div><span className="kicker">ATTENDANCE</span><h2>Dropout chance</h2><p>Based on confirmed games you later left. Separate from CMR.</p></div><strong>{dropoutChance(profile)}%</strong></header>
    <div className="profile-reliability-summary"><b>{showUpCount}</b><span>confirmed show-ups</span><small>{profile.withdrawal_count} dropout{profile.withdrawal_count === 1 ? "" : "s"} recorded</small></div>
  </section>;
}

function PublicProfileView({ profile, followLoading, onBack, onFollow, onShare, onToast }: { profile: PublicPlayerProfile; followLoading: boolean; onBack: () => void; onFollow: () => void; onShare: () => void; onToast: (message: string) => void }) {
  const [selectedSport, setSelectedSport] = useState<Sport | null>(null);
  const canViewDetails = !profile.is_profile_private || profile.is_following;
  const totalGames = totalGamesFor(profile);
  const ratedSports = sportOptions.filter((sport) => (profile.cmr_game_counts?.[sport.value] ?? 0) > 0);
  const highestCmr = ratedSports.length
    ? Math.max(...ratedSports.map((sport) => profile.cmr_ratings?.[sport.value] ?? 1))
    : null;
  const followLabel = followLoading ? "Updating..." : profile.is_following ? "Following" : profile.follow_request_pending ? "Requested" : "Follow";

  return <section className="page-view profile-page public-profile-page unified-public-profile" aria-labelledby="public-profile-title">
    <button type="button" className="public-profile-back-link" onClick={onBack} aria-label="Back to previous page">← <span>Back</span></button>
    <section className="player-profile-hero public-player-profile-hero">
      <div className="player-profile-identity">
        <div className="profile-photo-avatar player-profile-avatar">{profile.profile_image_url ? <img src={profile.profile_image_url} alt={`${profile.display_name} profile`} /> : initials(profile.display_name)}</div>
        <div className="player-profile-copy"><h1 id="public-profile-title">{profile.display_name}</h1><p><span className="player-profile-presence" />{profile.area || "Local player"} · {profile.style} player</p><small className="profile-bio-line">{profile.bio?.trim() || "Ready for the next game."}</small></div>
        <div className="player-profile-side-actions public-profile-hero-actions">
          <div className="public-profile-primary-actions"><button type="button" className={`public-profile-follow-action ${profile.is_following ? "following" : profile.follow_request_pending ? "requested" : ""}`} onClick={onFollow} disabled={followLoading || profile.follow_request_pending}>{followLabel}<span aria-hidden="true">{profile.is_following ? "✓" : profile.follow_request_pending ? "·" : "+"}</span></button><div className="profile-quick-actions"><button type="button" onClick={onShare} aria-label={`Share ${profile.display_name}'s profile`} title="Share profile"><ShareIcon /></button></div></div>
          <div className="player-profile-connections public-profile-connections" aria-label={`${profile.display_name}'s connections`}><span><b>{profile.followers_count}</b><small>Followers</small></span><span><b>{profile.following_count}</b><small>Following</small></span></div>
          {profile.follows_you && <span className="follows-you">Follows you</span>}
        </div>
      </div>
      <div className="player-profile-metrics"><span><b>{totalGames}</b><small>Games</small></span><span className={`player-profile-streak ${profile.weekly_streak_active ? "active" : "at-risk"}`}><i className="player-profile-streak-fire" aria-hidden="true"><StreakFireIcon /></i><b>{profile.weekly_streak}</b><small>Weekly streak</small></span><span><b>{dropoutChance(profile)}%</b><small>Dropout chance</small></span></div>
    </section>

    {!canViewDetails ? <section className="public-profile-private-card"><span aria-hidden="true"><LockIcon /></span><h2>This profile is private</h2><p>Follow {profile.display_name} to see their sports, activity, and recent games.</p></section> : <>
      <ProfileSportOverview profile={profile} sports={sportOptions} selectedSport={selectedSport} onSelect={setSelectedSport} headingLabel="THEIR SPORTS" />
      <section className="profile-insights all-sports public-profile-overview"><section className="profile-cumulative-overview" aria-label={`${profile.display_name}'s all sports summary`}><div><span className="kicker">ALL SPORTS</span><h2>{profile.display_name}&apos;s CourtMate overview</h2><p>Progress from completed games across every unlocked sport.</p></div><div className="profile-cumulative-metrics"><span><strong>{totalGames}</strong><small>Games played</small></span><span><strong>{ratedSports.length}</strong><small>Sports played</small></span><span><strong>{dropoutChance(profile)}%</strong><small>Dropout chance</small></span><span><strong>{highestCmr?.toFixed(2) ?? "--"}</strong><small>Highest CMR</small></span></div></section></section>
      <section className="public-profile-activity unified-public-profile-activity"><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Activity calendar</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={profile.activity_by_date} playerName={profile.display_name} weeklyStreak={profile.weekly_streak} onToast={onToast} /></section><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">RECENT GAMES</span><h2>Where they played</h2></div><span>{profile.recent_games.length} shown</span></div><RecentGames games={profile.recent_games} sport={selectedSport ?? undefined} /></section></section>
    </>}
  </section>;
}

export default function Home() {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [searchScope, setSearchScope] = useState<"court_discovery" | "sports_general" | "out_of_scope" | "performance">("court_discovery");
  const [selectedSport, setSelectedSport] = useState<Sport>("pickleball");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [joiningSessionId, setJoiningSessionId] = useState<string | null>(null);
  const [lastChatRequest, setLastChatRequest] = useState<{ name: string; status: JoinRequest["status"] } | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Finding your best match...");
  const [groupProposal, setGroupProposal] = useState<GroupProposal | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [createGroupDraft, setCreateGroupDraft] = useState<CreateGroupDraft>(() => ({ sport: "pickleball", area: "", ...nextDefaultGameSchedule(), skill_min: "3.2", skill_max: "6.8", style: "casual", rating_mode: "competitive", game_format: "doubles", capacity: 6 }));
  const [createQuery, setCreateQuery] = useState("");
  const [showCreateGame, setShowCreateGame] = useState(false);
  const [createGroupError, setCreateGroupError] = useState("");
  const [createGameVisibility, setCreateGameVisibility] = useState<SessionVisibility>("public");
  const [showCraftedGame, setShowCraftedGame] = useState(false);
  const [creationStep, setCreationStep] = useState<CreationStep>("confirm");
  const [discoveryStep, setDiscoveryStep] = useState<DiscoveryStep | null>(null);
  const [discoveryDraft, setDiscoveryDraft] = useState<DiscoveryDraft>({ sport: null, area: "", date: "", time: "", skill: "" });
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ bio: "", is_profile_private: false, default_session_visibility: "public", area: "Whitefield", age: "", gender: "", preferred_age_range: "any", preferred_genders: [], travel_radius_km: "10", style: "casual", availability: [] });
  const [bioEditing, setBioEditing] = useState(false);
  const [bioSaving, setBioSaving] = useState(false);
  const [profilePictureUploading, setProfilePictureUploading] = useState(false);
  const [locationSaving, setLocationSaving] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [managedGroupId, setManagedGroupId] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);
  const [viewedGroup, setViewedGroup] = useState<GroupView | null>(null);
  const [loadingGroupId, setLoadingGroupId] = useState<string | null>(null);
  const [myRequests, setMyRequests] = useState<ActivityRequest[]>([]);
  const [myGroups, setMyGroups] = useState<ActivityGroup[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ActivityRequest[]>([]);
  const [approvedGames, setApprovedGames] = useState<ActivityGroup[]>([]);
  const [awaitingFeedbackGames, setAwaitingFeedbackGames] = useState<ActivityGroup[]>([]);
  const [pastGames, setPastGames] = useState<PastGame[]>([]);
  const [exploreGames, setExploreGames] = useState<Session[]>([]);
  const [exploreSportFilter, setExploreSportFilter] = useState<Sport | "all">("all");
  const [exploreDateFilter, setExploreDateFilter] = useState("");
  const [exploreCmrFilter, setExploreCmrFilter] = useState<ExploreCmrFilter>("all");
  const [exploreTimeFilter, setExploreTimeFilter] = useState<ExploreTimeFilter>("all");
  const [exploreSearchDraft, setExploreSearchDraft] = useState("");
  const [exploreSearch, setExploreSearch] = useState("");
  const [exploreSportApplied, setExploreSportApplied] = useState<Sport | "all">("all");
  const [exploreDateApplied, setExploreDateApplied] = useState("");
  const [exploreCmrApplied, setExploreCmrApplied] = useState<ExploreCmrFilter>("all");
  const [exploreTimeApplied, setExploreTimeApplied] = useState<ExploreTimeFilter>("all");
  const [exploreLoading, setExploreLoading] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [leavingGameId, setLeavingGameId] = useState<string | null>(null);
  const [justRequestedSessionId, setJustRequestedSessionId] = useState<string | null>(null);
  const [workspaceGroup, setWorkspaceGroup] = useState<ActivityGroup | null>(null);
  const [pendingFeedbackSessionId, setPendingFeedbackSessionId] = useState<string | null>(null);
  const [pendingShareSessionId, setPendingShareSessionId] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [rankingGame, setRankingGame] = useState<ActivityGroup | null>(null);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingEntries, setRankingEntries] = useState<LeaderboardEntry[]>([]);
  const [localRankingEntries, setLocalRankingEntries] = useState<LeaderboardEntry[]>([]);
  const [chatPosts, setChatPosts] = useState<ChatPost[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [scoreSessionId, setScoreSessionId] = useState<string | null>(null);
  const [scorePickerOpen, setScorePickerOpen] = useState(false);
  const [scorePickerSport, setScorePickerSport] = useState<Sport | null>(null);
  const [feedbackSessionId, setFeedbackSessionId] = useState<string | null>(null);
  const [feedbackPickerOpen, setFeedbackPickerOpen] = useState(false);
  const [feedbackMembers, setFeedbackMembers] = useState<GroupMember[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [groupWaitlist, setGroupWaitlist] = useState<GroupMember[]>([]);
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationActioningId, setNotificationActioningId] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [cmrDetailsOpen, setCmrDetailsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionsTab, setConnectionsTab] = useState<ConnectionsTab>("following");
  const [connections, setConnections] = useState<PublicPlayerProfile[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState("");
  const [circleLeaderboardScope, setCircleLeaderboardScope] = useState<CircleLeaderboardScope>("circle");
  const [circleLeaderboardSport, setCircleLeaderboardSport] = useState<Sport>("pickleball");
  const [circleLeaderboardEntries, setCircleLeaderboardEntries] = useState<LeaderboardEntry[]>([]);
  const [circleLeaderboardLoading, setCircleLeaderboardLoading] = useState(false);
  const [circleLeaderboardError, setCircleLeaderboardError] = useState("");
  const [socialProfile, setSocialProfile] = useState<PublicPlayerProfile | null>(null);
  const [viewedProfile, setViewedProfile] = useState<PublicPlayerProfile | null>(null);
  const [profileReturnTab, setProfileReturnTab] = useState<AppTab>("home");
  const [profileLoadingId, setProfileLoadingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [theme, setTheme] = useState<Theme>("light");
  const [gamesViewTab, setGamesViewTab] = useState<GamesViewTab>("explore");
  const [profileSport, setProfileSport] = useState<Sport | null>(null);
  const [profileStatsSport, setProfileStatsSport] = useState<Sport | null>(null);
  const [feedFilter, setFeedFilter] = useState("best");
  const [socialFeedEntry, setSocialFeedEntry] = useState<"all" | "following" | "personal">("all");
  const [toast, setToastState] = useState("");
  const toastTimerRef = useRef<number | null>(null);
  const activityRequestRef = useRef<Promise<ActivitySnapshot> | null>(null);
  const socialProfileRequestRef = useRef<Promise<void> | null>(null);
  const activityLoadVersionRef = useRef(0);
  const groupSpaceCacheRef = useRef(new Map<string, GroupSpaceCacheEntry>());
  const groupSpaceRequestRef = useRef(0);
  const circleLeaderboardRequestRef = useRef(0);
  const sharedGameHandledRef = useRef("");
  const sharedProfileHandledRef = useRef("");
  const liveRefreshInFlightRef = useRef(false);
  const pendingLiveRefreshKeysRef = useRef(new Set<LiveStateKey>());
  const chatRequestVersionRef = useRef(0);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("courtmate-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
      return;
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (user && pathname === "/") router.replace(`/home${window.location.search}`);
    if (!user && pathname === "/home") router.replace(`/${window.location.search}`);
  }, [authReady, pathname, router, user]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("courtmate-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!settingsOpen && !notificationsOpen && !connectionsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeUtilityPage();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen, notificationsOpen, connectionsOpen]);

  useEffect(() => {
    if (!showCreateGame) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowCreateGame(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showCreateGame]);

  useEffect(() => {
    const syncUtilityPage = () => {
      const hash = window.location.hash.replace("#", "");
      setSettingsOpen(hash === "settings");
      setNotificationsOpen(hash === "notifications");
      setCalendarOpen(hash === "profile-calendar");
      setConnectionsOpen(hash === "connections");
      if (!hash.startsWith("group-space-")) setWorkspaceGroup(null);
      if (!hash.startsWith("ranking-")) setRankingGame(null);
      if (!hash.startsWith("group-preview-")) setViewedGroup(null);
      if (!hash.startsWith("player-profile-")) setViewedProfile(null);
    };
    syncUtilityPage();
    window.addEventListener("popstate", syncUtilityPage);
    window.addEventListener("hashchange", syncUtilityPage);
    return () => {
      window.removeEventListener("popstate", syncUtilityPage);
      window.removeEventListener("hashchange", syncUtilityPage);
    };
  }, []);

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
        const searchParams = new URLSearchParams(window.location.search);
        const hasSharedRallyCircle = searchParams.has("rally-circle");
        const tabParam = searchParams.get("tab");
        const viewParam = searchParams.get("view");
        if (hasSharedRallyCircle) {
          setActiveTab("games");
        } else if (tabParam && ["home", "social", "games", "leaderboard", "profile", "communities"].includes(tabParam)) {
          setActiveTab(tabParam === "communities" ? "games" : tabParam as AppTab);
          if (tabParam === "communities") setGamesViewTab("explore");
        } else {
          setActiveTab("social");
        }
        if (viewParam && ["explore", "pending", "upcoming", "awaiting_feedback", "history", "requested", "confirmed", "past", "incoming"].includes(viewParam)) {
          setGamesViewTab(viewParam as GamesViewTab);
        }
        void loadProfile(nextUser);
        void loadSocialProfile(nextUser);
        if (!hasSharedRallyCircle) {
          void loadNotifications(nextUser);
          void loadGamesActivity(nextUser, false, false);
        }
      } else {
        setActiveTab("home");
        setSettingsOpen(false);
        setNotificationsOpen(false);
        setCalendarOpen(false);
        setConnectionsOpen(false);
        setViewedGroup(null);
        setViewedProfile(null);
      }
    });
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;
    const searchParams = new URLSearchParams(window.location.search);
    const sharedGameId = searchParams.get("rally-circle");
    if (!sharedGameId) return;
    const handledKey = `${sharedGameId}:${user.uid}`;
    if (sharedGameHandledRef.current === handledKey) return;
    sharedGameHandledRef.current = handledKey;
    setActiveTab("games");
    void openSharedGame(sharedGameId, user);
  }, [authReady, user]);

  useEffect(() => {
    if (!authReady || !user) return;
    const hash = window.location.hash.replace("#player-profile-", "");
    if (!window.location.hash.startsWith("#player-profile-") || !hash) return;
    const handledKey = `${hash}:${user.uid}`;
    if (sharedProfileHandledRef.current === handledKey) return;
    sharedProfileHandledRef.current = handledKey;
    void viewPlayerProfile(hash, false);
  }, [authReady, user]);

  useEffect(() => {
    if (!user) return;
    const refreshLiveState = () => {
      if (document.visibilityState !== "visible") return;
      void refreshLiveStateFor(["notifications", "activity", "social-profile"]);
    };
    const interval = window.setInterval(refreshLiveState, 5000);
    window.addEventListener("focus", refreshLiveState);
    document.addEventListener("visibilitychange", refreshLiveState);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshLiveState);
      document.removeEventListener("visibilitychange", refreshLiveState);
    };
  }, [user]);

  useEffect(() => {
    if (!connectionsOpen || !user) return;
    void loadConnections(connectionsTab, user);
    const refresh = () => {
      if (document.visibilityState === "visible") void loadConnections(connectionsTab, user, true);
    };
    const interval = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [connectionsOpen, connectionsTab, user]);

  useEffect(() => {
    if (!user || activeTab !== "profile" || viewedProfile) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadProfile(user, true);
    };
    const interval = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeTab, user, viewedProfile]);

  useEffect(() => {
    if (activeTab !== "leaderboard" || !user) return;
    void loadCircleLeaderboard(circleLeaderboardScope, circleLeaderboardSport, user, true);
    const refresh = () => {
      if (document.visibilityState === "visible") void loadCircleLeaderboard(circleLeaderboardScope, circleLeaderboardSport, user, false);
    };
    const interval = window.setInterval(refresh, 5000);
    return () => window.clearInterval(interval);
  }, [activeTab, circleLeaderboardScope, circleLeaderboardSport, user]);

  useEffect(() => {
    if (!workspaceGroup && !viewedGroup) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeUtilityPage();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [workspaceGroup, viewedGroup]);

  useEffect(() => {
    const hash = window.location.hash;
    const cleanHash = () => {
      if (window.history.length > 1) window.history.back();
      else window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    if (!workspaceGroup && hash.startsWith("#group-space-")) cleanHash();
    if (!rankingGame && hash.startsWith("#ranking-")) cleanHash();
    if (!viewedGroup && hash.startsWith("#group-preview-")) cleanHash();
  }, [workspaceGroup, viewedGroup, viewedProfile]);

  useEffect(() => {
    document.documentElement.dataset.viewedProfilePrivate = viewedProfile?.is_profile_private ? "true" : "false";
    return () => {
      delete document.documentElement.dataset.viewedProfilePrivate;
    };
  }, [viewedProfile]);

  async function authorizedFetch(url: string, options: RequestInit = {}, authUser: User | null = user) {
    if (!authUser) throw new Error("Sign in required");
    const token = await authUser.getIdToken();
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  }

  async function discoveryFetch(url: string, options: RequestInit = {}) {
    return user ? authorizedFetch(url, options, user) : fetch(url, options);
  }

  async function selectFixedAvatar(path: string) {
    if (!user) return;
    try {
      setProfilePictureUploading(true);
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_image_url: path }),
      });
      if (!response.ok) throw new Error("Could not save avatar");
      const savedProfile = await response.json() as PlayerProfile;
      setProfile(savedProfile);
      setSocialProfile((current) => current ? { ...current, profile_image_url: savedProfile.profile_image_url ?? null } : current);
      invalidateLiveState(["social-profile", "feed"]);
      setToast("Avatar updated");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not save avatar");
    } finally {
      setProfilePictureUploading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function uploadProfilePicture(file: File | string) {
    if (!user) return;
    if (typeof file === "string") {
      await selectFixedAvatar(file);
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
      // Keep profile uploads on the authenticated API: browser Firebase uploads can fail CORS preflight.
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile-image/upload`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Could not upload profile photo");
      }
      const savedProfile = await response.json() as PlayerProfile;

      setProfile(savedProfile);
      setSocialProfile((current) => current ? { ...current, profile_image_url: savedProfile.profile_image_url ?? null } : current);
      invalidateLiveState(["social-profile", "feed"]);
      setToast("Profile photo updated");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not upload profile photo");
    } finally {
      setProfilePictureUploading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function removeProfilePicture() {
    if (!user || !profile?.profile_image_url) return;
    try {
      setProfilePictureUploading(true);
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_image_url: null }),
      });
      if (!response.ok) throw new Error("Profile photo could not be removed");
      const savedProfile = await response.json() as PlayerProfile;
      setProfile(savedProfile);
      setSocialProfile((current) => current ? { ...current, profile_image_url: null } : current);
      invalidateLiveState(["social-profile", "feed"]);
      setToast("Profile photo removed");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not remove profile photo");
    } finally {
      setProfilePictureUploading(false);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function analyzeProfileActivityScreenshot(file: File, sport: string): Promise<ActivityProof | null> {
    if (!user) return null;
    if (!storage) {
      setToast("Firebase Storage is not configured");
      return null;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setToast("Choose a JPG, PNG, or WebP screenshot");
      return null;
    }
    if (file.size > 8 * 1024 * 1024) {
      setToast("Tracker screenshots must be smaller than 8 MB");
      return null;
    }
    try {
      const uploadRes = await authorizedFetch(`${apiUrl}/v1/social/media/upload`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Could not upload screenshot");
      const uploadPayload = await uploadRes.json() as { media_url: string };
      const imageUrl = uploadPayload.media_url;
      setToast("Gemini is reading your performance...");
      const response = await authorizedFetch(`${apiUrl}/v1/me/activity-proof/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image_url: imageUrl, sport }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Could not analyse tracker screenshot");
      }
      const proof = await response.json() as ActivityProof;
      setToast("Performance check-in added");
      return proof;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not analyse tracker screenshot");
      return null;
    }
  }

  async function attachPerformanceScreenshot(file: File) {
    const sport = sportFromText(query) ?? selectedSport;
    const proof = await analyzeProfileActivityScreenshot(file, sport);
    if (!proof) return;
    const metrics = [
      proof.analysis.calories_burned != null ? `${Math.round(proof.analysis.calories_burned)} kcal` : null,
      proof.analysis.duration_minutes != null ? `${Math.round(proof.analysis.duration_minutes)} min` : null,
      proof.analysis.distance_km != null ? `${proof.analysis.distance_km.toFixed(1)} km` : null,
      proof.analysis.average_heart_rate != null ? `${proof.analysis.average_heart_rate} bpm` : null,
    ].filter(Boolean).join(" · ");
    const timestamp = Date.now();
    setSearchScope("performance");
    setSessions([]);
    setGroupProposal(null);
    setShowCreateGame(false);
    setChatMessages((messages) => [...messages.slice(-8),
      { id: `${timestamp}-user`, role: "user", text: `Uploaded a ${sportLabel(sport)} wearable screenshot.`, imageUrl: proof.image_url },
      { id: `${timestamp}-assistant`, role: "assistant", text: `I read your ${sportLabel(sport)} check-in: ${metrics || "the visible activity metrics are saved"}. ${proof.analysis.summary} Ask me how this compares with your game history.` },
    ]);
    setToast("Screenshot added. Ask me about your performance.");
    window.setTimeout(() => setToast(""), 2600);
  }

  async function loadNotifications(authUser: User = user as User, syncActivity = true): Promise<boolean> {
    if (!authUser) return false;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/notifications`, {}, authUser);
      if (!response.ok) throw new Error("Notifications unavailable");
      const payload = await response.json() as { notifications: AppNotification[] };
      setNotifications((current) => hasStateChanged(current, payload.notifications) ? payload.notifications : current);
      if (syncActivity && payload.notifications.some((notification) => ["join_request", "request_update"].includes(notification.kind) && !notification.read)) {
        void loadGamesActivity(authUser, false, false, true);
      }
      return true;
    } catch {
      // Notifications are supplementary; keep the rest of the app usable if unavailable.
      return false;
    }
  }

  async function loadSocialProfile(authUser: User = user as User, useCachedSnapshot = true) {
    if (!authUser) return;
    if (useCachedSnapshot) {
      const cachedProfile = readSocialProfileCache(authUser.uid);
      if (cachedProfile) setSocialProfile((current) => hasStateChanged(current, cachedProfile) ? cachedProfile : current);
    }
    if (socialProfileRequestRef.current) return socialProfileRequestRef.current;

    const request = (async () => {
      try {
        const response = await authorizedFetch(`${apiUrl}/v1/players/${authUser.uid}`, {}, authUser);
        if (!response.ok) throw new Error("Social profile unavailable");
        const nextProfile = await response.json() as PublicPlayerProfile;
        if (auth?.currentUser?.uid !== authUser.uid) return;
        setSocialProfile((current) => hasStateChanged(current, nextProfile) ? nextProfile : current);
        writeSocialProfileCache(authUser.uid, nextProfile);
      } catch {
        // Social details are supplementary; keep the rest of the app usable if unavailable.
      }
    })();
    socialProfileRequestRef.current = request;
    try {
      await request;
    } finally {
      if (socialProfileRequestRef.current === request) socialProfileRequestRef.current = null;
    }
  }

  async function loadConnections(tab: ConnectionsTab, authUser: User = user as User, silent = false) {
    if (!authUser) return;
    try {
      if (!silent) {
        setConnectionsLoading(true);
        setConnectionsError("");
      }
      const response = await authorizedFetch(`${apiUrl}/v1/me/${tab}`, {}, authUser);
      if (!response.ok) throw new Error("Connections unavailable");
      const payload = await response.json() as { profiles?: PublicPlayerProfile[] };
      const nextConnections = payload.profiles ?? [];
      setConnections((current) => hasStateChanged(current, nextConnections) ? nextConnections : current);
      if (silent) setConnectionsError("");
    } catch {
      if (!silent) {
        setConnections([]);
        setConnectionsError("Could not load connections");
      }
    } finally {
      if (!silent) setConnectionsLoading(false);
    }
  }

  async function loadCircleLeaderboard(scope: CircleLeaderboardScope, sport: Sport, authUser: User = user as User, showLoader = true) {
    if (!authUser) return;
    const requestId = ++circleLeaderboardRequestRef.current;
    try {
      if (showLoader) setCircleLeaderboardLoading(true);
      if (showLoader) setCircleLeaderboardError("");
      const response = await authorizedFetch(`${apiUrl}/v1/me/circle-leaderboard?scope=${scope}&sport=${sport}`, {}, authUser);
      if (!response.ok) throw new Error("Circle leaderboard unavailable");
      const payload = await response.json() as { entries?: LeaderboardEntry[] };
      if (requestId !== circleLeaderboardRequestRef.current) return;
      const nextEntries = payload.entries ?? [];
      setCircleLeaderboardEntries((current) => hasStateChanged(current, nextEntries) ? nextEntries : current);
      setCircleLeaderboardError("");
    } catch {
      if (requestId !== circleLeaderboardRequestRef.current) return;
      if (showLoader) setCircleLeaderboardError("Could not load the leaderboard");
    } finally {
      if (showLoader && requestId === circleLeaderboardRequestRef.current) setCircleLeaderboardLoading(false);
    }
  }

  async function refreshLiveStateFor(keys: LiveStateKey[], authUser: User | null = user) {
    if (!authUser) return;
    if (liveRefreshInFlightRef.current) {
      keys.forEach((key) => pendingLiveRefreshKeysRef.current.add(key));
      return;
    }
    liveRefreshInFlightRef.current = true;
    try {
      const refreshes: Promise<unknown>[] = [];
      if (keys.includes("notifications")) refreshes.push(loadNotifications(authUser, false));
      if (keys.includes("activity")) refreshes.push(loadGamesActivity(authUser, false, false, true));
      if (keys.includes("connections") && connectionsOpen) refreshes.push(loadConnections(connectionsTab, authUser, true));
      if (keys.includes("social-profile")) refreshes.push(loadSocialProfile(authUser, false));
      if (keys.includes("profile") && activeTab === "profile" && !viewedProfile) refreshes.push(loadProfile(authUser, true));
      await Promise.all(refreshes);
    } finally {
      liveRefreshInFlightRef.current = false;
      const pendingKeys = Array.from(pendingLiveRefreshKeysRef.current);
      pendingLiveRefreshKeysRef.current.clear();
      if (pendingKeys.length) void refreshLiveStateFor(pendingKeys, authUser);
    }
  }

  async function viewPlayerProfile(playerId: string, updateHistory = true) {
    if (playerId === user?.uid) {
      setViewedProfile(null);
      setActiveTab("profile");
      window.history.replaceState({ courtMatePage: "profile" }, "", `${window.location.pathname}${window.location.search}`);
      return;
    }
    setProfileLoadingId(playerId);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/players/${playerId}`);
      if (!response.ok) throw new Error("Player profile unavailable");
      openPlayerProfile(await response.json() as PublicPlayerProfile, updateHistory);
    } catch {
      setToast("Could not load this player profile");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setProfileLoadingId(null);
    }
  }

  function openPlayerProfile(playerProfile: PublicPlayerProfile, updateHistory = true) {
    setProfileLoadingId(null);
    setWorkspaceGroup(null);
    setViewedGroup(null);
    setConnectionsOpen(false);
    setProfileReturnTab(activeTab);
    setViewedProfile(playerProfile);
    setActiveTab("profile");
    if (updateHistory) {
      window.history.replaceState({ courtMatePage: "home" }, "", `${window.location.pathname}${window.location.search}`);
      window.history.pushState({ courtMatePage: "player-profile" }, "", `#player-profile-${playerProfile.id}`);
    }
  }

  function closePlayerProfile() {
    setViewedProfile(null);
    setActiveTab(profileReturnTab);
    if (window.location.hash.startsWith("#player-profile-")) window.history.back();
  }

  async function toggleFollowProfile() {
    if (!viewedProfile || !user || viewedProfile.id === user.uid) return;
    const wasFollowing = viewedProfile.is_following;
    const wasRequestPending = viewedProfile.follow_request_pending;
    if (wasRequestPending) return;
    try {
      setProfileLoadingId(`profile-follow-${viewedProfile.id}`);
      const action = wasFollowing ? "unfollow" : "follow";
      const response = await authorizedFetch(`${apiUrl}/v1/players/${viewedProfile.id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error("Follow update failed");
      const nextProfile = await response.json() as PublicPlayerProfile;
      setViewedProfile(nextProfile);
      if (wasFollowing !== nextProfile.is_following) {
        setSocialProfile((current) => current ? { ...current, following_count: Math.max(0, current.following_count + (nextProfile.is_following ? 1 : -1)) } : current);
      }
      void refreshLiveStateFor(["connections", "social-profile", "feed", "recommendations"]);
    } catch {
      setToast(wasFollowing ? "Could not unfollow this player" : "Could not follow this player");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setProfileLoadingId(null);
    }
  }

  async function toggleConnection(connection: PublicPlayerProfile) {
    if (!user || connection.id === user.uid) return;
    const wasFollowing = connection.is_following;
    try {
      setProfileLoadingId(`connection-${connection.id}`);
      const action = wasFollowing ? "unfollow" : "follow";
      const response = await authorizedFetch(`${apiUrl}/v1/players/${connection.id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error("Connection update failed");
      const updated = await response.json() as PublicPlayerProfile;
      setConnections((current) => connectionsTab === "following" && (wasFollowing || connection.follow_request_pending) ? current.filter((item) => item.id !== connection.id) : current.map((item) => item.id === updated.id ? updated : item));
      setSocialProfile((current) => current ? { ...current, following_count: Math.max(0, current.following_count + (wasFollowing ? -1 : 1)) } : current);
      void refreshLiveStateFor(["connections", "social-profile", "feed", "recommendations"]);
    } catch {
      setToast("Could not update this connection");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setProfileLoadingId(null);
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

  async function markAllNotificationsRead() {
    if (!user) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/notifications/read-all`, { method: "POST" });
      if (!response.ok) throw new Error("Notification update failed");
      const payload = await response.json() as { notifications: AppNotification[] };
      setNotifications(payload.notifications);
    } catch {
      setToast("Could not update notifications");
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function decideNotificationRequest(notification: AppNotification, status: "approved" | "declined") {
    if (!notification.request_id || notificationActioningId) return;
    setNotificationActioningId(notification.id);
    const saved = await decideJoinRequest(notification.request_id, status, notification.session_id);
    if (!saved) {
      setNotificationActioningId(null);
      return;
    }
    setNotifications((items) => items.map((item) => item.id === notification.id
      ? { ...item, read: true, action_status: saved.status }
      : item));
    setNotificationActioningId(null);
    void loadNotifications();
  }

  async function decideFollowRequest(notification: AppNotification, status: "approved" | "declined") {
    if (notificationActioningId) return;
    setNotificationActioningId(notification.id);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/follow-requests/${notification.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
      if (!response.ok) throw new Error("Follow request update failed");
      setNotifications((items) => items.map((item) => item.id === notification.id
        ? { ...item, read: true, action_status: status }
        : item));
      await loadSocialProfile();
      void loadNotifications();
      setToast(status === "approved" ? "Follow request accepted" : "Follow request declined");
    } catch {
      setToast("Could not update this follow request");
    } finally {
      setNotificationActioningId(null);
    }
    window.setTimeout(() => setToast(""), 2600);
  }

  function openNotification(notification: AppNotification) {
    if (!notification.read) void markNotificationRead(notification.id);
    closeUtilityPage();
    if (notification.kind === "join_request") {
      setActiveTab("games");
      setGamesViewTab("upcoming");
      void loadGamesActivity();
      return;
    }
    if (notification.kind === "request_update") {
      setActiveTab("games");
      setGamesViewTab("pending");
      void loadGamesActivity();
      return;
    }
    if (notification.kind === "game_completed") {
      const completedGame = [...approvedGames, ...myGroups, ...awaitingFeedbackGames, ...pastGames.map(({ session }) => session)].find((game) => game.id === notification.session_id);
      if (completedGame) {
        void openGroupSpace(completedGame);
        return;
      }
      setActiveTab("games");
      setGamesViewTab("awaiting_feedback");
      void loadGamesActivity();
      return;
    }
    if (notification.kind === "game_reminder") {
      const upcomingGame = [...approvedGames, ...myGroups].find((game) => game.id === notification.session_id);
      if (upcomingGame) {
        void openGroupSpace(upcomingGame);
        return;
      }
      setActiveTab("games");
      setGamesViewTab("upcoming");
      void loadGamesActivity();
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

  async function loadProfile(authUser: User = user as User, silent = false) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me`, {}, authUser);
      if (!response.ok) throw new Error("Profile unavailable");
      const nextProfile = await response.json() as PlayerProfile;
      setProfile((current) => hasStateChanged(current, nextProfile) ? nextProfile : current);
      const mostPlayedSport = sportOptions
        .filter((sport) => nextProfile.cmr_ratings?.[sport.value] != null)
        .sort((a, b) => (nextProfile.cmr_game_counts?.[b.value] ?? 0) - (nextProfile.cmr_game_counts?.[a.value] ?? 0))[0];
      const preferredSport = nextProfile.primary_sport ?? mostPlayedSport?.value ?? "pickleball";
      if (!silent) {
        setSelectedSport(preferredSport);
        setProfileDraft({ bio: nextProfile.bio ?? "", is_profile_private: nextProfile.is_profile_private ?? false, default_session_visibility: nextProfile.default_session_visibility ?? "public", area: nextProfile.area, age: nextProfile.age?.toString() ?? "", gender: nextProfile.gender ?? "", preferred_age_range: nextProfile.preferred_age_range ?? "any", preferred_genders: nextProfile.preferred_genders ?? [], latitude: nextProfile.latitude, longitude: nextProfile.longitude, travel_radius_km: nextProfile.travel_radius_km?.toString() ?? "10", style: nextProfile.style as ProfileDraft["style"], availability: nextProfile.availability ?? [] });
      }
    } catch {
      if (!silent) setToast("Could not load your CourtMate profile");
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
    activityRequestRef.current = null;
    socialProfileRequestRef.current = null;
    setProfile(null);
    setProfileDraft({ bio: "", is_profile_private: false, default_session_visibility: "public", area: "Whitefield", age: "", gender: "", preferred_age_range: "any", preferred_genders: [], travel_radius_km: "10", style: "casual", availability: [] });
    setManagedGroupId(null);
    setWorkspaceGroup(null);
    setChatPosts([]);
    setGroupMembers([]);
    setJoinRequests([]);
    setMyRequests([]);
    setMyGroups([]);
    setIncomingRequests([]);
    setApprovedGames([]);
    setPastGames([]);
    setNotifications([]);
    setNotificationsOpen(false);
    setSettingsOpen(false);
    setCalendarOpen(false);
    setConnectionsOpen(false);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
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
    const age = profileDraft.age.trim() ? Number(profileDraft.age) : undefined;
    if (age !== undefined && (!Number.isInteger(age) || age < 13 || age > 100)) {
      setToast("Age must be between 13 and 100");
      return;
    }
    const body: { bio: string; is_profile_private: boolean; default_session_visibility: SessionVisibility; area: string; style: string; availability: string[]; travel_radius_km: number; preferred_age_range: AgeRange; preferred_genders: Gender[]; age?: number; gender?: Gender; latitude?: number; longitude?: number } = {
      bio: profileDraft.bio.trim(),
      is_profile_private: profileDraft.is_profile_private,
      default_session_visibility: profileDraft.default_session_visibility,
      area: profileDraft.area.trim() || "Whitefield",
      style: profileDraft.style,
      availability: profileDraft.availability,
      travel_radius_km: travelRadius,
      preferred_age_range: profileDraft.preferred_age_range,
      preferred_genders: profileDraft.preferred_genders,
    };
    if (age !== undefined) body.age = age;
    if (profileDraft.gender) body.gender = profileDraft.gender;
    if (profileDraft.latitude != null && profileDraft.longitude != null) {
      body.latitude = profileDraft.latitude;
      body.longitude = profileDraft.longitude;
    }
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("Profile update failed");
      const updatedProfile = await response.json() as PlayerProfile;
      setProfile(updatedProfile);
      setProfileDraft({ bio: updatedProfile.bio ?? "", is_profile_private: updatedProfile.is_profile_private ?? false, default_session_visibility: updatedProfile.default_session_visibility ?? "public", area: updatedProfile.area, age: updatedProfile.age?.toString() ?? "", gender: updatedProfile.gender ?? "", preferred_age_range: updatedProfile.preferred_age_range ?? "any", preferred_genders: updatedProfile.preferred_genders ?? [], latitude: updatedProfile.latitude, longitude: updatedProfile.longitude, travel_radius_km: updatedProfile.travel_radius_km?.toString() ?? "10", style: updatedProfile.style as ProfileDraft["style"], availability: updatedProfile.availability ?? [] });
      invalidateLiveState(["profile", "social-profile", "recommendations"]);
      setToast("Profile preferences saved");
      closeUtilityPage();
    } catch {
      setToast("Could not save your profile preferences");
    }
  }

  async function saveBio(event: FormEvent) {
    event.preventDefault();
    if (!user) {
      setToast("Sign in with Google before updating your bio");
      return;
    }
    const bio = profileDraft.bio.trim();
    if (bio.length > 500) {
      setToast("Bio must be 500 characters or fewer");
      return;
    }
    try {
      setBioSaving(true);
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Bio update failed");
      }
      const updatedProfile = await response.json() as PlayerProfile;
      setProfile(updatedProfile);
      setProfileDraft((draft) => ({ ...draft, bio: updatedProfile.bio ?? "" }));
      setBioEditing(false);
      invalidateLiveState(["profile", "social-profile", "feed"]);
      setToast("Bio saved");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not save your bio");
    } finally {
      setBioSaving(false);
    }
  }

  function toggleAvailability(slot: string) {
    setProfileDraft((draft) => ({ ...draft, availability: draft.availability.includes(slot) ? draft.availability.filter((item) => item !== slot) : [...draft.availability, slot] }));
  }

  function togglePreferredGender(gender: Gender) {
    setProfileDraft((draft) => ({ ...draft, preferred_genders: draft.preferred_genders.includes(gender) ? draft.preferred_genders.filter((item) => item !== gender) : [...draft.preferred_genders, gender] }));
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setToast("Location access is not supported in this browser");
      return;
    }
    setLocationSaving(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void persistCurrentLocation(position.coords.latitude, position.coords.longitude);
      },
      () => {
        setLocationSaving(false);
        setToast("Could not access your location. Check browser location permission and try again.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }

  async function persistCurrentLocation(latitude: number, longitude: number) {
    setProfileDraft((draft) => ({ ...draft, latitude, longitude }));
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ latitude, longitude }),
      });
      const payload = await response.json().catch(() => ({})) as PlayerProfile & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Location update failed");
      setProfile(payload);
      setProfileDraft((draft) => ({ ...draft, latitude: payload.latitude, longitude: payload.longitude }));
      invalidateLiveState(["profile", "social-profile", "recommendations"]);
      setToast("Current location updated");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not update your location");
    } finally {
      setLocationSaving(false);
    }
  }

  function selectDetectedSport(sport: Sport) {
    setSelectedSport(sport);
  }

  function localPerformanceAnswer(requestQuery: string) {
    const normalized = requestQuery.toLowerCase();
    if (/\b(reliability|reliable|attendance|show up|show-up)\b/.test(normalized)) {
      const showUps = (profile?.on_time_check_in_count ?? 0) + (profile?.late_check_in_count ?? 0);
      return `Your dropout chance is ${profile ? dropoutChance(profile) : 0}%. You have ${showUps} confirmed show-up${showUps === 1 ? "" : "s"} and ${profile?.withdrawal_count ?? 0} dropout${profile?.withdrawal_count === 1 ? "" : "s"} recorded.`;
    }
    const ratings = Object.entries(profile?.cmr_ratings ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number");
    if (!ratings.length) return "You do not have a CMR history yet. Complete a racket-sport game to start building one.";
    const requestedSport = sportFromText(requestQuery);
    const sortedRatings = [...ratings].sort((left, right) => right[1] - left[1]);
    const defaultRating = /\b(weakest|lowest)\b/.test(normalized) ? sortedRatings[sortedRatings.length - 1] : sortedRatings[0];
    const [sport, rating] = (requestedSport && ratings.find(([name]) => name === requestedSport)) ?? defaultRating;
    const games = profile?.cmr_game_counts?.[sport] ?? 0;
    const history = [...(profile?.cmr_history?.[sport] ?? [])].sort((left, right) => left.session_date.localeCompare(right.session_date));
    const recent = history.slice(-3);
    const recentDelta = recent.reduce((total, point) => total + (point.delta ?? 0), 0);
    const sportName = sportLabel(sport);
    if (/\b(progress|progression|trend|trending|changing|change over time|movement)\b/.test(normalized)) {
      const progressionRatings = requestedSport
        ? ratings.filter(([name]) => name === requestedSport)
        : [...ratings].sort((left, right) => (profile?.cmr_game_counts?.[right[0]] ?? 0) - (profile?.cmr_game_counts?.[left[0]] ?? 0));
      const progression = progressionRatings.map(([name, currentRating]) => {
        const points = [...(profile?.cmr_history?.[name] ?? [])].sort((left, right) => left.session_date.localeCompare(right.session_date));
        const startingRating = points[0]?.rating ?? currentRating;
        const movement = currentRating - startingRating;
        const direction = movement > 0.01 ? `up ${movement.toFixed(2)}` : movement < -0.01 ? `down ${Math.abs(movement).toFixed(2)}` : "steady";
        const gameCount = profile?.cmr_game_counts?.[name] ?? points.length;
        return `${sportLabel(name as Sport)}: ${startingRating.toFixed(2)} to ${currentRating.toFixed(2)} (${direction}) across ${gameCount} rated game${gameCount === 1 ? "" : "s"}`;
      });
      return `Your CMR progression is ${progression.join("; ")}.`;
    }
    if (/\b(strongest|best sport|highest)\b/.test(normalized)) return `Your strongest current CourtMate signal is ${sportName} at ${rating.toFixed(2)}/10 CMR across ${games} game${games === 1 ? "" : "s"}.`;
    if (/\b(weakest|lowest)\b/.test(normalized)) return `Your lowest current CourtMate signal is ${sportName} at ${rating.toFixed(2)}/10 CMR across ${games} game${games === 1 ? "" : "s"}. Treat it cautiously when the game count is small.`;
    if (/\b(summarize|summarise|summary|recap)\b|\brecent games?\b/.test(normalized)) {
      const gamesToDescribe = (socialProfile?.recent_games ?? []).filter((game) => !requestedSport || game.sport === requestedSport).slice(0, 3);
      if (!gamesToDescribe.length) return `Your ${sportName} CMR is ${rating.toFixed(2)}/10 across ${games} recorded game${games === 1 ? "" : "s"}, but no completed-game details are available to summarise yet.`;
      return `Your latest recorded games are ${gamesToDescribe.map((game) => `${game.group_name} in ${game.area}`).join("; ")}. Your current ${sportName} CMR is ${rating.toFixed(2)}/10.`;
    }
    if (/\b(improve|improvement|work on|focus on|next step)\b/.test(normalized)) {
      if (games < 3) return `Your ${sportName} CMR is ${rating.toFixed(2)}/10, but ${games} game${games === 1 ? " is" : "s are"} too little evidence for a technical recommendation. Complete more confirmed games first.`;
      const direction = recentDelta > 0.01 ? `up ${recentDelta.toFixed(2)}` : recentDelta < -0.01 ? `down ${Math.abs(recentDelta).toFixed(2)}` : "stable";
      return `Your ${sportName} CMR is ${rating.toFixed(2)}/10 and is ${direction} across your latest rated games. Use the next 2-3 games to confirm that trend; CourtMate has result data, not shot-level data, so it cannot reliably name a technique weakness yet.`;
    }
    const direction = recentDelta > 0.01 ? `up ${recentDelta.toFixed(2)}` : recentDelta < -0.01 ? `down ${Math.abs(recentDelta).toFixed(2)}` : "not showing a clear change";
    return `Your current ${sportName} CMR is ${rating.toFixed(2)}/10 across ${games} game${games === 1 ? "" : "s"}. Your recent recorded movement is ${direction}.`;
  }

  async function search(event?: FormEvent, nextQuery?: string, exact = true, authUser: User | null = user, displayQuery?: string) {
    event?.preventDefault();
    if (!authUser) {
      setToast("Sign in with Google before searching");
      return;
    }
    const requestQuery = nextQuery ?? query;
    setDiscoveryStep(null);
    const performanceRequest = isPerformanceQuery(requestQuery);
    const requestVersion = ++chatRequestVersionRef.current;
    const shouldShowMessage = exact && requestQuery.trim().length > 0;
    const requestTimestamp = Date.now();
    if (shouldShowMessage) {
      setLastChatRequest(null);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-user`, role: "user", text: (displayQuery ?? requestQuery).trim() }]);
      setQuery("");
    }
    setShowCreateGame(false);
    setShowCraftedGame(false);
    setLoading(true);
    setLoadingMessage(performanceRequest ? "Reading your CourtMate history..." : "Finding your best match...");
    const loadingTimer = window.setTimeout(() => {
      if (requestVersion === chatRequestVersionRef.current) setLoadingMessage(performanceRequest ? "Comparing your recent form..." : "Finding your best match...");
    }, 420);
    try {
      if (performanceRequest) {
        const response = await authorizedFetch(`${apiUrl}/v1/me/performance-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: requestQuery }),
        }, authUser);
        const payload = await response.json().catch(() => ({})) as { answer?: string; detail?: string };
        if (requestVersion !== chatRequestVersionRef.current) return;
        if (!response.ok) throw new Error(payload.detail ?? "Performance coach is unavailable");
        const answer = payload.answer?.trim() ?? "";
        const invalidAnswer = !answer || answer === "[]" || answer.startsWith("{") || /\b(requirement|system prompt|stored player context|user question)\s*:/i.test(answer);
        setSessions([]);
        setGroupProposal(null);
        setSearchScope("performance");
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: invalidAnswer ? localPerformanceAnswer(requestQuery) : answer }]);
        return;
      }
      const requestSport = sportFromText(requestQuery) ?? selectedSport;
      const previousRequest = searchScope === "court_discovery" && (sessions.length > 0 || groupProposal)
        ? [...chatMessages].reverse().find((message) => message.role === "user")?.text
        : undefined;
      selectDetectedSport(requestSport);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: requestQuery, context: previousRequest, sport: requestSport, mode: exact ? "exact" : "profile" }),
      }, authUser);
      const payload = await response.json().catch(() => ({})) as SearchResponse & { detail?: string };
      if (requestVersion !== chatRequestVersionRef.current) return;
      if (!response.ok) throw new Error(payload.detail ?? "The game search is temporarily unavailable");
      const isInScope = payload.scope !== "out_of_scope";
      setSessions(payload.recommendations.map((item: { session: Session; score: number; reasons: { explanation: string } }) => ({
        ...item.session,
        open_slots: item.session.capacity - item.session.confirmed_player_ids.length,
        score: item.score,
        explanation: item.reasons.explanation,
      })));
      setSearchScope(payload.scope ?? "court_discovery");
      setGroupProposal(isInScope ? payload.group_proposal ?? null : null);
      setGroupNameDraft(payload.group_proposal?.group_name ?? "");
      const shouldStartCreation = isInScope && payload.recommendations.length === 0 && Boolean(payload.group_proposal);
      const needsSport = shouldStartCreation && !sportFromText(requestQuery);
      setShowCraftedGame(false);
      if (shouldStartCreation) setCreationStep(needsSport ? "sport" : "vibe");
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
          style: payload.group_proposal.style === "social" ? "social" : "casual",
          rating_mode: "competitive",
          game_format: payload.group_proposal.game_format ?? "doubles",
          capacity: payload.group_proposal.capacity ?? 6,
        });
      }
      if (shouldShowMessage && payload.message) {
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: payload.message }]);
      } else if (exact && requestQuery.trim()) {
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: payload.message || (payload.recommendations.length ? "I found a few games that could work." : "I could not find an exact match yet.") }]);
      }
      if (shouldStartCreation) {
        const firstStep = needsSport ? "sport" : "vibe";
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-creation-assistant`, role: "assistant", text: `I can create one around those requirements. ${creationQuestion(firstStep)}` }]);
      }
    } catch {
      if (requestVersion !== chatRequestVersionRef.current) return;
      setSessions([]);
      setGroupProposal(null);
      setGroupNameDraft("");
      setSearchScope(performanceRequest ? "performance" : "court_discovery");
      if (shouldShowMessage) {
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: performanceRequest ? localPerformanceAnswer(requestQuery) : "I couldn't reach the live game search. Please try again." }]);
      }
      if (!performanceRequest) setToast("Could not search live groups. Check that the API is running.");
    } finally {
      window.clearTimeout(loadingTimer);
      if (requestVersion === chatRequestVersionRef.current) {
        setLoading(false);
        setLoadingMessage("Finding your best match...");
        window.setTimeout(() => setToast(""), 2600);
      }
    }
  }

  function openCreateGame(sourceMessage = "") {
    if (!user) {
      void signIn();
      return;
    }
    const sourceQuery = sourceMessage.trim();
    setDiscoveryStep(null);
    const explicitSport = sportFromText(sourceQuery);
    const requestSport = explicitSport ?? selectedSport;
    const area = profile?.area || "Whitefield";
    const playerCmr = cmrForSport(requestSport);
    const cmrMin = clampCmr(playerCmr - 1.8);
    const cmrMax = clampCmr(playerCmr + 1.8);
    const schedule = nextDefaultGameSchedule();
    const nextProposal: GroupProposal = {
      group_name: `${area} ${sportLabel(requestSport)} Game`,
      sport: requestSport,
      area,
      session_date: schedule.session_date,
      start_time: schedule.start_time,
      end_time: schedule.end_time,
      skill_min: skillBandFromCmr(cmrMin),
      skill_max: skillBandFromCmr(cmrMax),
      style: profile?.style === "social" ? "social" : "casual",
      game_format: "doubles",
      capacity: 6,
      explanation: "Set the details for your game. CourtMate will keep the group organized and help you find compatible players.",
    };
    setSelectedSport(requestSport);
    setSessions([]);
    setGroupProposal(nextProposal);
    setGroupNameDraft(nextProposal.group_name);
    setCreateGroupError("");
    setShowCraftedGame(false);
    setShowCreateGame(false);
    const firstStep: CreationStep = explicitSport ? "area" : "sport";
    setCreationStep(firstStep);
    setCreateQuery(sourceQuery || `Create a ${sportLabel(requestSport)} game near ${area}`);
    setCreateGroupDraft({ sport: nextProposal.sport, area: nextProposal.area, session_date: nextProposal.session_date ?? schedule.session_date, start_time: nextProposal.start_time ?? schedule.start_time, end_time: nextProposal.end_time ?? schedule.end_time, skill_min: nextProposal.skill_min.toString(), skill_max: nextProposal.skill_max.toString(), style: nextProposal.style === "social" ? "social" : "casual", rating_mode: "competitive", game_format: nextProposal.game_format, capacity: nextProposal.capacity });
    setCreateGameVisibility(profile?.default_session_visibility ?? "public");
    const introduction = explicitSport ? `I can create a ${sportLabel(requestSport)} game.` : "Let's create a game.";
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: `${introduction} ${creationQuestion(firstStep)}` }]);
  }

  function toggleGamesForm() {
    if (!user) {
      void signIn();
      return;
    }
    if (showCreateGame) {
      closeCreateGameForm();
      return;
    }
    const sport = selectedSport;
    const area = profile?.area?.trim() || "";
    const playerCmr = cmrForSport(sport);
    const cmrMin = clampCmr(playerCmr - 1.8);
    const cmrMax = clampCmr(playerCmr + 1.8);
    const style: CreateGroupDraft["style"] = profile?.style === "social" ? "social" : "casual";
    const schedule = nextDefaultGameSchedule();
    setGroupNameDraft(`${area || "Local"} ${sportLabel(sport)} Game`);
    setCreateGroupDraft({ sport, area, ...schedule, skill_min: skillBandFromCmr(cmrMin).toString(), skill_max: skillBandFromCmr(cmrMax).toString(), style, rating_mode: "competitive", game_format: "doubles", capacity: 6 });
    setCreateGameVisibility(profile?.default_session_visibility ?? "public");
    setCreateGroupError("");
    setShowCreateGame(true);
  }

  function closeCreateGameForm() {
    setShowCreateGame(false);
    setCreateGroupError("");
  }

  function cmrForSport(sport: Sport) {
    const currentCmr = profile?.cmr_ratings?.[sport];
    if (currentCmr != null) return clampCmr(currentCmr);
    const legacyRating = profile?.sport_ratings?.[sport] ?? (sport === "pickleball" ? profile?.dupr_rating ?? undefined : undefined);
    return legacyRating != null ? cmrFromLegacySkillBand(legacyRating) : 1;
  }

  function discoveryQuestion(step: DiscoveryStep) {
    if (step === "sport") return "Which sport do you want to play? Pickleball, badminton, tennis, padel, squash, or table tennis?";
    if (step === "area") return "Which area should I search? You can name a locality or say near me.";
    if (step === "date") return "Which date works? You can say today, tomorrow, this weekend, or any date.";
    if (step === "time") return "What time works: morning, daytime, evening, night, or any time?";
    return "What CMR level should I match: beginner, intermediate, advanced, a specific range, or any level?";
  }

  function discoveryQuickPrompts() {
    if (discoveryStep === "sport") return ["Pickleball", "Badminton", "Tennis", "Padel"];
    if (discoveryStep === "area") return ["Near me", "Whitefield", "Indiranagar", "HSR Layout"];
    if (discoveryStep === "date") return ["Today", "Tomorrow", "This weekend", "Any date"];
    if (discoveryStep === "time") return ["Morning", "Evening", "After work", "Any time"];
    return ["Beginner", "Intermediate", "Advanced", "Any level"];
  }

  function parseDiscoveryReply(message: string, current: DiscoveryDraft, step: DiscoveryStep | null) {
    const normalized = message.trim().replace(/[,.!?]+$/, "").trim();
    const lowered = normalized.toLowerCase();
    const next = { ...current };
    const sport = sportFromText(message);
    if (sport) next.sport = sport;
    if (/\b(?:near|around) me\b|\bmy (?:area|location|locality)\b/.test(lowered)) {
      next.area = profile?.area?.trim() || "Whitefield";
    } else {
      const areaMatch = message.match(/\b(?:near|around|in)\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'.-]*)*?)(?=\s+(?:on|this|next|at|today|tomorrow|morning|evening|night|beginner|intermediate|advanced|cmr)\b|\s*[,.!?]|$)/i);
      if (areaMatch) next.area = areaMatch[1].trim();
      else if (step === "area" && normalized.length >= 2 && normalized.length <= 80) next.area = normalized.replace(/^(?:near|around|in)\s+/i, "");
    }
    const dateMatch = lowered.match(/\b(today|tomorrow|this weekend|next weekend|any date|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) next.date = dateMatch[1];
    else if (step === "date" && normalized) next.date = normalized;
    const timeMatch = lowered.match(/\b(any time|morning|daytime|afternoon|evening|night|after work|tonight|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/);
    if (timeMatch) next.time = timeMatch[1];
    else if (step === "time" && normalized) next.time = normalized;
    const skillMatch = lowered.match(/\b(any level|beginner|intermediate|advanced|(?:10|[1-9](?:\.\d)?)\s*(?:-|to)\s*(?:10|[1-9](?:\.\d)?))\b/);
    if (skillMatch) next.skill = skillMatch[1];
    else if (step === "skill" && normalized) next.skill = normalized;
    return next;
  }

  function nextDiscoveryStep(draft: DiscoveryDraft): DiscoveryStep | null {
    if (!draft.sport) return "sport";
    if (!draft.area) return "area";
    if (!draft.date) return "date";
    if (!draft.time) return "time";
    if (!draft.skill) return "skill";
    return null;
  }

  function discoverySearchQuery(draft: DiscoveryDraft) {
    const date = draft.date === "any date" ? "" : ` ${draft.date}`;
    const time = draft.time === "any time" ? "" : ` ${draft.time}`;
    const skill = draft.skill === "any level" ? "" : `${draft.skill} `;
    return `Find ${skill}${sportLabel(draft.sport as Sport)} games near ${draft.area}${date}${time}`.trim();
  }

  function startDiscovery(message: string) {
    const initial = parseDiscoveryReply(message, { sport: null, area: "", date: "", time: "", skill: "" }, null);
    const nextStep = nextDiscoveryStep(initial);
    setSessions([]);
    setGroupProposal(null);
    setDiscoveryDraft(initial);
    setDiscoveryStep(nextStep);
    if (!nextStep) {
      void search(undefined, discoverySearchQuery(initial), true, user, message);
      return;
    }
    const timestamp = Date.now();
    setQuery("");
    setChatMessages((messages) => [...messages.slice(-8), { id: `${timestamp}-discovery-user`, role: "user", text: message.trim() }, { id: `${timestamp}-discovery-assistant`, role: "assistant", text: discoveryQuestion(nextStep) }]);
  }

  function handleDiscoveryReply(message: string) {
    if (!discoveryStep) return;
    const updated = parseDiscoveryReply(message, discoveryDraft, discoveryStep);
    const nextStep = nextDiscoveryStep(updated);
    setDiscoveryDraft(updated);
    setDiscoveryStep(nextStep);
    setQuery("");
    if (!nextStep) {
      void search(undefined, discoverySearchQuery(updated), true, user, message);
      return;
    }
    const timestamp = Date.now();
    setChatMessages((messages) => [...messages.slice(-8), { id: `${timestamp}-discovery-user`, role: "user", text: message.trim() }, { id: `${timestamp}-discovery-assistant`, role: "assistant", text: discoveryQuestion(nextStep) }]);
  }

  function creationQuestion(step = creationStep) {
    if (step === "sport") return "Which sport should I use? Pickleball, badminton, tennis, padel, squash, or table tennis?";
    if (step === "area") return "Which area should I use? A neighbourhood is enough.";
    if (step === "date") return "What date should the game be? You can say tomorrow, Saturday, or a specific date.";
    if (step === "time") return "What start and end time should I use? For example, 7 PM to 9 PM.";
    if (step === "skill") return "Who should this game be for? Beginner, intermediate, advanced, or a CMR range?";
    if (step === "vibe") return "What should the game feel like: relaxed or social?";
    if (step === "format") return "Is this singles or doubles?";
    if (step === "capacity") return "How many players in total: 4, 6, or 8?";
    if (step === "visibility") return "Who can join: anyone nearby, your followers, or only people with the private link?";
    if (step === "name") return `Would you like a custom game name, or should I use “${groupNameDraft || "the suggested name"}”?`;
    return "Here is the game plan. Ready to create it, or would you like to change something?";
  }

  function creationPlanLabel(draft = createGroupDraft) {
    const dateLabel = draft.session_date
      ? new Date(`${draft.session_date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
      : "Date to be decided";
    const accessLabel = createGameVisibility === "public" ? "anyone nearby" : createGameVisibility === "followers" ? "followers" : "private link";
    return `${sportLabel(draft.sport)} · ${dateLabel} · ${draft.start_time}–${draft.end_time} · ${draft.area || "Area to be decided"} · ${draft.game_format} · ${draft.capacity} players · ${accessLabel}`;
  }

  function creationQuickPrompts() {
    if (creationStep === "sport") return ["Pickleball", "Badminton", "Tennis", "Padel"];
    if (creationStep === "area") return ["Use my saved area", "Near me"];
    if (creationStep === "date") return ["Tomorrow", "Saturday", "Sunday"];
    if (creationStep === "time") return ["7 PM to 9 PM", "8 AM to 10 AM", "6 PM to 8 PM"];
    if (creationStep === "skill") return ["Beginner", "Intermediate", "Advanced"];
    if (creationStep === "vibe") return ["Casual", "Social"];
    if (creationStep === "format") return ["Singles", "Doubles"];
    if (creationStep === "capacity") return ["4 players", "6 players", "8 players"];
    if (creationStep === "visibility") return ["Anyone nearby", "Followers only", "Private link"];
    if (creationStep === "name") return ["Use suggested name"];
    return ["Create this game", "Change time", "Change area"];
  }

  function nextCreationStep(step: CreationStep, draft: CreateGroupDraft): CreationStep {
    const order: CreationStep[] = ["sport", "area", "date", "time", "skill", "vibe", "format", "capacity", "visibility", "name", "confirm"];
    let nextStep = order[order.indexOf(step) + 1] ?? "confirm";
    if (nextStep === "capacity" && draft.game_format === "singles") nextStep = "visibility";
    return nextStep;
  }

  function formatCreationDate(value: Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseCreationReply(reply: string) {
    const lowered = reply.toLowerCase().trim();
    const normalizedReply = reply.trim().replace(/[,.!?]+$/, "").trim();
    const nextDraft = { ...createGroupDraft };
    let changed = false;
    const detectedSport = sportFromText(reply);
    if (detectedSport) {
      nextDraft.sport = detectedSport;
      changed = true;
    }
    const style = ["casual", "social"].find((value) => lowered.includes(value)) as CreateGroupDraft["style"] | undefined;
    if (style) {
      nextDraft.style = style;
      changed = true;
    }
    const skillBands = { beginner: ["1.0", "2.9"], intermediate: ["3.0", "5.9"], advanced: ["6.0", "10.0"] } as const;
    const skill = (Object.keys(skillBands) as Array<keyof typeof skillBands>).find((value) => lowered.includes(value));
    if (skill) {
      nextDraft.skill_min = skillBands[skill][0];
      nextDraft.skill_max = skillBands[skill][1];
      changed = true;
    }
    const timeMatch = lowered.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (timeMatch) {
      let hour = Number(timeMatch[1]) % 12;
      if (timeMatch[3] === "pm") hour += 12;
      nextDraft.start_time = `${String(hour).padStart(2, "0")}:${timeMatch[2] ?? "00"}`;
      nextDraft.end_time = `${String((hour + 2) % 24).padStart(2, "0")}:${timeMatch[2] ?? "00"}`;
      changed = true;
    }
    const timeRange = lowered.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|–|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (timeRange) {
      const endMeridiem = timeRange[6];
      const startMeridiem = timeRange[3] ?? endMeridiem;
      let startHour = Number(timeRange[1]) % 12 + (startMeridiem === "pm" ? 12 : 0);
      let endHour = Number(timeRange[4]) % 12 + (endMeridiem === "pm" ? 12 : 0);
      if (!timeRange[3] && endMeridiem === "pm" && startHour > endHour) startHour -= 12;
      nextDraft.start_time = `${String(startHour).padStart(2, "0")}:${timeRange[2] ?? "00"}`;
      nextDraft.end_time = `${String(endHour).padStart(2, "0")}:${timeRange[5] ?? "00"}`;
      changed = true;
    }
    if (lowered.includes("today") || lowered.includes("tomorrow") || /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(lowered)) {
      const nextDate = new Date();
      if (lowered.includes("tomorrow")) nextDate.setDate(nextDate.getDate() + 1);
      else {
        const dayMatch = lowered.match(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/);
        if (dayMatch) {
          const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
          const target = dayNames.findIndex((day) => day.startsWith(dayMatch[1]));
          const daysAhead = (target - nextDate.getDay() + 7) % 7 || 7;
          nextDate.setDate(nextDate.getDate() + daysAhead);
        }
      }
      nextDraft.session_date = formatCreationDate(nextDate);
      changed = true;
    }
    if (creationStep === "date" && !changed) {
      const parsedDate = new Date(`${normalizedReply} 12:00`);
      if (!Number.isNaN(parsedDate.getTime())) {
        nextDraft.session_date = formatCreationDate(parsedDate);
        changed = true;
      }
    }
    if (/\bsingles?\b/.test(lowered)) {
      nextDraft.game_format = "singles";
      nextDraft.capacity = 2;
      changed = true;
    } else if (/\bdoubles?\b/.test(lowered)) {
      nextDraft.game_format = "doubles";
      if (nextDraft.capacity < 4) nextDraft.capacity = 6;
      changed = true;
    }
    if (creationStep === "capacity") {
      const capacity = Number(lowered.match(/\b(4|6|8)\b/)?.[1]);
      if (capacity) {
        nextDraft.capacity = capacity;
        changed = true;
      }
    }
    if (/\b(?:anyone|public|nearby)\b/.test(lowered)) {
      setCreateGameVisibility("public");
      changed = true;
    } else if (/\bfollowers?\b/.test(lowered)) {
      setCreateGameVisibility("followers");
      changed = true;
    } else if (/\b(?:private|link)\b/.test(lowered)) {
      setCreateGameVisibility("private");
      changed = true;
    }
    const savedArea = profile?.area?.trim() || createGroupDraft.area.trim();
    const usesSavedArea = /^(?:use|keep) (?:my )?(?:saved )?(?:area|location)$/i.test(normalizedReply) || /^(?:near|around) me$/i.test(normalizedReply) || /^my location$/i.test(normalizedReply);
    if (usesSavedArea) {
      if (savedArea) {
        nextDraft.area = savedArea;
        changed = true;
      }
    }
    const areaMatch = reply.match(/\b(?:near|around|in)\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'.-]*)*?)(?=\s+(?:on|this|next|at|around|tomorrow|today|tonight|morning|evening|afternoon)\b|\s*[,.!?]|$)/i);
    if (areaMatch) {
      nextDraft.area = areaMatch[1].trim().replace(/\s+/g, " ").replace(/[,.!?]+$/, "");
      changed = true;
    } else if (creationStep === "area" && !usesSavedArea) {
      // During the area step, accept any short location phrase instead of
      // limiting users to a predefined neighbourhood list.
      const reservedTerms = /\b(?:today|tomorrow|morning|afternoon|evening|tonight|beginner|intermediate|advanced|casual|social|pickleball|badminton|tennis|padel|squash|table tennis|ping pong)\b/i;
      const areaCandidate = normalizedReply.replace(/^(?:near|around|in)\s+/i, "").trim();
      if (areaCandidate.length >= 2 && areaCandidate.length <= 80 && !reservedTerms.test(areaCandidate)) {
        nextDraft.area = areaCandidate.replace(/\s+/g, " ");
        changed = true;
      }
    }
    const useSuggestedName = creationStep === "name" && /^(?:use |keep )?(?:the )?(?:suggested|default)(?: name)?$/i.test(normalizedReply);
    const customName = creationStep === "name" && !useSuggestedName && normalizedReply.length >= 2 && normalizedReply.length <= 80 ? normalizedReply : null;
    return { nextDraft, changed: changed || useSuggestedName || Boolean(customName), customName };
  }

  async function handleCreationReply(reply: string) {
    const cleanReply = reply.trim();
    if (!cleanReply || !groupProposal) return;
    setQuery("");
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-user`, role: "user", text: cleanReply }]);
    const lowered = cleanReply.toLowerCase();
    if (creationStep === "confirm" && /^(post|create|yes|keep|looks good|go ahead|use that)/.test(lowered)) {
      await createGroup();
      return;
    }
    if (creationStep === "confirm" && lowered.includes("time")) {
      setCreationStep("time");
      setShowCraftedGame(false);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: creationQuestion("time") }]);
      return;
    }
    if (creationStep === "confirm" && (lowered.includes("area") || lowered.includes("location"))) {
      setCreationStep("area");
      setShowCraftedGame(false);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: creationQuestion("area") }]);
      return;
    }
    if (creationStep === "confirm" && (lowered.includes("skill") || lowered.includes("level") || lowered.includes("vibe") || lowered.includes("mood"))) {
      const nextStep = lowered.includes("vibe") || lowered.includes("mood") ? "vibe" : "skill";
      setCreationStep(nextStep);
      setShowCraftedGame(false);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: creationQuestion(nextStep) }]);
      return;
    }
    if (creationStep === "confirm" && lowered.includes("sport") && !sportFromText(cleanReply)) {
      setCreationStep("sport");
      setShowCraftedGame(false);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: creationQuestion("sport") }]);
      return;
    }
    if (creationStep === "confirm") {
      const requestedEdit: CreationStep | null = lowered.includes("date") || lowered.includes("day")
        ? "date"
        : lowered.includes("format") || lowered.includes("single") || lowered.includes("double")
          ? "format"
          : lowered.includes("player") || lowered.includes("capacity") || lowered.includes("spot")
            ? createGroupDraft.game_format === "singles" ? "format" : "capacity"
            : lowered.includes("visibility") || lowered.includes("who can join") || lowered.includes("private") || lowered.includes("public") || lowered.includes("follower")
              ? "visibility"
              : lowered.includes("name") || lowered.includes("title")
                ? "name"
                : null;
      if (requestedEdit) {
        setCreationStep(requestedEdit);
        setShowCraftedGame(false);
        setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: creationQuestion(requestedEdit) }]);
        return;
      }
    }
    const { nextDraft, changed, customName } = parseCreationReply(cleanReply);
    if (changed) {
      const previousGeneratedName = `${createGroupDraft.area || "Whitefield"} ${sportLabel(createGroupDraft.sport)} Game`;
      const nextGeneratedName = `${nextDraft.area || "Whitefield"} ${sportLabel(nextDraft.sport)} Game`;
      const nextGroupName = customName ?? (!groupNameDraft || groupNameDraft === previousGeneratedName ? nextGeneratedName : groupNameDraft);
      setCreateGroupDraft(nextDraft);
      setGroupNameDraft(nextGroupName);
      setGroupProposal((proposal) => proposal ? { ...proposal, group_name: nextGroupName, sport: nextDraft.sport, area: nextDraft.area, session_date: nextDraft.session_date, start_time: nextDraft.start_time, end_time: nextDraft.end_time, skill_min: Number(nextDraft.skill_min), skill_max: Number(nextDraft.skill_max), style: nextDraft.style } : proposal);
      const nextStep = nextCreationStep(creationStep, nextDraft);
      setCreationStep(nextStep);
      setShowCraftedGame(nextStep === "confirm");
      const nextMessage = nextStep === "confirm"
        ? `Everything is set: ${creationPlanLabel(nextDraft)} · ${nextDraft.style}. ${creationQuestion("confirm")}`
        : `Got it. ${creationQuestion(nextStep)}`;
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: nextMessage }]);
      return;
    }
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: creationQuestion() }]);
  }

  function skipSession(sessionId: string) {
    const remainingSessions = sessions.filter((session) => session.id !== sessionId);
    setSessions(remainingSessions);
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-skip`, role: "assistant", text: remainingSessions.length ? "That one is skipped. I can keep looking, or create a game around the same requirements." : "No problem. I could not find another fit. Would you like me to create a game around the same requirements?" }]);
    setToast("Skipped. I will keep this search focused on better fits.");
    window.setTimeout(() => setToast(""), 2600);
  }

  function requestSessionFromChat(message: string) {
    if (!/\b(?:request(?:\s+to)?\s+join|join)\b/i.test(message)) return false;
    const availableSessions = sessions.filter((session) => session.organizer_id !== user?.uid);
    const timestamp = Date.now();
    setQuery("");
    setLastChatRequest(null);
    setChatMessages((messages) => [...messages.slice(-8), { id: `${timestamp}-user`, role: "user", text: message.trim() }]);
    if (!availableSessions.length) {
      setChatMessages((messages) => [...messages.slice(-8), { id: `${timestamp}-assistant`, role: "assistant", text: "Search for a game first, then I can send a request to join it for you." }]);
      return true;
    }
    const normalizedMessage = message.trim().toLowerCase();
    const ordinal = normalizedMessage.match(/\b(?:the\s+)?(first|one|1|second|two|2|third|three|3)\b/)?.[1];
    const ordinalIndex = ordinal === "first" || ordinal === "one" || ordinal === "1" ? 0 : ordinal === "second" || ordinal === "two" || ordinal === "2" ? 1 : ordinal === "third" || ordinal === "three" || ordinal === "3" ? 2 : -1;
    const namedSession = availableSessions.find((session) => normalizedMessage.includes(session.group_name.toLowerCase()));
    const target = namedSession ?? (ordinalIndex >= 0 ? availableSessions[ordinalIndex] : availableSessions.length === 1 ? availableSessions[0] : undefined);
    if (!target) {
      setChatMessages((messages) => [...messages.slice(-8), { id: `${timestamp}-assistant`, role: "assistant", text: `I found ${availableSessions.length} groups. Say "join option 1" or tap Request to join on the group you want.` }]);
      return true;
    }
    void joinSession(target.id, target.group_name, target.organizer_id);
    return true;
  }

  function clearChat() {
    setChatMessages([]);
    setSearchScope("court_discovery");
    setSessions([]);
    setGroupProposal(null);
    setShowCreateGame(false);
    setShowCraftedGame(false);
    setCreationStep("confirm");
    setDiscoveryStep(null);
    setDiscoveryDraft({ sport: null, area: "", date: "", time: "", skill: "" });
    setQuery("");
    setScoreSessionId(null);
    setScorePickerOpen(false);
    setScorePickerSport(null);
    setFeedbackSessionId(null);
    setFeedbackPickerOpen(false);
    setFeedbackMembers([]);
    setLastChatRequest(null);
  }

  function scoreableGames() {
    const gamesById = new Map<string, ActivityGroup>();
    approvedGames
      .filter((game) => game.status !== "completed" && game.status !== "cancelled")
      .forEach((game) => gamesById.set(game.id, game));
    return [...gamesById.values()].sort((left, right) => `${left.session_date} ${left.start_time}`.localeCompare(`${right.session_date} ${right.start_time}`));
  }

  function filterScoreGames(message: string) {
    const sport = sportFromText(message);
    if (!sport) return false;
    setScorePickerSport(sport);
    setScorePickerOpen(true);
    setQuery("");
    const matches = scoreableGames().filter((game) => game.sport === sport);
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-score-filter-user`, role: "user", text: message.trim() }, { id: `${Date.now()}-score-filter-assistant`, role: "assistant", text: matches.length ? `I found ${matches.length} active ${sportLabel(sport)} game${matches.length === 1 ? "" : "s"}. Choose one and I will record the score for that session.` : `I could not find an active ${sportLabel(sport)} game in your games yet. Join or confirm one first, then I can record the score here.` }]);
    return true;
  }

  function startScoreEntry() {
    setSessions([]);
    setGroupProposal(null);
    setShowCreateGame(false);
    setShowCraftedGame(false);
    setFeedbackSessionId(null);
    setFeedbackPickerOpen(false);
    setFeedbackMembers([]);
    setDiscoveryStep(null);
    setScoreSessionId(null);
    setScorePickerSport(null);
    setScorePickerOpen(scoreableGames().length > 0);
    setQuery("");
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-score-prompt`, role: "assistant", text: scoreableGames().length ? "Which active game should I score? Choose one below or say a sport, like padel." : "You do not have an active confirmed game yet. Find or join one first, then I can record the score here." }]);
  }

  function chooseScoreSession(game: ActivityGroup) {
    setScoreSessionId(game.id);
    setScorePickerOpen(false);
    setScorePickerSport(null);
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-score-session`, role: "assistant", text: `Recording a score for ${game.group_name}. Tell me who played and the score.` }]);
  }

  function startFeedbackEntry() {
    setSessions([]);
    setGroupProposal(null);
    setShowCreateGame(false);
    setShowCraftedGame(false);
    setScoreSessionId(null);
    setScorePickerOpen(false);
    setScorePickerSport(null);
    setDiscoveryStep(null);
    setFeedbackSessionId(null);
    setFeedbackMembers([]);
    setFeedbackPickerOpen(pastGames.length > 0);
    setQuery("");
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-feedback-prompt`, role: "assistant", text: pastGames.length ? "Which completed game would you like to review?" : "You do not have a completed game to review yet. Play a game and I will collect feedback here." }]);
  }

  function analyzeFeedbackForSport(message: string) {
    const sport = sportFromText(message);
    if (!sport) return false;
    setFeedbackPickerOpen(false);
    setFeedbackSessionId(null);
    setFeedbackMembers([]);
    selectDetectedSport(sport);
    const analysisQuery = `Analyze my existing ${sportLabel(sport)} CMR and game history. Give me concise feedback on my progress and what the available data suggests I should work on next.`;
    void search(undefined, analysisQuery, true, user, message);
    return true;
  }

  async function chooseFeedbackSession(game: PastGame) {
    setFeedbackSessionId(game.session.id);
    setFeedbackPickerOpen(false);
    setQuery("");
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${game.session.id}/group`);
      if (response.ok) setFeedbackMembers((await response.json() as GroupView).members);
    } catch {
      setFeedbackMembers([]);
    }
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-feedback-session`, role: "assistant", text: `Reviewing ${game.session.group_name}. Tell me how it felt: great, okay, or not for me. You can also say “Rhea was intermediate” to rate a player.` }]);
  }

  function parseFeedbackRatings(message: string) {
    const lowered = message.toLowerCase();
    const levels = ["beginner", "intermediate", "advanced"] as const;
    return feedbackMembers
      .filter((member) => member.id !== user?.uid)
      .map((member) => {
        const firstName = member.display_name.split(/\s+/)[0]?.toLowerCase();
        const level = levels.find((candidate) => lowered.includes(`${firstName} ${candidate}`) || lowered.includes(`${candidate} ${firstName}`));
        return level ? { player_id: member.id, skill_level: level } : null;
      })
      .filter((rating): rating is { player_id: string; skill_level: "beginner" | "intermediate" | "advanced" } => Boolean(rating));
  }

  async function postHomeFeedback(message: string) {
    if (!feedbackSessionId || !message.trim()) return;
    const selectedGame = pastGames.find((game) => game.session.id === feedbackSessionId)?.session;
    const lowered = message.toLowerCase();
    const negative = /not for me|bad|poor|never|no return|unfair|uneven|rough/.test(lowered);
    const positive = /great|amazing|loved|fun|excellent|enjoyed|fair|balanced/.test(lowered);
    const fun = negative ? 2 : positive ? 5 : 3;
    const fairness = /unfair|uneven|mismatch|mismatched/.test(lowered) ? 2 : /fair|balanced|even/.test(lowered) ? 5 : 3;
    const ratings = parseFeedbackRatings(message);
    const requestTimestamp = Date.now();
    setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-feedback-user`, role: "user", text: message.trim() }]);
    setQuery("");
    setLoading(true);
    setLoadingMessage("Updating your game feedback...");
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${feedbackSessionId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fun, fairness, would_return: !negative, ratings }),
      });
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not save game feedback");
      setFeedbackSessionId(null);
      setFeedbackMembers([]);
      invalidateSocialFeedCache();
      invalidateLiveState(["activity", "profile", "social-profile", "feed", "notifications"]);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-feedback-assistant`, role: "assistant", text: `${selectedGame?.group_name ?? "Your game"} feedback is saved. CMR and player insights have been refreshed from confirmed scores and ratings.` }]);
      void loadProfile(user as User);
      void loadSocialProfile(user as User);
      void loadGamesActivity(user as User, false, false, true);
    } catch (error) {
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-feedback-error`, role: "assistant", text: error instanceof Error ? error.message : "I could not save that feedback." }]);
    } finally {
      setLoading(false);
      setLoadingMessage("Finding your best match...");
    }
  }


  async function postHomeScore(message: string) {
    if (!scoreSessionId || !message.trim()) return;
    const session = scoreableGames().find((game) => game.id === scoreSessionId);
    const requestTimestamp = Date.now();
    setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-score-user`, role: "user", text: message.trim() }]);
    setQuery("");
    setLoading(true);
    setLoadingMessage("Posting the score for your game...");
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${scoreSessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
      });
      const payload = await response.json().catch(() => ({})) as ChatPost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not post this score");
      const assistantText = payload.post_type === "match_result"
        ? `Score posted for ${session?.group_name ?? "your game"}. The players in this result can confirm it here. Once the game closes, CMR will update automatically.`
        : "I could not identify two sides and a score. Try: “Ananya and Kavya beat Rohit and Sana 11 to 8”.";
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-score-assistant`, role: "assistant", text: assistantText }]);
      setScoreSessionId(null);
      setScorePickerOpen(false);
      setScorePickerSport(null);
    } catch (error) {
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-score-error`, role: "assistant", text: error instanceof Error ? error.message : "I could not post that score." }]);
    } finally {
      setLoading(false);
    }
  }

  function sendQuickPrompt(prompt: string) {
    if (prompt === "Create a game") {
      openCreateGame();
      return;
    }
    if (prompt === "Record final score") {
      startScoreEntry();
      return;
    }
    if (prompt === "Give game feedback") {
      startFeedbackEntry();
      return;
    }
    if (feedbackSessionId) {
      void postHomeFeedback(prompt);
      return;
    }
    if (discoveryStep) {
      handleDiscoveryReply(prompt);
      return;
    }
    if (prompt === "Back to game search") {
      setScoreSessionId(null);
      setScorePickerOpen(false);
      setScorePickerSport(null);
      setFeedbackSessionId(null);
      setFeedbackPickerOpen(false);
      setFeedbackMembers([]);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-score-back`, role: "assistant", text: "What game would you like to find?" }]);
      return;
    }
    if (groupProposal) {
      void handleCreationReply(prompt);
      return;
    }
    if (isFindGameQuery(prompt) || (!sessions.length && ["This weekend", "Casual after work"].includes(prompt))) {
      startDiscovery(prompt);
      return;
    }
    setQuery(prompt);
    void search(undefined, prompt);
  }

  function quickPrompts() {
    if (feedbackSessionId) return ["Great and fair", "It was okay", "Not for me"];
    if (feedbackPickerOpen) return ["Back to game search"];
    if (scoreSessionId) return ["Back to game search", "Create a game"];
    if (scorePickerOpen) return ["Back to game search"];
    if (discoveryStep) return discoveryQuickPrompts();
    const feedbackPrompt = pastGames.length ? ["Give game feedback"] : [];
    if (searchScope === "performance") return ["How is my CMR changing?", "What should I improve?", "Summarise my recent games", "Create a game", ...feedbackPrompt];
    if (groupProposal && !sessions.length) return creationQuickPrompts();
    if (sessions.length) return ["Show another option", "Make it more casual", "Only show games after 7 PM", "Create a game", ...(approvedGames.length ? ["Record final score"] : []), ...feedbackPrompt];
    return ["Find games around me", "This weekend", "Casual after work", "Create a game", ...(approvedGames.length ? ["Record final score"] : []), ...feedbackPrompt];
  }

  function quickPromptGroups() {
    const contextual = Boolean(feedbackSessionId || feedbackPickerOpen || scoreSessionId || scorePickerOpen || groupProposal || discoveryStep);
    if (contextual) {
      return [{ label: "SUGGESTED REPLIES", description: "Continue the current task", prompts: quickPrompts() }];
    }
    const findPrompts = sessions.length
      ? ["Show another option", "Make it more casual", "Only show games after 7 PM"]
      : ["Find games around me", "This weekend", "Casual after work"];
    const actionPrompts = ["Create a game", ...(approvedGames.length ? ["Record final score"] : []), ...(pastGames.length ? ["Give game feedback"] : [])];
    return [
      {
        label: "ANSWERS FROM YOUR DATA",
        description: "Grounded in your CMR and completed games",
        prompts: ["How is my CMR changing?", "What should I improve?", "Summarise my recent games"],
      },
      {
        label: sessions.length ? "REFINE RESULTS" : "FIND A GAME",
        description: "Search current CourtMate games",
        prompts: findPrompts,
      },
      {
        label: "ACTIONS",
        description: "Create a game or record what happened",
        prompts: actionPrompts,
      },
    ].filter((group) => group.prompts.length > 0);
  }

  function handleChatSubmit(event: FormEvent) {
    event.preventDefault();
    if (!scoreSessionId && !feedbackSessionId && !groupProposal && !discoveryStep && isCreateGameQuery(query)) {
      openCreateGame(query);
      setQuery("");
      return;
    }
    if (discoveryStep) {
      handleDiscoveryReply(query);
      return;
    }
    if (feedbackPickerOpen && analyzeFeedbackForSport(query)) {
      return;
    }
    if (!scoreSessionId && !feedbackSessionId && !groupProposal && requestSessionFromChat(query)) {
      return;
    }
    if (!scoreSessionId && !feedbackSessionId && (/(?:\bsubmit\b|\bleave\b|\bsave\b).*\bfeedback\b/i.test(query) || /\brate\b.*\b(?:player|players|lineup|game|match)\b/i.test(query))) {
      startFeedbackEntry();
      return;
    }
    if (!scoreSessionId && /\b(?:log|record|add)\b.*\bscore\b/i.test(query)) {
      startScoreEntry();
      return;
    }
    if (scoreSessionId) {
      void postHomeScore(query);
      return;
    }
    if (scorePickerOpen && filterScoreGames(query)) {
      return;
    }
    if (feedbackSessionId) {
      void postHomeFeedback(query);
      return;
    }
    if (groupProposal) {
      void handleCreationReply(query);
      return;
    }
    if (isFindGameQuery(query)) {
      startDiscovery(query);
      return;
    }
    void search(undefined, query);
  }

  function changeCreateSport(sport: Sport) {
    const playerCmr = cmrForSport(sport);
    const skillMin = skillBandFromCmr(playerCmr - 1.8);
    const skillMax = skillBandFromCmr(playerCmr + 1.8);
    setSelectedSport(sport);
    setCreateGroupDraft((draft) => ({ ...draft, sport, skill_min: skillMin.toString(), skill_max: skillMax.toString() }));
    setGroupNameDraft((name) => name.replace(/(Pickleball|Badminton|Tennis|Padel|Squash|Table tennis) Game$/i, `${sportLabel(sport)} Game`));
    setGroupProposal((proposal) => proposal ? { ...proposal, sport, group_name: proposal.group_name.replace(/(Pickleball|Badminton|Tennis|Padel|Squash|Table tennis) Game$/i, `${sportLabel(sport)} Game`), skill_min: skillMin, skill_max: skillMax } : proposal);
  }

  function changeGameFormat(gameFormat: CreateGroupDraft["game_format"]) {
    const capacity = gameFormat === "singles" ? 2 : createGroupDraft.capacity < 4 ? 6 : createGroupDraft.capacity;
    setCreateGroupDraft((draft) => ({ ...draft, game_format: gameFormat, capacity }));
    setGroupProposal((proposal) => proposal ? { ...proposal, game_format: gameFormat, capacity } : proposal);
  }

  async function createGroup() {
    const fail = (message: string) => {
      setCreateGroupError(message);
      setToast(message);
    };
    if (!user) {
      fail("Sign in with Google before creating a game");
      return;
    }
    setCreateGroupError("");
    const today = localDateInput();
    if (!createGroupDraft.session_date || createGroupDraft.session_date < today) {
      fail("Choose today or a future game date.");
      return;
    }
    if (!createGroupDraft.start_time || !createGroupDraft.end_time) {
      fail("Choose the start and end time for the game.");
      return;
    }
    if (createGroupDraft.end_time <= createGroupDraft.start_time) {
      fail("End time must be after start time.");
      return;
    }
    const windowMinutes = (Number(createGroupDraft.end_time.slice(0, 2)) * 60 + Number(createGroupDraft.end_time.slice(3, 5))) - (Number(createGroupDraft.start_time.slice(0, 2)) * 60 + Number(createGroupDraft.start_time.slice(3, 5)));
    if (windowMinutes < 60) {
      fail("Choose a game window of at least one hour.");
      return;
    }
    if (createGroupDraft.session_date === today && createGroupDraft.start_time <= localTimeInput()) {
      fail("Choose a future start time, or select tomorrow.");
      return;
    }
    setCreateGroupLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: createQuery || query || `Create a ${sportLabel(createGroupDraft.sport)} game near ${createGroupDraft.area || "Whitefield"}`,
          sport: createGroupDraft.sport,
          group_name: groupNameDraft.trim() || undefined,
          area: createGroupDraft.area.trim() || undefined,
          session_date: createGroupDraft.session_date || undefined,
          start_time: createGroupDraft.start_time || undefined,
          end_time: createGroupDraft.end_time || undefined,
          skill_min: Number(createGroupDraft.skill_min),
          skill_max: Number(createGroupDraft.skill_max),
          style: createGroupDraft.style,
          rating_mode: createGroupDraft.rating_mode,
          game_format: createGroupDraft.game_format,
          capacity: createGroupDraft.game_format === "singles" ? 2 : createGroupDraft.capacity,
          visibility: createGameVisibility,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { session?: Omit<Session, "open_slots" | "score" | "explanation">; message?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Unable to create the game");
      if (!payload.session) throw new Error("The game was created, but the response was incomplete. Please refresh Games.");
      const createdSession: Session = {
        ...payload.session,
        open_slots: payload.session.capacity - payload.session.confirmed_player_ids.length,
        score: 1,
        explanation: `You are the organizer. CourtMate can now invite nearby players in the same ${sportLabel(createGroupDraft.sport)} skill band.`,
      };
      const createdGroup: ActivityGroup = {
        ...createdSession,
        status: createdSession.status ?? "open",
      };
      setMyGroups((groups) => {
        if (groups.some((group) => group.id === createdGroup.id)) return groups;
        return [...groups, createdGroup].sort((left, right) =>
          `${left.session_date} ${left.start_time}`.localeCompare(`${right.session_date} ${right.start_time}`),
        );
      });
      setSessions([]);
      setGroupProposal(null);
      closeCreateGameForm();
      setShowCraftedGame(false);
      setCreationStep("confirm");
      setManagedGroupId(createdSession.id);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-created-assistant`, role: "assistant", text: `${createdSession.group_name} is live. Head over to the Games tab to see it and manage requests.` }]);
      invalidateLiveState(["activity", "notifications", "social-profile", "feed"]);
      setToast(payload.message ?? "Game created. Compatible nearby players have been notified.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not create the game. Please try again.");
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
      if (feedbackSessionId) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) {
          void postHomeFeedback(transcript);
        }
        return;
      }
      if (scoreSessionId) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) {
          void postHomeScore(transcript);
        }
        return;
      }
      if (scorePickerOpen) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean) && filterScoreGames(transcript)) return;
        return;
      }
      if (feedbackPickerOpen) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean) && analyzeFeedbackForSport(transcript)) return;
        return;
      }
      if (groupProposal) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) {
          void handleCreationReply(transcript);
        }
        return;
      }
      if (/(?:\bsubmit\b|\bleave\b|\bsave\b).*\bfeedback\b/i.test(transcript) || /\brate\b.*\b(?:player|players|lineup|game|match)\b/i.test(transcript)) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) startFeedbackEntry();
        return;
      }
      const detectedSport = sportFromText(transcript);
      if (detectedSport) selectDetectedSport(detectedSport);
      if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) {
        void search(undefined, transcript);
      }
    };
    recognition.start();
  }

  async function joinSession(
    sessionId: string,
    name: string,
    organizerId?: string,
    redirectToPending = true,
    sessionCandidate?: ActivityGroup | Session | NearbyGame,
  ) {
    if (joiningSessionId) return;
    if ((organizerId ?? sessions.find((session) => session.id === sessionId)?.organizer_id) === user?.uid) {
      setToast("You created this group");
      window.setTimeout(() => setToast(""), 2600);
      return;
    }
    try {
      setJoiningSessionId(sessionId);
      setLastChatRequest(null);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/join`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as JoinRequest & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Unable to join");
      if (!payload.status) throw new Error("The join request response was incomplete");
      setLastChatRequest({ name, status: payload.status });

      const foundSession = sessions.find((session) => session.id === sessionId);
      const resolvedSession: ActivityGroup | null = foundSession
        ? { ...foundSession, status: foundSession.status ?? "open" }
        : sessionCandidate
        ? {
            id: sessionCandidate.id,
            organizer_id: "organizer_id" in sessionCandidate ? sessionCandidate.organizer_id : "",
            group_name: sessionCandidate.group_name,
            sport: sessionCandidate.sport,
            area: sessionCandidate.area,
            venue_name: "venue_name" in sessionCandidate ? sessionCandidate.venue_name : null,
            session_date: sessionCandidate.session_date,
            start_time: sessionCandidate.start_time,
            end_time: sessionCandidate.end_time,
            skill_min: "skill_min" in sessionCandidate ? sessionCandidate.skill_min : 1,
            skill_max: "skill_max" in sessionCandidate ? sessionCandidate.skill_max : 100,
            style: "style" in sessionCandidate ? sessionCandidate.style : "casual",
            capacity: "capacity" in sessionCandidate ? sessionCandidate.capacity : 4,
            confirmed_player_ids: "confirmed_player_ids" in sessionCandidate ? sessionCandidate.confirmed_player_ids : [],
            status: "open",
          }
        : null;

      if (resolvedSession) {
        if (payload.status === "approved") {
          setApprovedGames((games) => games.some((game) => game.id === sessionId) ? games : [resolvedSession, ...games]);
        } else {
          setMyRequests((requests) =>
            requests.some(({ request }) => request.id === payload.id || request.session_id === sessionId)
              ? requests
              : [{ request: payload, session: resolvedSession }, ...requests],
          );
        }
      }
      setSessions((currentSessions) => currentSessions.filter((session) => session.id !== sessionId));
      setViewedGroup(null);

      if (redirectToPending && payload.status !== "approved") {
        setJustRequestedSessionId(sessionId);
        setActiveTab("games");
        setGamesViewTab("pending");
        window.setTimeout(() => {
          setJustRequestedSessionId((current) => (current === sessionId ? null : current));
        }, 7000);
      }

      const statusMessage =
        payload.status === "approved"
          ? `You joined ${name}. The game is now in Games → Upcoming.`
          : payload.status === "waitlisted"
          ? `You are on the waitlist for ${name}. I’ve saved your place and you can track it in Games → Pending.`
          : `Request sent to ${name}. The organizer needs to approve you. You can track it in Games → Pending.`;
      setChatMessages((messages) => [
        ...messages.slice(-8),
        { id: `${Date.now()}-join-confirmation`, role: "assistant", text: statusMessage },
      ]);
      setActiveTab("games");
      setGamesViewTab(payload.status === "approved" ? "upcoming" : "pending");
      setToast(payload.status === "approved" ? `Joined ${name} · Added to Upcoming` : payload.status === "waitlisted" ? `Waitlisted for ${name} · Track in Pending` : `Requested ${name} · Landed in Pending Games`);
      void loadGamesActivity(user, false, false, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not request to join ${name}`;
      setChatMessages((messages) => [
        ...messages.slice(-8),
        { id: `${Date.now()}-join-error`, role: "assistant", text: `I could not send the request for ${name}: ${message}` },
      ]);
      setToast(message);
    } finally {
      setJoiningSessionId(null);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function leaveGame(sessionId: string, name: string, requestId?: string) {
    if (leavingGameId) return;
    const requestsBeforeLeave = myRequests;
    const approvedGamesBeforeLeave = approvedGames;
    const workspaceBeforeLeave = workspaceGroup;
    setLeavingGameId(sessionId);
    if (requestId) {
      setMyRequests((requests) => requests.filter(({ request }) => request.id !== requestId));
      setToast(`Request withdrawn from ${name}`);
    } else {
      setApprovedGames((games) => games.filter((game) => game.id !== sessionId));
      if (workspaceGroup?.id === sessionId) setWorkspaceGroup(null);
      setToast(`You backed out of ${name}`);
    }
    try {
      const endpoint = requestId
        ? `${apiUrl}/v1/me/requests/${encodeURIComponent(requestId)}/withdraw`
        : `${apiUrl}/v1/sessions/${sessionId}/leave`;
      const response = await authorizedFetch(endpoint, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { detail?: string; status?: JoinRequest["status"] };
      if (!response.ok) throw new Error(payload.detail ?? "Unable to leave");
      setWorkspaceGroup(null);
      void loadGamesActivity(user, false, false, true);
    } catch (error) {
      if (requestId) {
        setMyRequests(requestsBeforeLeave);
      } else {
        setApprovedGames(approvedGamesBeforeLeave);
        setWorkspaceGroup(workspaceBeforeLeave);
      }
      setToast(error instanceof Error ? error.message : `Could not back out of ${name}`);
    } finally {
      setLeavingGameId(null);
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
      invalidateSocialFeedCache();
      await loadGamesActivity(user, false, true, true);
      void loadSocialProfile();
      setToast(`${name} is now closed. Players can still leave feedback.`);
    } catch {
      setToast(`Could not close ${name}`);
    } finally {
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function showGroupPreview(group: GroupView, sessionId: string) {
    setViewedGroup(group);
    if (window.location.hash !== `#group-preview-${sessionId}`) window.history.pushState({ courtMatePage: "group-preview" }, "", `#group-preview-${sessionId}`);
  }

  async function viewGroup(sessionId: string, authUser: User | null = user) {
    setLoadingGroupId(sessionId);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/group`, {}, authUser);
      if (!response.ok) {
        if (response.status === 401) throw new Error("Your sign-in session expired. Sign in again.");
        if (response.status === 404) throw new Error("This group no longer exists.");
        throw new Error(`Group request failed (${response.status})`);
      }
      showGroupPreview(await response.json() as GroupView, sessionId);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not load this group");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setLoadingGroupId(null);
    }
  }

  async function openSharedGame(sessionId: string, authUser: User | null = user) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/group`, {}, authUser);
      if (!response.ok) {
        await viewGroup(sessionId, authUser);
        return;
      }
      const group = await response.json() as GroupView;
      if (group.session.confirmed_player_ids.includes(authUser?.uid ?? "")) {
        await openGroupSpace(group.session, authUser, group);
      } else {
        showGroupPreview(group, sessionId);
      }
    } catch {
      await viewGroup(sessionId, authUser);
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
      time_window_start: group.time_window_start,
      time_window_end: group.time_window_end,
      duration_minutes: group.duration_minutes,
      time_finalized: group.time_finalized,
      skill_min: group.skill_min,
      skill_max: group.skill_max,
      style: group.style,
      rating_mode: group.rating_mode,
      game_format: group.game_format,
      capacity: group.capacity,
      confirmed_player_ids: group.confirmed_player_ids,
      waitlist_player_ids: group.waitlist_player_ids ?? [],
      checked_in_player_ids: group.checked_in_player_ids ?? [],
      external_booking_url: group.external_booking_url,
      status: "status" in group && group.status ? group.status : "open",
    };
  }

  async function openGroupSpace(group: ActivityGroup | Session, authUser: User | null = user, prefetchedGroup?: GroupView) {
    const normalizedGroup = toActivityGroup(group);
    const requestId = ++groupSpaceRequestRef.current;
    const cached = groupSpaceCacheRef.current.get(normalizedGroup.id);
    setWorkspaceGroup(normalizedGroup);
    if (window.location.hash !== `#group-space-${normalizedGroup.id}`) window.history.pushState({ courtMatePage: "group-space" }, "", `#group-space-${normalizedGroup.id}`);
    // Render the shell and any stale data immediately. Network refreshes should
    // never block the user from seeing or using the group space.
    const initial = prefetchedGroup
      ? { group: toActivityGroup(prefetchedGroup.session), members: prefetchedGroup.members, waitlist: prefetchedGroup.waitlist ?? [], posts: cached?.posts ?? [] }
      : cached;
    const initialMemberIds = new Set(initial?.members.map((member) => member.id) ?? []);
    const initialWaitlistIds = new Set(initial?.waitlist.map((member) => member.id) ?? []);
    const hasCompleteInitialSnapshot = Boolean(initial
      && initial.group.confirmed_player_ids.every((playerId) => initialMemberIds.has(playerId))
      && (initial.group.waitlist_player_ids ?? []).every((playerId) => initialWaitlistIds.has(playerId)));
    if (hasCompleteInitialSnapshot && initial) {
      setWorkspaceGroup(initial.group);
      setGroupMembers(initial.members);
      setGroupWaitlist(initial.waitlist);
      setChatPosts(initial.posts);
    } else {
      setGroupMembers([]);
      setGroupWaitlist([]);
      setChatPosts([]);
    }
    setWorkspaceLoading(!hasCompleteInitialSnapshot);
    setChatDraft("");
    setPlayerRatings({});
    try {
      const chatPromise = authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/chat`, {}, authUser);
      const membersPromise = authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/group`, {}, authUser);
      const [chatResponse, membersResponse] = await Promise.all([chatPromise, membersPromise]);
      if (!chatResponse.ok || !membersResponse.ok) {
        if (chatResponse.status === 403 || membersResponse.status === 403) throw new Error("Only confirmed players can open this Rally Circle");
        throw new Error("Rally Circle unavailable");
      }
      const chatPayload = await chatResponse.json() as { posts: ChatPost[] };
      const membersPayload = await membersResponse.json() as GroupView;
      const nextEntry: GroupSpaceCacheEntry = {
        cachedAt: Date.now(),
        group: toActivityGroup(membersPayload.session),
        members: membersPayload.members,
        waitlist: membersPayload.waitlist ?? [],
        posts: chatPayload.posts,
      };
      groupSpaceCacheRef.current.set(normalizedGroup.id, nextEntry);
      if (requestId === groupSpaceRequestRef.current) {
        setWorkspaceGroup(nextEntry.group);
        setChatPosts(nextEntry.posts);
        setGroupMembers(nextEntry.members);
        setGroupWaitlist(nextEntry.waitlist);
        setWorkspaceLoading(false);
      }
    } catch (error) {
      if (requestId === groupSpaceRequestRef.current) {
        setWorkspaceLoading(false);
        if (!hasCompleteInitialSnapshot) setWorkspaceGroup(null);
      }
      setToast(error instanceof Error ? error.message : "Could not open this Rally Circle");
    }
  }

  function openPendingFeedback(group: ActivityGroup | Session) {
    setPendingFeedbackSessionId(group.id);
    void openGroupSpace(group);
  }

  async function markGroupDone(sessionId: string): Promise<boolean> {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/complete`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as Session & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not mark this game done");
      setWorkspaceGroup(toActivityGroup(payload));
      setPendingFeedbackSessionId(sessionId);
      groupSpaceCacheRef.current.delete(sessionId);
      invalidateSocialFeedCache();
      setToast("Game marked completed. Feedback and player ratings are now open.");
      void loadGamesActivity(user, false, false, true);
      void loadSocialProfile();
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not mark this game done");
      return false;
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

  async function openRanking(game: ActivityGroup | Session) {
    const normalizedGame = toActivityGroup(game);
    setRankingGame(normalizedGame);
    setRankingLoading(true);
    setRankingEntries([]);
    setLocalRankingEntries([]);
    if (window.location.hash !== `#ranking-${normalizedGame.id}`) window.history.pushState({ courtMatePage: "ranking" }, "", `#ranking-${normalizedGame.id}`);
    try {
      const [groupResponse, localResponse] = await Promise.all([
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGame.id}/leaderboard`),
        authorizedFetch(`${apiUrl}/v1/leaderboards/local?area=${encodeURIComponent(normalizedGame.area)}&sport=${encodeURIComponent(normalizedGame.sport)}`),
      ]);
      if (!groupResponse.ok || !localResponse.ok) throw new Error("Rankings unavailable");
      const groupPayload = await groupResponse.json() as { entries: LeaderboardEntry[] };
      const localPayload = await localResponse.json() as { entries: LeaderboardEntry[] };
      setRankingEntries(groupPayload.entries);
      setLocalRankingEntries(localPayload.entries);
    } catch {
      setToast("Could not load rankings");
    } finally {
      setRankingLoading(false);
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
      invalidateLiveState(["activity", "profile", "social-profile", "feed", "notifications"]);
      await openGroupSpace(workspaceGroup);
    } catch {
      setToast("Could not save your post-game feedback");
    }
  }

  async function loadJoinRequests(groupId: string | null = managedGroupId, notify = true) {
    if (!groupId) return;
    setRequestsLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${groupId}/join-requests`);
      if (!response.ok) throw new Error("Requests unavailable");
      const payload = await response.json() as { requests: JoinRequest[] };
      setJoinRequests(payload.requests);
      if (notify) setToast(`${payload.requests.length} join request(s) loaded`);
    } catch {
      setToast("Only the group organizer can view these requests");
    } finally {
      setRequestsLoading(false);
      if (notify) window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function loadGamesActivity(
    authUser: User | null = user,
    showLoader = true,
    notifyError = true,
    force = false,
  ) {
    if (!authUser) return;
    const loadVersion = ++activityLoadVersionRef.current;
    let cachedSnapshot: ActivitySnapshot | null = null;
    let cachedAt = 0;
    if (!force) {
      try {
        const raw = window.sessionStorage.getItem(activityCacheKey(authUser.uid));
        const parsed = raw ? JSON.parse(raw) as { cachedAt?: number; snapshot?: ActivitySnapshot } : null;
        if (parsed?.cachedAt && parsed.snapshot) {
          cachedAt = parsed.cachedAt;
          cachedSnapshot = parsed.snapshot;
          setMyRequests(parsed.snapshot.requests ?? []);
          setIncomingRequests(parsed.snapshot.incoming_requests ?? []);
          setMyGroups(parsed.snapshot.groups ?? []);
          setApprovedGames(parsed.snapshot.games ?? []);
          setAwaitingFeedbackGames(parsed.snapshot.awaiting_feedback ?? []);
          setPastGames((parsed.snapshot.past_games ?? []).filter((game) => game.session.status === "completed"));
        }
      } catch {
        // A disabled or invalid session cache should never block Games.
      }
    } else {
      try {
        window.sessionStorage.removeItem(activityCacheKey(authUser.uid));
      } catch {
        // A disabled session storage should not affect activity refreshes.
      }
    }
    const hasCachedActivity = Boolean(cachedSnapshot || myRequests.length || incomingRequests.length || myGroups.length || approvedGames.length || pastGames.length);
    const shouldShowLoader = showLoader && !hasCachedActivity;
    if (shouldShowLoader) setActivityLoading(true);
    if (cachedSnapshot && Date.now() - cachedAt < ACTIVITY_CACHE_TTL_MS && !force) {
      setActivityLoading(false);
      return;
    }
    try {
      if (force) activityRequestRef.current = null;
      let request = activityRequestRef.current;
      if (!request) {
        request = authorizedFetch(`${apiUrl}/v1/me/activity${force ? "?refresh=1" : ""}`, {}, authUser)
          .then(async (response) => {
            if (!response.ok) throw new Error("Activity unavailable");
            return response.json() as Promise<ActivitySnapshot>;
          })
          .finally(() => {
            activityRequestRef.current = null;
          });
        activityRequestRef.current = request;
      }
      const payload = await request;
      if (loadVersion !== activityLoadVersionRef.current) return;
      const nextRequests = payload.requests ?? [];
      const nextIncomingRequests = payload.incoming_requests ?? [];
      const nextGroups = payload.groups ?? [];
      const nextGames = payload.games ?? [];
      const nextAwaitingFeedback = payload.awaiting_feedback ?? [];
      const nextPastGames = (payload.past_games ?? []).filter((game) => game.session.status === "completed");
      setMyRequests((current) => hasStateChanged(current, nextRequests) ? nextRequests : current);
      setIncomingRequests((current) => hasStateChanged(current, nextIncomingRequests) ? nextIncomingRequests : current);
      setMyGroups((current) => hasStateChanged(current, nextGroups) ? nextGroups : current);
      setApprovedGames((current) => hasStateChanged(current, nextGames) ? nextGames : current);
      setAwaitingFeedbackGames((current) => hasStateChanged(current, nextAwaitingFeedback) ? nextAwaitingFeedback : current);
      setPastGames((current) => hasStateChanged(current, nextPastGames) ? nextPastGames : current);
      try {
        window.sessionStorage.setItem(activityCacheKey(authUser.uid), JSON.stringify({ cachedAt: Date.now(), snapshot: payload }));
      } catch {
        // A full or disabled session storage should not affect activity refreshes.
      }
    } catch {
      if (notifyError) setToast("Could not load your CourtMate activity");
    } finally {
      if (shouldShowLoader) setActivityLoading(false);
    }
  }

  async function loadExploreGames(authUser: User | null = user, force = false) {
    if (!authUser) return;
    if (!force && exploreGames.length) return;
    setExploreLoading(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/explore`, {}, authUser);
      if (!response.ok) throw new Error("Explore unavailable");
      const payload = await response.json() as { recommendations: { session: Omit<Session, "open_slots" | "score" | "explanation">; score: number; reasons: { explanation: string } }[] };
      setExploreGames(payload.recommendations.map((item) => ({
        ...item.session,
        open_slots: Math.max(item.session.capacity - item.session.confirmed_player_ids.length, 0),
        score: item.score,
        explanation: item.reasons.explanation,
      })));
    } catch {
      setToast("Could not load nearby games");
    } finally {
      setExploreLoading(false);
    }
  }

  function addToGoogleCalendar(game: ActivityGroup) {
    if (game.time_finalized === false) {
      setToast("Vote on a time in the Rally Circle before adding this game to your calendar");
      return;
    }
    const compactDate = game.session_date.replaceAll("-", "");
    const compactTime = (value: string) => value.replace(/[^0-9]/g, "").padEnd(6, "0").slice(0, 6);
    const start = `${compactDate}T${compactTime(game.start_time)}`;
    const end = `${compactDate}T${compactTime(game.end_time)}`;
    const calendarUrl = new URL("https://calendar.google.com/calendar/render");
    calendarUrl.searchParams.set("action", "TEMPLATE");
    calendarUrl.searchParams.set("text", `${sportLabel(game.sport)} · ${game.group_name}`);
    calendarUrl.searchParams.set("dates", `${start}/${end}`);
    calendarUrl.searchParams.set("ctz", "Asia/Kolkata");
    calendarUrl.searchParams.set(
      "details",
      `CourtMate game\n\nOpen the Rally Circle: ${getGroupSpaceUrl(game)}`,
    );
    calendarUrl.searchParams.set("location", `${game.venue_name ? `${game.venue_name}, ` : ""}${game.area}, Bengaluru`);
    window.open(calendarUrl.toString(), "_blank", "noopener,noreferrer");
  }

  function getGroupSpaceUrl(game: Pick<ShareableGame, "id">) {
    const shareUrl = new URL("/home", window.location.origin);
    shareUrl.searchParams.set("rally-circle", game.id);
    return shareUrl.toString();
  }

  async function copyText(text: string) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    fallback.setSelectionRange(0, fallback.value.length);
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }

  function invalidateSocialFeedCache() {
    if (!user) return;
    try {
      window.sessionStorage.removeItem(`courtmate:social-feed:${user.uid}:all`);
      window.sessionStorage.removeItem(`courtmate:social-feed:${user.uid}:following`);
      window.sessionStorage.removeItem(`courtmate:social-feed:${user.uid}:personal`);
    } catch {
      // The next feed request will still refresh from the API when storage is unavailable.
    }
  }

  function invalidateLiveState(keys: LiveStateKey[]) {
    if (!user) return;
    if (keys.includes("activity")) {
      try { window.sessionStorage.removeItem(activityCacheKey(user.uid)); } catch { /* Storage is optional. */ }
    }
    if (keys.includes("social-profile")) {
      try { window.sessionStorage.removeItem(socialProfileCacheKey(user.uid)); } catch { /* Storage is optional. */ }
    }
    if (keys.includes("feed") || keys.includes("recommendations")) invalidateSocialFeedCache();
    void refreshLiveStateFor(keys);
  }

  async function copyGroupSpaceLink(game: Pick<ShareableGame, "id">) {
    try {
      await copyText(getGroupSpaceUrl(game));
      setToast("Rally Circle link copied");
    } catch {
      setToast("Could not copy the Rally Circle link");
    }
    window.setTimeout(() => setToast(""), 2600);
  }

  async function shareGame(game: ShareableGame) {
    const dateLabel = new Date(`${game.session_date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
    const location = game.venue_name ? `${game.venue_name}, ${game.area}` : game.area;
    const groupSpaceUrl = getGroupSpaceUrl(game);
    const sportEmoji: Record<Sport, string> = { pickleball: "🏓", badminton: "🏸", tennis: "🎾", padel: "🎾", squash: "🎾", table_tennis: "🏓" };
    const title = `${sportEmoji[game.sport]} Join me for ${game.group_name}`;
    const message = `${sportEmoji[game.sport]} ${sportLabel(game.sport)} · 📅 ${dateLabel} · ⏰ ${game.start_time}–${game.end_time}\n📍 ${location}\n\n🔗 Open the CourtMate Rally Circle: ${groupSpaceUrl}`;
    try {
      if (isDesktopShareView()) {
        await copyText(groupSpaceUrl);
        setToast("Copied link to clipboard");
        return;
      }
      if (navigator.share) {
        await navigator.share({ title, text: message });
        setToast("Game details shared");
      } else {
        await copyText(`${title}\n${message}`);
        setToast("Game details copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await copyText(`${title}\n${message}`);
        setToast("Game details copied");
      } catch {
        setToast("Could not share game details");
      }
    }
    window.setTimeout(() => setToast(""), 2600);
  }

  async function shareProfile(playerId: string, displayName: string, isPrivate = false) {
    const profileUrl = new URL("/home", window.location.origin);
    profileUrl.hash = `player-profile-${playerId}`;
    const title = `${displayName} on CourtMate`;
    const text = isPrivate
      ? `View ${displayName}'s private CourtMate profile.`
      : `See ${displayName}'s racket-sport profile and CMR on CourtMate.`;
    try {
      if (isDesktopShareView()) {
        await copyText(profileUrl.toString());
        showToast("Copied link to clipboard");
        return;
      }
      if (navigator.share) {
        await navigator.share({ title, text, url: profileUrl.toString() });
        showToast("Profile shared");
      } else {
        await copyText(profileUrl.toString());
        showToast("Profile link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await copyText(profileUrl.toString());
        showToast("Profile link copied");
      } catch {
        showToast("Could not share this profile");
      }
    }
  }

  async function decideJoinRequest(requestId: string, status: "approved" | "declined", groupId: string | null = managedGroupId): Promise<JoinRequest | null> {
    if (!groupId || decidingRequestId) return null;
    try {
      setDecidingRequestId(requestId);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${groupId}/join-requests/${requestId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => ({})) as JoinRequest & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Decision failed");
      setJoinRequests((requests) => requests.map((request) => request.id === requestId ? { ...request, status: payload.status } : request));
      setIncomingRequests((requests) => requests.filter(({ request }) => request.id !== requestId));
      if (payload.status === "approved") {
        const addPlayer = (game: ActivityGroup) => game.id === groupId && !game.confirmed_player_ids.includes(payload.player_id)
          ? { ...game, confirmed_player_ids: [...game.confirmed_player_ids, payload.player_id] }
          : game;
        setMyGroups((groups) => groups.map(addPlayer));
        setApprovedGames((games) => games.map(addPlayer));
        setViewedGroup((group) => group?.session.id === groupId && !group.session.confirmed_player_ids.includes(payload.player_id)
          ? { ...group, session: { ...group.session, confirmed_player_ids: [...group.session.confirmed_player_ids, payload.player_id] } }
          : group);
      }
      if (groupId === managedGroupId) void loadJoinRequests(groupId, false);
      void loadGamesActivity(user, false, true, true);
      setToast(payload.status === "approved" ? "Player approved for the group" : payload.status === "waitlisted" ? "Group is full. Player added to the waitlist" : "Request declined");
      return payload;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not update this join request");
      return null;
    } finally {
      setDecidingRequestId(null);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function selectTab(tab: AppTab) {
    if (!user && tab !== "home") {
      setActiveTab("home");
      setViewedGroup(null);
      return;
    }
    if (tab === "communities") {
      setGamesViewTab("explore");
      tab = "games";
    }
    setActiveTab(tab);
    setSettingsOpen(false);
    setNotificationsOpen(false);
    setCalendarOpen(false);
    setCmrDetailsOpen(false);
    setConnectionsOpen(false);
    setWorkspaceGroup(null);
    setPendingFeedbackSessionId(null);
    setPendingShareSessionId(null);
    setRankingGame(null);
    setViewedGroup(null);
    if (["#settings", "#notifications", "#profile-calendar", "#connections"].includes(window.location.hash)
      || window.location.hash.startsWith("#group-space-")
      || window.location.hash.startsWith("#group-preview-")
      || window.location.hash.startsWith("#ranking-")) {
      window.history.replaceState({ courtMatePage: tab }, "", `${window.location.pathname}${window.location.search}`);
    }
    if (tab === "profile") {
      setProfileReturnTab("profile");
      setViewedProfile(null);
      if (!socialProfile) void loadSocialProfile();
      if (window.location.hash.startsWith("#player-profile-")) {
        window.history.replaceState({ courtMatePage: "profile" }, "", `${window.location.pathname}${window.location.search}`);
      }
    } else if (viewedProfile) {
      setViewedProfile(null);
      if (window.location.hash.startsWith("#player-profile-")) {
        window.history.replaceState({ courtMatePage: tab }, "", `${window.location.pathname}${window.location.search}`);
      }
    }
    if (tab === "home" && user) setQuery("");
    if (tab === "games") {
      void loadGamesActivity();
    }
  }

  function openSettings() {
    if (!user) {
      void signIn();
      return;
    }
    window.history.pushState({ courtMatePage: "settings" }, "", "#settings");
    setSettingsOpen(true);
    setNotificationsOpen(false);
    setCalendarOpen(false);
    setConnectionsOpen(false);
    setViewedGroup(null);
    setViewedProfile(null);
  }

  function openNotifications() {
    if (!user) {
      void signIn();
      return;
    }
    window.history.pushState({ courtMatePage: "notifications" }, "", "#notifications");
    setNotificationsOpen(true);
    setSettingsOpen(false);
    setCalendarOpen(false);
    setConnectionsOpen(false);
    setViewedGroup(null);
    setViewedProfile(null);
    void (async () => {
      const loaded = await loadNotifications();
      if (loaded) await markAllNotificationsRead();
    })();
  }

  function closeUtilityPage() {
    if (window.location.hash) {
      window.history.back();
      return;
    }
    setSettingsOpen(false);
    setNotificationsOpen(false);
    setCalendarOpen(false);
    setCmrDetailsOpen(false);
    setConnectionsOpen(false);
    setWorkspaceGroup(null);
    setRankingGame(null);
    setViewedGroup(null);
    setViewedProfile(null);
  }

  function openCmrDetails() {
    setCmrDetailsOpen(true);
    setActiveTab("profile");
    setViewedProfile(null);
  }

  function openProfileCalendar() {
    window.history.pushState({ courtMatePage: "profile-calendar" }, "", "#profile-calendar");
    setCalendarOpen(true);
    setSettingsOpen(false);
    setNotificationsOpen(false);
    setConnectionsOpen(false);
    setViewedGroup(null);
    setViewedProfile(null);
  }

  function openConnections(tab: ConnectionsTab) {
    setConnectionsTab(tab);
    window.history.pushState({ courtMatePage: "connections" }, "", "#connections");
    setConnectionsOpen(true);
    setSettingsOpen(false);
    setNotificationsOpen(false);
    setCalendarOpen(false);
    setViewedGroup(null);
    setViewedProfile(null);
  }

  function openCircleLeaderboard() {
    const preferredSport = profileStatsSport ?? activeSports[0]?.value ?? "pickleball";
    setCircleLeaderboardSport(preferredSport);
    setCircleLeaderboardScope("circle");
    selectTab("leaderboard");
  }

  const requestedGames = myRequests.filter(({ request }) => request.status === "pending" || request.status === "waitlisted");
  const isSessionRequested = (sessionId: string) =>
    sessionId === justRequestedSessionId || requestedGames.some(({ request }) => request.session_id === sessionId);
  const today = new Date().toISOString().slice(0, 10);
  const upcomingGames = Array.from(new Map([...approvedGames, ...myGroups.filter((group) => group.session_date >= today && group.status !== "awaiting_feedback" && group.status !== "completed" && group.status !== "cancelled")].map((game) => [game.id, game])).values()).sort((a, b) => `${a.session_date} ${a.start_time}`.localeCompare(`${b.session_date} ${b.start_time}`));
  const filteredExploreGames = exploreGames.filter((game) => {
    const searchTerms = exploreSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const searchableGame = `${game.group_name} ${game.area} ${sportLabel(game.sport)} ${game.style} ${game.session_date} ${game.start_time} ${game.end_time} ${game.venue_name ?? ""}`.toLowerCase();
    if (searchTerms.some((term) => !searchableGame.includes(term))) return false;
    if (exploreSportApplied !== "all" && game.sport !== exploreSportApplied) return false;
    if (exploreDateApplied && game.session_date !== exploreDateApplied) return false;
    if (exploreTimeApplied !== "all" && exploreTimeOfDay(game.start_time) !== exploreTimeApplied) return false;
    if (exploreCmrApplied !== "all") {
      const [cmrMin, cmrMax] = exploreCmrRanges[exploreCmrApplied];
      const gameCmrMin = cmrFromSkillBand(game.skill_min);
      const gameCmrMax = cmrFromSkillBand(game.skill_max);
      if (gameCmrMax < cmrMin || gameCmrMin > cmrMax) return false;
    }
    return true;
  });
  const applyExploreFilters = () => {
    setExploreSearch(exploreSearchDraft.trim());
    setExploreSportApplied(exploreSportFilter);
    setExploreDateApplied(exploreDateFilter);
    setExploreCmrApplied(exploreCmrFilter);
    setExploreTimeApplied(exploreTimeFilter);
  };
  const openGamesExplore = () => {
    setGamesViewTab("explore");
    void loadExploreGames();
  };
  const activeSports = sportOptions.filter((sport) => profile?.cmr_ratings?.[sport.value] != null || (profile?.cmr_game_counts?.[sport.value] ?? 0) > 0);
  const ratedSports = activeSports.filter((sport) => profile?.cmr_ratings?.[sport.value] != null);
  const mostPlayedSport = [...activeSports].sort((left, right) => (profile?.cmr_game_counts?.[right.value] ?? 0) - (profile?.cmr_game_counts?.[left.value] ?? 0))[0]?.value;
  const profileSelectedSport = profileSport && activeSports.some((sport) => sport.value === profileSport) ? profileSport : mostPlayedSport ?? "pickleball";
  const profileViewLabel = profileStatsSport ? sportLabel(profileStatsSport) : "All sports";
  const profileHistory = profileStatsSport
    ? profile?.cmr_history?.[profileStatsSport] ?? []
    : Object.entries(profile?.cmr_history ?? {}).flatMap(([sport, history]) => history.map((point) => ({ ...point, sport }))).sort((left, right) => left.session_date.localeCompare(right.session_date));
  const ratedProfileHistory = profileHistory.filter((point) => point.rating != null);
  const sportRatingEntries = Object.entries(profile?.cmr_ratings ?? {}).filter(([, rating]) => typeof rating === "number");
  const totalRatedGames = sportRatingEntries.reduce((total, [sport]) => total + (profile?.cmr_game_counts?.[sport] ?? 0), 0);
  const weightedRatingTotal = sportRatingEntries.reduce((total, [sport, rating]) => total + rating * (profile?.cmr_game_counts?.[sport] ?? 1), 0);
  const currentCmr = profileStatsSport ? profile?.cmr_ratings?.[profileStatsSport] : totalRatedGames ? weightedRatingTotal / totalRatedGames : undefined;
  const currentCmrGames = profileStatsSport ? profile?.cmr_game_counts?.[profileStatsSport] ?? 0 : totalGamesFor(profile ?? {});
  const currentCmrVerified = currentCmrGames >= CMR_VERIFICATION_GAME_THRESHOLD;
  const totalGames = profile ? totalGamesFor(profile) : 0;
  const visibleScoreGames = scoreableGames().filter((game) => !scorePickerSport || game.sport === scorePickerSport);
  const unreadNotifications = notifications.filter((notification) => !notification.read).length;
  const createCmrMin = cmrFromSkillBand(Number(createGroupDraft.skill_min));
  const createCmrMax = cmrFromSkillBand(Number(createGroupDraft.skill_max));

  function showToast(message: string) {
    setToast(message);
  }

  function setToast(message: string) {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState(message);
    if (message) {
      toastTimerRef.current = window.setTimeout(() => {
        setToastState("");
        toastTimerRef.current = null;
      }, 2600);
    }
  }

  return (
    <main className={`shell ${settingsOpen || notificationsOpen || calendarOpen || connectionsOpen || cmrDetailsOpen ? "utility-page-open" : ""} ${workspaceGroup || viewedGroup ? "detail-page-open" : ""} ${rankingGame ? "ranking-page-open" : ""}`}>
      <nav className="nav">
        <div className="brand" aria-label="CourtMate"><img className="brand-icon brand-logo-light" src="/courtmate-header-logo-light.png" alt="CourtMate" /><img className="brand-icon brand-logo-dark" src="/courtmate-header-logo-dark.png" alt="" aria-hidden="true" /></div>
        <div className="nav-right"><button className="about-link" onClick={() => { if (!user) document.querySelector(".guest-story")?.scrollIntoView({ behavior: "smooth" }); else selectTab("home"); }}>How it works</button><span className="location-pill"><span className="dot" /> {profile?.area || "Whitefield"}, Bengaluru</span><button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><ThemeIcon dark={theme === "dark"} /></button>{user ? <><div className="notification-wrap">
          <button className={`notification-button ${notificationsOpen ? "active" : ""}`} type="button" onClick={openNotifications} aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`} title="Notifications"><BellIcon />{unreadNotifications > 0 && <span className="notification-count">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
        </div><span className="user-name">{user.displayName ?? user.email}</span><button className="avatar" onClick={() => selectTab("profile")} title="Open profile">{profile?.profile_image_url ? <img src={profile.profile_image_url} alt="" /> : initials(user.displayName ?? user.email ?? "CourtMate")}</button></> : <button className="sign-in-button" onClick={() => void signIn()}>{authReady ? "Sign in with Google" : "Loading auth"}</button>}</div>
      </nav>
      {user && <span className="nav-streak" title={`${socialProfile?.weekly_streak ?? 0} week streak`} aria-label={`${socialProfile?.weekly_streak ?? 0} week streak`}><StreakFireIcon /><b>{socialProfile?.weekly_streak ?? 0}</b></span>}
      {user && <nav className="app-tabs" aria-label="CourtMate sections">
        <button className={activeTab === "social" ? "active" : ""} onClick={() => { setSocialFeedEntry("all"); selectTab("social"); }} title="Home"><span className="app-tab-icon"><HomeIcon /></span><span>Home</span></button>
        <button className={activeTab === "games" ? "active" : ""} onClick={() => selectTab("games")} title="Your games"><span className="app-tab-icon"><PickleballPaddleIcon /></span><span>Games</span></button>
        <button className={activeTab === "home" ? "active" : ""} onClick={() => selectTab("home")} title="Ask CourtMate"><span className="app-tab-icon"><ChatIcon /></span><span>Ask</span></button>
        <button className={activeTab === "leaderboard" ? "active" : ""} onClick={openCircleLeaderboard} title="Leaderboard"><span className="app-tab-icon"><LeaderboardIcon /></span><span>Leaderboard</span></button>
        <button className={activeTab === "profile" ? "active" : ""} onClick={() => selectTab("profile")} title="Profile"><span className="app-tab-icon"><ProfileIcon /></span><span>Profile</span></button>
      </nav>}
      {activeTab === "home" && !user && <>
      <section className="guest-home" aria-label="CourtMate introduction">
        <div className="guest-copy"><span className="eyebrow">BETTER RACKET-SPORT GAMES</span><h1>Find your game.<br /><em>Build your circle.</em></h1><p>Discover, create, and join games matched by sport, area, time, and CMR. Keep the lineup, waitlist, chat, feedback, and game history together.</p><div className="guest-cta"><button className="guest-sign-in" type="button" onClick={() => void signIn()}><GoogleIcon /><span>Continue with Google</span></button><button className="guest-about" type="button" onClick={() => document.querySelector(".guest-map-preview")?.scrollIntoView({ behavior: "smooth" })}>Browse nearby games</button></div><div className="guest-trust"><span>DISCOVER NEARBY</span><span>LIVE LINEUPS</span><span>CMR BY SPORT</span></div></div>
        <section className="guest-map-preview" aria-label="Nearby games preview">
          <CommunityHub
            apiUrl={apiUrl}
            authorizedFetch={discoveryFetch}
            gamesLogged={0}
            isGuest
            onSignIn={() => void signIn()}
            initialArea="Whitefield"
          />
        </section>
        <div className="guest-story" aria-label="How CourtMate works"><div className="guest-story-heading"><span className="eyebrow">FROM SEARCH TO SHARED RALLY</span><h2>Everything around your game, in one place.</h2><p>Find the right session, confirm the lineup, coordinate with players, and keep the completed game in your CourtMate history.</p></div><div className="guest-feature-grid"><article><span>01</span><strong>Find or create</strong><p>Ask for a game by sport, area, time, and level or create one with the focused game form.</p></article><article><span>02</span><strong>Confirm the lineup</strong><p>Share the game, review requests, track capacity, and automatically promote the waitlist after a player leaves.</p></article><article><span>03</span><strong>Play the right level</strong><p>Use sport-specific CMR, locality, play style, and reliability to choose a better-fit game.</p></article><article><span>04</span><strong>Record the rally</strong><p>Complete the game, submit feedback, post photos, and connect with players through the activity feed.</p></article></div><div className="guest-social-proof"><div><b>6</b><span>court sports</span></div><div><b>1</b><span>live Rally Circle</span></div><div><b>∞</b><span>rallies to record</span></div></div></div>
        <section className="guest-cmr-section" aria-labelledby="guest-cmr-title"><div className="guest-cmr-heading"><span className="eyebrow">A RATING THAT TRAVELS WITH YOU</span><h2 id="guest-cmr-title">Meet your CMR.</h2><p>CMR means CourtMate Rating: one evolving skill signal for each racket sport, built from feedback after completed games.</p></div><div className="guest-cmr-steps"><article><strong>01</strong><h3>Play together</h3><p>Join a session at your level and keep the confirmed lineup in one place.</p></article><article><strong>02</strong><h3>Build real evidence</h3><p>Players rate one another after the game. More sessions make the community signal steadier.</p></article><article><strong>03</strong><h3>Find better fits</h3><p>Carry your CMR across groups so organizers and players can match the pace of the game.</p></article></div></section>
        <section className="guest-why-section" aria-labelledby="guest-why-title"><div><span className="eyebrow">WHY COURTMATE</span><h2 id="guest-why-title">Built around every part of the game.</h2></div><div className="guest-why-grid"><article><strong>A clear lineup</strong><p>See confirmed players, open spots, pending requests, and the waitlist in one current view.</p></article><article><strong>Your player identity</strong><p>Your games, CMR, reliability, streak, and connections stay together on your profile.</p></article><article><strong>Your racket-sport feed</strong><p>Post completed games, share photos, react, comment, follow players, and revisit your rallies.</p></article></div></section>
        <footer className="guest-footer" aria-label="Contact CourtMate"><div><span className="eyebrow">CONTACT</span><strong>Keep in touch</strong></div><div className="guest-footer-links"><a href="https://www.instagram.com/courtmate.blr/" target="_blank" rel="noreferrer"><InstagramIcon /><span>Instagram</span></a><a href="mailto:courtmate.blr@gmail.com"><MailIcon /><span>Email us</span></a></div></footer>
      </section>
      </>}
      {activeTab === "home" && user && <>
      <section className={`home-chat-page ${searchScope === "out_of_scope" ? "chat-out-of-scope" : ""} ${groupProposal && !showCraftedGame ? "creation-in-progress" : ""}`} aria-label="CourtMate game concierge">
        <header className="chat-page-header"><div><span className="eyebrow">COURTMATE CONCIERGE</span></div></header>
        <div className="chat-thread" aria-live="polite">
          {!chatMessages.length && !sessions.length && !groupProposal && <div className="chat-message assistant-message welcome-message"><span className="chat-message-mark">CM</span><div><strong>What are you looking for?</strong><p>Try &ldquo;tennis this Saturday at 8 AM near Whitefield, intermediate and social&rdquo;.</p><div className="chat-suggestions"><button type="button" onClick={() => { const prompt = `Find a casual ${selectedSport} game this weekend near ${profile?.area ?? "Whitefield"}`; setQuery(prompt); void search(undefined, prompt); }}>Weekend game</button><button type="button" onClick={() => { const prompt = `Find a ${selectedSport} game this evening near ${profile?.area ?? "Whitefield"}`; setQuery(prompt); void search(undefined, prompt); }}>Play tonight</button></div></div></div>}
          {chatMessages.map((message) => <div className={`chat-message ${message.role}-message`} key={message.id}><span className="chat-message-mark">{message.role === "assistant" ? "CM" : initials(user?.displayName ?? "You")}</span><div>{message.imageUrl && <img className="chat-attachment-preview" src={message.imageUrl} alt="Attached wearable screenshot" />}{message.role === "assistant" ? <AssistantReply text={message.text} /> : <p>{message.text}</p>}</div></div>)}
          {loading && <TennisBallLoader label="Finding your best match" detail={loadingMessage} />}
          {!loading && searchScope === "court_discovery" && sessions.length > 0 && <div className="chat-message assistant-message result-message"><span className="chat-message-mark">CM</span><div className="result-message-body"><p>{`I found ${sessions.length} option${sessions.length === 1 ? "" : "s"}. Pick one to see the group, request a spot, or skip it.`}</p><div className="chat-choice-list">{sessions.map((session, index) => <article className={`session-card chat-choice-card ${index === 0 ? "featured" : ""}`} key={session.id}><div className="card-top"><span className="date-badge"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(session.session_date).getDate()}</small></span><div className="session-meta"><div className="session-title-row"><h3>{session.group_name}</h3><span className="fit-score">{Math.round(session.score * 100)}% fit</span></div><p>{sportLabel(session.sport)} · {session.start_time} – {session.end_time} · {session.area}</p></div></div><div className="tags"><span className="tag rating">{sportLabel(session.sport)} skill {session.skill_min.toFixed(1)}–{session.skill_max.toFixed(1)}</span><span className="tag">{session.style}</span><span className="tag open">{session.open_slots} spots open</span></div><div className="chat-choice-actions"><button className="join-button secondary-button" onClick={() => void viewGroup(session.id)} disabled={loadingGroupId === session.id}>{loadingGroupId === session.id ? "Loading" : "View group"}</button>{session.organizer_id === user?.uid ? <span className="status-badge approved">Your group</span> : <><button className="join-button chat-join-action" onClick={() => void joinSession(session.id, session.group_name, session.organizer_id)} disabled={joiningSessionId !== null}>{joiningSessionId === session.id ? "Requesting..." : session.open_slots > 0 ? "Request to join" : "Join waitlist"}<span>↗</span></button><button className="chat-skip-action" type="button" onClick={() => skipSession(session.id)}>Not for me</button></>}</div></article>)}</div></div></div>}
          {!loading && lastChatRequest && <div className="chat-request-confirmation" role="status"><div><strong>{lastChatRequest.status === "waitlisted" ? "You are on the waitlist" : "Request sent"}</strong><span>{lastChatRequest.name}</span></div><button type="button" onClick={() => { setGamesViewTab(lastChatRequest.status === "approved" ? "upcoming" : "pending"); selectTab("games"); }}>{lastChatRequest.status === "approved" ? "View My games" : "Check Pending requests"} <span>→</span></button></div>}
          {!loading && showCraftedGame && groupProposal && <div className="chat-message assistant-message crafted-game-message"><span className="chat-message-mark">CM</span><div className="crafted-game-card"><span className="eyebrow">GAME PLAN</span><p className="create-guide-question">{creationQuestion()}</p><strong>{groupNameDraft}</strong><p>{creationPlanLabel()}</p><div className="tags"><span className="tag rating">CMR {createCmrMin}–{createCmrMax}</span><span className="tag">{createGroupDraft.style}</span></div><div className="crafted-game-actions"><button className="join-button create-button" type="button" onClick={() => void createGroup()} disabled={createGroupLoading}>{createGroupLoading ? "Creating..." : "Create game"}<span>↗</span></button></div></div></div>}
      {!loading && <div className="chat-prompt-groups" aria-label="Things CourtMate can answer or do">{quickPromptGroups().map((group) => <section className="chat-prompt-group" key={group.label}><header><strong>{group.label}</strong><span>{group.description}</span></header><div className="chat-quick-replies">{group.prompts.map((prompt) => <button type="button" key={prompt} disabled={loading} onClick={() => prompt === "Create this game" ? openCreateGame() : sendQuickPrompt(prompt)}><span>{prompt}</span>{prompt === "Record final score" && <small>Save the result with your completed session</small>}</button>)}</div></section>)}</div>}
        </div>
        {joiningSessionId && <div className="chat-request-sending" role="status">Sending your request to the group...</div>}
        <form className="chat-input-shell" onSubmit={handleChatSubmit}><div className="chat-input-label"><span className="chat-message-mark">{initials(user?.displayName ?? "You")}</span><span>{feedbackSessionId ? "Tell me how the game felt" : scoreSessionId ? "Say who played and the score" : showCraftedGame ? "Tell me what to change, or post this game" : "Describe your next game or ask about your performance"}</span></div><div className="chat-input-row"><label className="chat-attach-action" aria-label="Attach wearable screenshot" title="Attach a wearable screenshot"><input type="file" accept="image/jpeg, image/png, image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachPerformanceScreenshot(file); event.currentTarget.value = ""; }} /><span>+</span></label><input value={query} placeholder={feedbackSessionId ? "Great, fair, or not for me" : scoreSessionId ? "e.g. Rhea beat Ananya 11 to 8" : showCraftedGame ? "Change the time, area, level, or vibe" : "Ask for a game or performance"} onChange={(event) => { setQuery(event.target.value); const detectedSport = sportFromText(event.target.value); if (detectedSport) selectDetectedSport(detectedSport); }} aria-label="Describe the game you want to find or ask about performance" /><button type="button" className={`mic ${isListening ? "listening" : ""}`} onClick={startVoice} aria-label={isListening ? "Listening" : "Search by voice"} title={isListening ? "Listening" : "Search by voice"}><MicrophoneIcon /></button><button className="chat-send-action" type="submit" disabled={loading || !query.trim()} aria-label="Send message">{loading ? "..." : "↗"}</button></div></form>
      </section>
      {scorePickerOpen && <div className="home-score-picker" aria-label="Choose an active game to score"><div className="home-score-picker-heading"><span className="eyebrow">{scorePickerSport ? `YOUR ${sportLabel(scorePickerSport).toUpperCase()} GAMES` : "CHOOSE AN ACTIVE GAME"}</span><button type="button" onClick={() => { setScorePickerOpen(false); setScorePickerSport(null); }} aria-label="Close score picker">×</button></div>{visibleScoreGames.length ? visibleScoreGames.map((game) => <button className="home-score-session" type="button" key={game.id} onClick={() => chooseScoreSession(game)}><span className="date-badge"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(game.session_date).getDate()}</small></span><span><strong>{game.group_name}</strong><small>{sportLabel(game.sport)} · {game.start_time}–{game.end_time} · {game.area}</small></span><b>→</b></button>) : <p className="home-score-empty">No active {scorePickerSport ? `${sportLabel(scorePickerSport)} ` : ""}games found yet.</p>}</div>}
      {feedbackPickerOpen && <div className="home-score-picker" aria-label="Choose a completed game for feedback"><div className="home-score-picker-heading"><span className="eyebrow">REVIEW A GAME</span><button type="button" onClick={() => setFeedbackPickerOpen(false)} aria-label="Close feedback picker">×</button></div>{pastGames.map((pastGame) => <button className="home-score-session" type="button" key={pastGame.session.id} onClick={() => void chooseFeedbackSession(pastGame)}><span className="date-badge"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(pastGame.session.session_date).getDate()}</small></span><span><strong>{pastGame.session.group_name}</strong><small>{sportLabel(pastGame.session.sport)} · {pastGame.session.start_time}–{pastGame.session.end_time} · {pastGame.session.area}</small></span><b>→</b></button>)}</div>}
      </>}

      {activeTab === "social" && user && <SocialFeed apiUrl={apiUrl} currentUserId={user.uid} currentUserName={user.displayName ?? user.email ?? "CourtMate player"} currentProfileImage={profile?.profile_image_url} weeklyStreak={socialProfile?.weekly_streak} weeklyStreakActive={socialProfile?.weekly_streak_active} activityByDate={socialProfile?.activity_by_date} initialFilter={socialFeedEntry} authorizedFetch={authorizedFetch} onToast={showToast} onViewProfile={(playerId) => void viewPlayerProfile(playerId)} onInvalidate={(keys) => invalidateLiveState(keys as LiveStateKey[])} />}

      {activeTab === "games" && <section className="page-view games-page" onClickCapture={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
        if (button?.textContent?.trim() === "Find a game →") {
          event.stopPropagation();
          openGamesExplore();
        }
      }}>
        <button type="button" className="section-fab games-fab" onClick={toggleGamesForm} aria-label={showCreateGame ? "Close game form" : "Create a game"} title={showCreateGame ? "Close" : "Create a game"}>{showCreateGame ? "×" : "+"}</button>
        {showCreateGame && (
          <div className="game-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreateGameForm(); }}>
            <form className="game-create-form game-create-quick-form" onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
              <header className="game-create-heading">
                <div>
                  <span className="kicker">NEW GAME</span>
                  <h2>Create a game</h2>
                  <p>Set the basics. CourtMate will find compatible players nearby.</p>
                </div>
                <button className="game-create-close" type="button" onClick={closeCreateGameForm} aria-label="Close create game form">×</button>
              </header>

              <div className="game-create-essentials">
                <label><span>Sport</span><select value={createGroupDraft.sport} onChange={(event) => changeCreateSport(event.target.value as Sport)}>{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label>
                <label><span>Area</span><input value={createGroupDraft.area} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, area: event.target.value })} placeholder="e.g. Whitefield" required /></label>
                <label><span>Date</span><input type="date" min={localDateInput()} value={createGroupDraft.session_date} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, session_date: event.target.value })} required /></label>
                <div className="game-create-time-fields" role="group" aria-label="Game time"><span>Game time</span><label><small>Starts</small><input type="time" value={createGroupDraft.start_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, start_time: event.target.value })} required /></label><label><small>Ends</small><input type="time" value={createGroupDraft.end_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, end_time: event.target.value })} required /></label></div>
              </div>

              <div className="game-create-match-default"><span>SMART MATCHING</span><p>Players near your CMR are invited automatically. You can fine-tune the game after it is live.</p></div>

              <section className="game-create-more" aria-labelledby="game-create-more-title">
                <div className="game-create-more-heading">
                  <span id="game-create-more-title">Game details</span>
                  <p>Choose the format and who can discover the game.</p>
                </div>
                <div className="game-create-grid">
                  <label className="game-create-wide"><span>Game name <em>optional</em></span><input value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} placeholder="Whitefield Saturday Rally" /></label>
                  <label><span>Match type</span><select value={createGroupDraft.game_format} onChange={(event) => changeGameFormat(event.target.value as CreateGroupDraft["game_format"])}><option value="singles">Singles</option><option value="doubles">Doubles</option></select></label>
                  <label><span>Players</span><select value={createGroupDraft.capacity} onChange={(event) => setCreateGroupDraft((draft) => ({ ...draft, capacity: Number(event.target.value) }))} disabled={createGroupDraft.game_format === "singles"}>{(createGroupDraft.game_format === "singles" ? [2] : [4, 6, 8]).map((capacity) => <option value={capacity} key={capacity}>{capacity} players</option>)}</select><small className="game-create-hint">{createGroupDraft.game_format === "singles" ? "One opponent plus you." : "Includes you."}</small></label>
                  <label className="game-create-wide game-create-visibility"><span>Who can join?</span><select value={createGameVisibility} onChange={(event) => setCreateGameVisibility(event.target.value as SessionVisibility)}><option value="public">Anyone on Explore</option><option value="followers">Followers only</option><option value="private">People with the link</option></select></label>
                  <div className="game-create-wide game-create-cmr-note"><span>CMR SESSION</span><p>After the game, player feedback automatically contributes to sport-specific CMR.</p></div>
                </div>
              </section>

              {createGroupError && <p className="game-create-error" role="alert">{createGroupError}</p>}
              <div className="game-create-actions"><button className="dark-button" type="submit" disabled={createGroupLoading}>{createGroupLoading ? "Creating..." : "Create game"}<span>→</span></button></div>
            </form>
          </div>
        )}
        <div className="tournament-tabs" role="tablist" aria-label="Game views"><button className={gamesViewTab === "explore" ? "active" : ""} onClick={() => { setGamesViewTab("explore"); void loadExploreGames(); }}>Explore</button><button className={gamesViewTab === "upcoming" ? "active" : ""} onClick={() => setGamesViewTab("upcoming")}>Upcoming <span className="games-tab-count">{upcomingGames.length}</span></button><button className={gamesViewTab === "pending" ? "active" : ""} onClick={() => setGamesViewTab("pending")} aria-label={`Pending requests: ${requestedGames.length}`}>Pending <span className="games-tab-count">{requestedGames.length}</span></button><button className={gamesViewTab === "awaiting_feedback" ? "active" : ""} onClick={() => setGamesViewTab("awaiting_feedback")} aria-label={`Completed games${awaitingFeedbackGames.length ? `, ${awaitingFeedbackGames.length} feedback remaining` : ""}`} >Completed {awaitingFeedbackGames.length > 0 && <span className="games-tab-alert" aria-label={`${awaitingFeedbackGames.length} feedback remaining`}>! {awaitingFeedbackGames.length}</span>}</button></div>
        {gamesViewTab === "explore" && <div className="explore-filters" aria-label="Filter games"><label className="explore-filter-search"><span>Search games</span><input value={exploreSearchDraft} onChange={(event) => setExploreSearchDraft(event.target.value)} placeholder="Name, sport, or area" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyExploreFilters(); } }} /></label><label><span>Sport</span><select value={exploreSportFilter} onChange={(event) => setExploreSportFilter(event.target.value as Sport | "all")}><option value="all">All sports</option>{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label><label><span>Skill level (CMR)</span><select value={exploreCmrFilter} onChange={(event) => setExploreCmrFilter(event.target.value as ExploreCmrFilter)}><option value="all">Any CMR</option><option value="beginner">Beginner · 1.0–2.9</option><option value="intermediate">Intermediate · 3.0–5.9</option><option value="advanced">Advanced · 6.0–10.0</option></select></label><label><span>Availability</span><select value={exploreTimeFilter} onChange={(event) => setExploreTimeFilter(event.target.value as ExploreTimeFilter)}><option value="all">Any time</option><option value="morning">Morning · 12 AM–9 AM</option><option value="day">Day · 9 AM–4 PM</option><option value="evening">Evening · 4 PM–9 PM</option><option value="night">Night · 9 PM–12 AM</option></select></label><label><span>Date</span><input type="date" value={exploreDateFilter} onChange={(event) => setExploreDateFilter(event.target.value)} /></label><button type="button" className="explore-filter-search-button" onClick={applyExploreFilters}>See results</button><button className="explore-filter-reset" type="button" onClick={() => { setExploreSearchDraft(""); setExploreSearch(""); setExploreSportFilter("all"); setExploreDateFilter(""); setExploreCmrFilter("all"); setExploreTimeFilter("all"); setExploreSportApplied("all"); setExploreDateApplied(""); setExploreCmrApplied("all"); setExploreTimeApplied("all"); }} disabled={!exploreSearch && exploreSportApplied === "all" && !exploreDateApplied && exploreCmrApplied === "all" && exploreTimeApplied === "all"}>Reset</button></div>}
        {gamesViewTab === "explore" && <div className="game-list">{exploreLoading ? <TennisBallLoader label="Finding nearby games" /> : filteredExploreGames.length ? filteredExploreGames.map((game) => <article className="game-row" key={game.id}><div className="game-date"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p><small className="waitlist-summary">{Math.round(game.score * 100)}% match · {game.open_slots} spot{game.open_slots === 1 ? "" : "s"} open</small></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void viewGroup(game.id)} disabled={loadingGroupId === game.id}>{loadingGroupId === game.id ? "Loading..." : "View group"}</button><button className="copy-link-button" onClick={() => void copyGroupSpaceLink(game)} aria-label={`Copy ${game.group_name} link`} title="Copy share link"><CopyIcon /><span>Copy link</span></button><button className="game-share-button" onClick={() => void shareGame(game)} aria-label={`Share ${game.group_name}`}>Share <span>↗</span></button><button className="join-button" onClick={() => void joinSession(game.id, game.group_name, game.organizer_id)} disabled={joiningSessionId !== null || isSessionRequested(game.id)}>{joiningSessionId === game.id ? "Requesting..." : isSessionRequested(game.id) ? "Requested" : "Request to join"}<span>→</span></button></div></article>) : <div className="page-empty"><strong>No games match these filters.</strong><p>Try widening the sport, CMR, date, or availability filters.</p><button className="dark-button" onClick={() => { setExploreSportFilter("all"); setExploreDateFilter(""); setExploreCmrFilter("all"); setExploreTimeFilter("all"); setExploreSportApplied("all"); setExploreDateApplied(""); setExploreCmrApplied("all"); setExploreTimeApplied("all"); }}>Clear filters <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "upcoming" && <div className="game-list intuitive-game-list">{upcomingGames.length ? upcomingGames.map((game) => {
          const owned = myGroups.some((group) => group.id === game.id);
          const groupRequests = incomingRequests.filter(({ session }) => session.id === game.id);
          const waitlistCount = game.waitlist_player_ids?.length ?? 0;
          return <article className={`game-row upcoming-game-row intuitive-game-card ${groupRequests.length ? "has-pending-actions" : ""}`} key={game.id}>
            <div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div>
            <div className="game-copy"><div className="game-card-title-line"><h2>{game.group_name}</h2><span>{owned ? "You organise" : "Confirmed"}</span></div><p>{sportLabel(game.sport)} · {game.start_time.slice(0, 5)}–{game.end_time.slice(0, 5)} · {game.area}</p><small className="waitlist-summary">{game.confirmed_player_ids.length}/{game.capacity} confirmed · {waitlistCount ? `${waitlistCount} waiting` : `${Math.max(game.capacity - game.confirmed_player_ids.length, 0)} spots left`}</small></div>
            <div className="game-row-actions intuitive-card-actions"><button className="manage-group-button primary-card-action" onClick={() => void openGroupSpace(game)}>Open Rally Circle <span>→</span></button><button className="copy-link-button" onClick={() => void copyGroupSpaceLink(game)} aria-label={`Copy ${game.group_name} link`}><CopyIcon /><span>Copy link</span></button><button className="game-share-button" onClick={() => void shareGame(game)} aria-label={`Share ${game.group_name}`}>Share <span>↗</span></button>{!owned && <><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></>}</div>
            {owned && <section className={`inline-request-list always-visible-requests ${groupRequests.length ? "needs-action" : ""}`} aria-label={`Pending requests for ${game.group_name}`}><header><div><strong>Pending requests</strong><span>{groupRequests.length}</span></div><small>{groupRequests.length ? "Approve or decline each player here." : "No requests need your attention."}</small></header>{groupRequests.map(({ request }) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small>Wants to join this game</small></div><div className="request-actions"><button disabled={decidingRequestId === request.id} onClick={() => void decideJoinRequest(request.id, "approved", game.id)}>{decidingRequestId === request.id ? "Saving..." : "Approve"}</button><button disabled={decidingRequestId === request.id} onClick={() => void decideJoinRequest(request.id, "declined", game.id)}>Decline</button></div></div>)}</section>}
          </article>;
        }) : <div className="page-empty"><strong>No upcoming games yet.</strong><p>Join a nearby game or create a game from Home.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "pending" && <div className="game-list intuitive-game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className={`game-row intuitive-game-card pending-game-card ${justRequestedSessionId === session.id ? "just-landed" : ""}`} key={request.id}>
          <div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div>
          <div className="game-copy"><div className="game-card-title-line"><h2>{session.group_name}</h2><span className={`pending-card-label ${request.status}`} role="status">{request.status === "waitlisted" ? "Waitlisted" : "Awaiting approval"}</span>{justRequestedSessionId === session.id && <span className="just-landed-badge" role="status">Request sent</span>}</div><p>{sportLabel(session.sport)} · {session.start_time.slice(0, 5)}–{session.end_time.slice(0, 5)} · {session.area}</p><small className="waitlist-summary">{request.status === "waitlisted" ? "You are on the waitlist. We will move this game to Upcoming if a spot opens." : "The organizer has your request. Once approved, this game moves to Upcoming."}</small></div>
          <div className="game-row-actions intuitive-card-actions"><button className="manage-group-button primary-card-action" onClick={() => void viewGroup(session.id)} disabled={loadingGroupId === session.id}>{loadingGroupId === session.id ? "Opening..." : "View game"} <span>→</span></button><button className="leave-game-button pending-withdraw-button" onClick={() => void leaveGame(session.id, session.group_name, request.id)} disabled={leavingGameId === session.id}>{leavingGameId === session.id ? "Withdrawing..." : request.status === "waitlisted" ? "Leave waitlist" : "Withdraw request"}</button></div>
        </article>) : <div className="page-empty"><strong>No pending requests.</strong><p>Games you request will stay here until the organizer approves them.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "awaiting_feedback" && <div className="completed-sections">
          {awaitingFeedbackGames.length > 0 && <section className="completed-action-section"><header><div><span className="kicker">ACTION NEEDED</span><h2>Finish your games</h2></div><strong>{awaitingFeedbackGames.length} remaining</strong></header><div className="game-list intuitive-game-list">{awaitingFeedbackGames.map((game) => <article className="game-row awaiting-feedback-row intuitive-game-card" key={game.id}><div className="game-date completed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><div className="game-card-title-line"><h2>{game.group_name}</h2><span className="needs-rating-label">Needs your rating</span></div><p>{sportLabel(game.sport)} · {game.session_date} · {game.area}</p><small className="waitlist-summary">Rate the players you met. Competitive CMR changes only after confirmed results.</small></div><div className="game-row-actions intuitive-card-actions"><button className="manage-group-button primary-card-action" onClick={() => openPendingFeedback(game)}>Rate players <span>→</span></button><button className="game-share-button" onClick={() => { setPendingShareSessionId(game.id); void openGroupSpace(game); }}>Post to feed</button><button className="copy-link-button" onClick={() => void openGroupSpace(game)}>View game</button></div></article>)}</div></section>}
          {pastGames.length > 0 && <section className="completed-action-section completed-history-section"><header><div><span className="kicker">YOUR HISTORY</span><h2>Completed</h2></div><strong>{pastGames.length} games</strong></header><div className="game-list intuitive-game-list completed-game-list">{pastGames.map((pastGame) => <article className="game-row past-game-row intuitive-game-card" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><div className="game-card-title-line"><h2>{pastGame.session.group_name}</h2><span>Feedback saved</span></div><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `Ranked #${pastGame.rank} of ${pastGame.group_size}` : "Completed game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} CMR` : ""}</small></div><div className="game-row-actions intuitive-card-actions"><button className="manage-group-button primary-card-action" onClick={() => void openGroupSpace(pastGame.session)}>View game <span>→</span></button><button className="game-share-button" onClick={() => { setPendingShareSessionId(pastGame.session.id); void openGroupSpace(pastGame.session); }}>Post to feed</button></div></article>)}</div></section>}
          {!awaitingFeedbackGames.length && !pastGames.length && <div className="page-empty"><strong>No completed games yet.</strong><p>Games needing ratings and your finished game history will appear here.</p></div>}
        </div>}
        {!activityLoading && gamesViewTab === "history" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions game-row-status-actions"><span className="status-badge game-row-status completed" role="status"><i aria-hidden="true" />Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>Open game</button></div></article>) : <div className="page-empty"><strong>No history yet.</strong><p>Played games and your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {activityLoading && gamesViewTab !== "explore" && <TennisBallLoader label="Refreshing games" />}
        {!activityLoading && gamesViewTab === "past" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions"><span className="status-badge completed">Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No past games yet.</strong><p>Once a completed game has been played, your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "requested" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><span className={`status-badge ${request.status}`}>{request.status}</span>{["pending", "waitlisted"].includes(request.status) && <button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name, request.id)}>{request.status === "waitlisted" ? "Leave waitlist" : "Withdraw request"}</button>}</div></article>) : <div className="page-empty"><strong>No open requests.</strong><p>Confirmed games live in the Confirmed tab. New requests will appear here until the organizer responds.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "confirmed" && <div className="game-list">{approvedGames.length ? approvedGames.map((game) => <article className="game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></div></article>) : <div className="page-empty"><strong>No confirmed games yet.</strong><p>Once an organizer accepts your request, the game will appear here ready for your calendar.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "incoming" && <div className="game-list">{incomingRequests.length ? incomingRequests.map(({ request, session }) => <article className="game-row incoming-request-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{request.player_display_name ?? request.player_id.slice(0, 10)} wants to join</h2><p>{session.group_name} · {sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void decideJoinRequest(request.id, "approved", session.id)}>Approve</button><button className="leave-game-button" onClick={() => void decideJoinRequest(request.id, "declined", session.id)}>Decline</button></div></article>) : <div className="page-empty"><strong>No incoming requests.</strong><p>When someone requests to join one of your groups, you can approve them here.</p><button className="dark-button" onClick={() => { selectTab("home"); openCreateGame(); }}>Create a game <span>→</span></button></div>}</div>}
        {myGroups.length > 0 && <div className="organizer-page-card"><div><span className="kicker">ORGANIZER</span><h2>Your groups</h2><p>Manage requests, chat, and feedback for groups you created.</p></div>{myGroups.map((group) => <div className="organizer-page-row" key={group.id}><div><strong>{group.group_name}</strong><small>{sportLabel(group.sport)} · {group.session_date} · {group.confirmed_player_ids.length}/{group.capacity} players</small></div><div className="organizer-page-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(group)}>Group space</button><button className="manage-group-button" onClick={() => { setManagedGroupId(group.id); void loadJoinRequests(group.id); }}>Requests</button></div></div>)}{managedGroupId && <div className="request-card page-request-card"><p>Requests for <strong>{myGroups.find((group) => group.id === managedGroupId)?.group_name ?? "your group"}</strong>. Approve a player before they join.</p>{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? <div className="request-list">{joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved")}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined")}>Decline</button></div>}</div>)}</div> : <p className="request-empty">No requests waiting for approval.</p>}</div>}</div>}
      </section>}

      {user && activeTab === "games" && gamesViewTab === "explore" && (
        <CommunityHub
          key={`${profile?.latitude ?? "no-latitude"}:${profile?.longitude ?? "no-longitude"}:${profile?.area ?? "no-area"}`}
          apiUrl={apiUrl}
          authorizedFetch={discoveryFetch}
          gamesLogged={profile?.cmr_game_counts?.[selectedSport] ?? 0}
          requestedSessionIds={myRequests
            .filter(({ request }) => request.status === "pending" || request.status === "waitlisted")
            .map(({ request }) => request.session_id)}
          recentlyRequestedSessionId={justRequestedSessionId}
          joinedSessionIds={Array.from(new Set([...approvedGames, ...myGroups].map((game) => game.id)))}
          onOpenExistingGame={(_, status) => {
            setActiveTab("games");
            setGamesViewTab(status === "joined" ? "upcoming" : "pending");
          }}
          onOpenRallyCircle={(sessionId) => {
            setActiveTab("games");
            void openSharedGame(sessionId, user);
          }}
          onRequestJoin={async (game) => {
            await joinSession(game.id, game.group_name, undefined, true, game);
          }}
          initialLatitude={profile?.latitude}
          initialLongitude={profile?.longitude}
          initialArea={profile?.area}
        />
      )}

      {activeTab === "profile" && !viewedProfile && !cmrDetailsOpen && <section className="page-view profile-page">
        {user && profile && <section className="player-profile-hero">
          <div className="player-profile-identity">
            <div className="profile-photo-avatar player-profile-avatar">{profile.profile_image_url ? <img src={profile.profile_image_url} alt={`${profile.display_name} profile`} /> : initials(profile.display_name)}</div>
            <div className="player-profile-copy"><h1>{profile.display_name}</h1><p><span className="player-profile-presence" />{profile.area || "Set your locality"} · {profile.style} player</p><small className="profile-bio-line">{profile.bio?.trim() || "Add a short bio to let your next group know your game."}</small></div>
            <div className="player-profile-side-actions"><div className="profile-quick-actions"><button type="button" onClick={() => { setProfileDraft((draft) => ({ ...draft, bio: profile.bio ?? "" })); setBioEditing(true); }} aria-label="Edit profile" title="Edit profile"><EditIcon /></button><button type="button" onClick={openSettings} aria-label="Open settings" title="Settings"><SettingsIcon /></button><button type="button" onClick={() => void shareProfile(profile.id, profile.display_name, profile.is_profile_private)} aria-label="Share your profile" title="Share profile"><ShareIcon /></button></div>{socialProfile && <div className="player-profile-connections" aria-label="Your connections"><button type="button" onClick={() => openConnections("followers")}><b>{socialProfile.followers_count}</b><small>Followers</small></button><button type="button" onClick={() => openConnections("following")}><b>{socialProfile.following_count}</b><small>Following</small></button></div>}</div>
          </div>
          <details className="cmr-glossary"><summary>What is CMR?</summary><div className="cmr-glossary-copy"><p><strong>CMR means CourtMate Rating.</strong> It is a separate 1.00–10.00 skill signal for each sport, built from feedback by confirmed players after completed games.</p><section className="cmr-glossary-section"><h3>How it becomes useful</h3><dl><div><dt>One rating per sport</dt><dd>Your badminton feedback never changes your tennis or pickleball CMR.</dd></div><div><dt>More games, more confidence</dt><dd>Early ratings move faster. With more completed sessions, one person has less influence.</dd></div><div><dt>Better game fit</dt><dd>CMR helps players find sessions with a compatible level; it is not a tournament title.</dd></div></dl></section><section className="cmr-glossary-section cmr-glossary-exclusions"><h3>Kept separate</h3><p>Attendance, dropout chance, locality, followers, and streaks never change CMR.</p></section></div></details>
          <div className="player-profile-metrics"><span><b>{totalGames}</b><small>Games</small></span>{socialProfile && <span className={`player-profile-streak ${socialProfile.weekly_streak_active ? "active" : "at-risk"}`} title={socialProfile.weekly_streak_active ? "You completed a game this week." : "Complete a game this week to start a streak."}><i className="player-profile-streak-fire" aria-hidden="true"><StreakFireIcon /></i><b>{socialProfile.weekly_streak}</b><small>Weekly streak</small></span>}<span><b>{dropoutChance(profile)}%</b><small>Dropout chance</small></span></div>
        </section>}
        {user && profile && bioEditing && <section className="profile-editor-card" aria-labelledby="profile-editor-title"><div className="profile-editor-heading"><div><span className="kicker">EDIT PROFILE</span><h2 id="profile-editor-title">Photo and bio</h2></div><button type="button" onClick={() => setBioEditing(false)} aria-label="Close profile editor">×</button></div><div className="profile-editor-photo-row"><div className="profile-photo-avatar profile-editor-avatar">{profile.profile_image_url ? <img src={profile.profile_image_url} alt={`${profile.display_name} profile`} /> : initials(profile.display_name)}</div><div className="profile-editor-photo-actions"><label><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProfilePicture(file); event.currentTarget.value = ""; }} disabled={profilePictureUploading} /><span>{profilePictureUploading ? "Uploading..." : "Change picture"}</span></label>{profile.profile_image_url && <button type="button" onClick={() => void removeProfilePicture()} disabled={profilePictureUploading}>Remove picture</button>}</div></div><form className="profile-editor-form" onSubmit={saveBio}><label htmlFor="profile-editor-bio">Bio</label><textarea id="profile-editor-bio" value={profileDraft.bio} onChange={(event) => setProfileDraft((draft) => ({ ...draft, bio: event.target.value }))} maxLength={500} placeholder="Tell people what you play and what kind of games you enjoy." autoFocus /><div className="profile-editor-count">{profileDraft.bio.length}/500</div><div className="profile-editor-actions"><button type="button" onClick={() => { setProfileDraft((draft) => ({ ...draft, bio: profile.bio ?? "" })); setBioEditing(false); }}>Cancel</button><button className="dark-button" type="submit" disabled={bioSaving}>{bioSaving ? "Saving..." : "Save"}</button></div></form></section>}
        {user && profile && <ProfileSportOverview profile={profile} sports={sportOptions} selectedSport={profileStatsSport} onSelect={(sport) => { setProfileStatsSport(sport); if (sport) setProfileSport(sport); }} />}
        {user && profile && totalGames === 0 && <section className="profile-cmr-setup-card" aria-labelledby="profile-cmr-setup-title"><div><span className="kicker">UNLOCK CMR</span><h2 id="profile-cmr-setup-title">Your first feedback sets the baseline</h2><p>Complete a game and collect ratings from your lineup to unlock that sport&apos;s CMR.</p></div><strong className="profile-cmr-baseline">--</strong></section>}
        {user && profile && <section className={`profile-insights ${profileStatsSport ? "sport-focused" : "all-sports"}`}>
          {!ratedSports.length && <div className="cmr-no-ratings"><strong>No CMR unlocked yet.</strong><span>Your first completed-game feedback establishes a baseline for that sport.</span></div>}
          {socialProfile && <div className="social-stats"><button type="button" onClick={() => openConnections("followers")}><strong>{socialProfile.followers_count}</strong><span>Followers</span></button><button type="button" onClick={() => openConnections("following")}><strong>{socialProfile.following_count}</strong><span>Following</span></button><span><strong>{dropoutChance(profile)}%</strong><span>Dropout chance</span></span></div>}
          {!profileStatsSport && <section className="profile-cumulative-overview" aria-label="All sports summary"><div><span className="kicker">ALL SPORTS</span><h2>Your CourtMate overview</h2><p>Cumulative progress across every sport. Select a sport above for its detailed CMR trajectory.</p></div><div className="profile-cumulative-metrics"><span><strong>{totalGames}</strong><small>Games played</small></span><span><strong>{activeSports.length}</strong><small>Sports played</small></span><span><strong>{dropoutChance(profile)}%</strong><small>Dropout chance</small></span><span><strong>{currentCmr?.toFixed(2) ?? "--"}</strong><small>Overall CMR</small></span></div></section>}
          {!profileStatsSport && socialProfile && <div className="profile-overview-details">
            <section className="profile-overview-activity" aria-label="Your activity calendar"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Activity calendar</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={socialProfile.activity_by_date} playerName={profile.display_name} weeklyStreak={socialProfile.weekly_streak} onToast={showToast} /></section>
            <section className="profile-overview-games" aria-label="All game sessions"><div className="profile-activity-heading"><div><span className="kicker">GAME HISTORY</span><h2>All game sessions</h2></div><span>{socialProfile.recent_games.length} total</span></div><RecentGames games={socialProfile.recent_games} /></section>
          </div>}
          {ratedSports.length > 0 && <>
            <p className="cmr-summary">Current {sportLabel(profileSelectedSport)} CMR: <strong>{currentCmr?.toFixed(2) ?? "not built"} / 10.00</strong><span>{currentCmr ? ` · ${cmrLevelForRating(currentCmr)}` : " · Choose a starting level"}</span></p>
            {ratedProfileHistory.length > 0 ? <div className="cmr-chart-heading"><div><span className="kicker">CMR · {sportLabel(profileSelectedSport).toUpperCase()}</span><h2>Recent feedback</h2></div><span>{ratedProfileHistory.length} rated session{ratedProfileHistory.length === 1 ? "" : "s"}</span></div> : <div className="profile-empty-insight"><strong>No {sportLabel(profileSelectedSport)} CMR feedback yet.</strong><p>Complete a game and collect player feedback to start building this rating.</p></div>}
            {profileHistory.length > 0 && <div className="cmr-history-list">{profileHistory.slice().reverse().map((point) => <article className="cmr-history-row" key={point.session_id}><div><strong>{point.group_name}</strong><small>{point.session_date} · {point.game_rating != null ? `game rating ${point.game_rating.toFixed(2)} / 10` : "awaiting player feedback"}</small></div><div>{point.rating != null ? <b>{point.rating.toFixed(2)}</b> : <b>--</b>}{point.delta != null ? <span className={`cmr-history-change ${point.delta >= 0 ? "positive" : "negative"}`}><span aria-hidden="true">{point.delta > 0 ? "↑" : point.delta < 0 ? "↓" : "•"}</span>{point.delta >= 0 ? "+" : ""}{point.delta.toFixed(2)}</span> : <span className="cmr-history-change pending"><span aria-hidden="true">•</span>Pending</span>}</div></article>)}</div>}
          </>}</section>}
        {!user && <div className="page-empty"><strong>Sign in to manage your profile.</strong><p>Your rating and preferences are saved securely to your CourtMate profile.</p><button className="dark-button" onClick={() => void signIn()}>Sign in with Google <span>→</span></button></div>}
        {user && profile && <form id="profile-preferences" className="profile-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Locality label</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label><span>Latitude</span><input type="number" min="-90" max="90" step="any" value={profileDraft.latitude ?? ""} onChange={(event) => setProfileDraft({ ...profileDraft, latitude: event.target.value === "" ? null : Number(event.target.value) })} placeholder="12.9716" /></label><label><span>Longitude</span><input type="number" min="-180" max="180" step="any" value={profileDraft.longitude ?? ""} onChange={(event) => setProfileDraft({ ...profileDraft, longitude: event.target.value === "" ? null : Number(event.target.value) })} placeholder="77.5946" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation}>{profileDraft.latitude != null && profileDraft.longitude != null ? "Use current location again" : "Use my current location"}<span>⌖</span></button></label></div><label><span>How do you like to play?</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>When are you usually available?</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save profile <span>→</span></button></div><div className="profile-sign-out"><span>Done playing for now?</span><button type="button" onClick={() => void signOutUser()}>Sign out</button></div></form>}
      </section>}

      {cmrDetailsOpen && user && profile && <section className="utility-page cmr-details-page" aria-labelledby="cmr-details-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Back to profile">←</button><div><span className="kicker">COURTMATE RATING</span><h1 id="cmr-details-title">How CMR works</h1><p>A sport-specific signal built from games and people who played with you.</p></div></div><div className="cmr-details-content"><div className="cmr-details-score"><span>{profileStatsSport ? sportLabel(profileSelectedSport) : "Overall"} CMR</span><strong>{currentCmr?.toFixed(2) ?? "--"}</strong><small>{currentCmrGames} rated session{currentCmrGames === 1 ? "" : "s"}</small></div><p><strong>CMR means CourtMate Rating.</strong> After a completed session, players rate one another from 1 to 10. CourtMate combines that feedback over time into a separate CMR for each sport.</p><section><h2>What affects your rating</h2><dl><div><dt>Player feedback</dt><dd>Ratings from confirmed players in completed sessions contribute to your CMR.</dd></div><div><dt>More sessions</dt><dd>Early feedback moves the signal faster. As more people rate you, one session has less influence.</dd></div><div><dt>Sport context</dt><dd>Badminton feedback changes badminton CMR only; every sport keeps its own history.</dd></div><div><dt>Overview</dt><dd>The All circle combines your rated sessions so you can return to the full profile view.</dd></div></dl></section><section><h2>What does not affect CMR</h2><p>Locality, followers, streaks, attendance, and dropout chance do not change your skill rating.</p></section><small className="cmr-details-note">CMR is a community-built CourtMate signal, not an official tournament rating.</small></div></section>}

      {activeTab === "leaderboard" && user && profile && <section className="page-view circle-leaderboard-page" aria-label="Leaderboard">
        <div className="circle-leaderboard-tabs" role="tablist" aria-label="Leaderboard scope"><button type="button" className={circleLeaderboardScope === "circle" ? "active" : ""} onClick={() => setCircleLeaderboardScope("circle")} role="tab" aria-selected={circleLeaderboardScope === "circle"}><strong>Core circle</strong><small>Your connections</small></button><button type="button" className={circleLeaderboardScope === "locality" ? "active" : ""} onClick={() => setCircleLeaderboardScope("locality")} role="tab" aria-selected={circleLeaderboardScope === "locality"}><strong>Your locality</strong><small>{profile.area || "Nearby"}</small></button><button type="button" className={circleLeaderboardScope === "bengaluru" ? "active" : ""} onClick={() => setCircleLeaderboardScope("bengaluru")} role="tab" aria-selected={circleLeaderboardScope === "bengaluru"}><strong>Bengaluru</strong><small>City-wide</small></button></div>
        <label className="circle-leaderboard-sport-select"><span>Sport</span><select value={circleLeaderboardSport} onChange={(event) => setCircleLeaderboardSport(event.target.value as Sport)} aria-label="Leaderboard sport">{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label>
        <div className="circle-leaderboard-summary"><div><span className="kicker">{sportLabel(circleLeaderboardSport).toUpperCase()}</span><h2>{circleLeaderboardScope === "circle" ? "Your people" : circleLeaderboardScope === "locality" ? profile.area || "Your locality" : "Across Bengaluru"}</h2></div><span>{circleLeaderboardEntries.length} ranked</span></div>
        {circleLeaderboardLoading ? <div className="connections-loader"><TennisBallLoader label="Building the table" detail={`Ranking ${sportLabel(circleLeaderboardSport)} CMR...`} /></div> : circleLeaderboardError ? <div className="utility-empty"><h2>Leaderboard unavailable</h2><p>{circleLeaderboardError}. Try again in a moment.</p><button className="dark-button" type="button" onClick={() => void loadCircleLeaderboard(circleLeaderboardScope, circleLeaderboardSport)}>Try again <span>→</span></button></div> : circleLeaderboardEntries.length ? <div className="circle-leaderboard-list" role="tabpanel">{circleLeaderboardEntries.map((entry) => <button type="button" className={`circle-leaderboard-row ${entry.player.id === user.uid ? "current" : ""}`} onClick={() => void viewPlayerProfile(entry.player.id)} key={entry.player.id}><span className="circle-leaderboard-rank">{entry.rank}</span><span className="circle-leaderboard-avatar">{entry.player.profile_image_url ? <img src={entry.player.profile_image_url} alt="" /> : initials(entry.player.display_name)}</span><span className="circle-leaderboard-player"><strong>{entry.player.display_name}{entry.player.id === user.uid && <em>You</em>}</strong><small>{entry.player.area || "Bengaluru"} · {entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></span><span className="circle-leaderboard-score"><b>{entry.score.toFixed(2)}</b><small>CMR</small></span></button>)}</div> : <div className="utility-empty circle-leaderboard-empty"><h2>No {sportLabel(circleLeaderboardSport)} ratings here yet</h2><p>{circleLeaderboardScope === "circle" ? "Connect with players and complete rated games to build this circle." : "Completed rated games will place players on this leaderboard."}</p></div>}
      </section>}

      {connectionsOpen && user && <section className="utility-page connections-page" aria-labelledby="connections-title"><div className="connections-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><h1 id="connections-title">Connections</h1></div><div className="connections-tabs" role="tablist" aria-label="Connections"><button type="button" className={connectionsTab === "following" ? "active" : ""} onClick={() => setConnectionsTab("following")} role="tab" aria-selected={connectionsTab === "following"}>Following</button><button type="button" className={connectionsTab === "followers" ? "active" : ""} onClick={() => setConnectionsTab("followers")} role="tab" aria-selected={connectionsTab === "followers"}>Followers</button></div>{connectionsLoading ? <div className="connections-loader"><TennisBallLoader label="Loading connections" detail="Finding your people..." /></div> : connectionsError ? <div className="utility-empty"><h2>Could not load connections</h2><p>Try again and we&apos;ll fetch your latest following list.</p><button className="dark-button" type="button" onClick={() => void loadConnections(connectionsTab)}>Try again <span>→</span></button></div> : connections.length ? <div className="connections-list" role="tabpanel">{connections.map((connection) => <article className="connection-row" key={connection.id}><button type="button" className="connection-profile" onClick={() => void viewPlayerProfile(connection.id)} disabled={profileLoadingId === connection.id} aria-label={`View ${connection.display_name}'s profile`}><span className="connection-avatar">{connection.profile_image_url ? <img src={connection.profile_image_url} alt="" /> : initials(connection.display_name)}</span><span><strong>{connection.display_name}</strong><small>{connection.area || "CourtMate player"}</small></span></button><button type="button" className={`connection-follow-button ${connection.is_following ? "following" : connection.follow_request_pending ? "requested" : ""}`} onClick={() => void toggleConnection(connection)} disabled={profileLoadingId === `connection-${connection.id}`}>{profileLoadingId === `connection-${connection.id}` ? "..." : connection.is_following ? "Following" : connection.follow_request_pending ? "Requested" : "Follow"}</button></article>)}</div> : <div className="utility-empty"><h2>No {connectionsTab} yet</h2><p>{connectionsTab === "following" ? "Follow players from games and social to see them here." : "When players follow you, they&apos;ll appear here."}</p></div>}</section>}
      {notificationsOpen && user && <section className="utility-page notifications-page" aria-labelledby="notifications-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">COURTMATE ALERTS</span><h1 id="notifications-title">Notifications</h1><p>Requests, follows, and games that fit.</p></div><button className="utility-refresh-button" type="button" onClick={() => void loadNotifications()}>Refresh</button></div>{notifications.length ? <div className="utility-notification-list">{notifications.map((notification) => <div className={`notification-item ${notification.read ? "" : "unread"}`} key={notification.id}><button type="button" className="notification-item-main" onClick={() => openNotification(notification)}><span className="notification-mark"><BellIcon /></span><span><strong>{notification.title}</strong><small>{notification.message}</small><em>{new Date(notification.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</em></span></button>{notification.kind === "join_request" && notification.request_id && (notification.action_status ?? "pending") === "pending" && <div className="notification-actions"><button type="button" disabled={notificationActioningId === notification.id} onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "approved"); }}>{notificationActioningId === notification.id ? "Confirming..." : "Confirm"}</button><button type="button" disabled={notificationActioningId === notification.id} onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "declined"); }}>{notificationActioningId === notification.id ? "Updating..." : "Decline"}</button></div>}{notification.kind === "follow" && notification.actor_id && (notification.action_status ?? "pending") === "pending" && <div className="notification-actions"><button type="button" disabled={notificationActioningId === notification.id} onClick={(event) => { event.stopPropagation(); void decideFollowRequest(notification, "approved"); }}>{notificationActioningId === notification.id ? "Accepting..." : "Accept"}</button><button type="button" disabled={notificationActioningId === notification.id} onClick={(event) => { event.stopPropagation(); void decideFollowRequest(notification, "declined"); }}>{notificationActioningId === notification.id ? "Updating..." : "Decline"}</button></div>}{notification.kind === "join_request" && notification.action_status && notification.action_status !== "pending" && <span className={`notification-action-status ${notification.action_status}`}>Request {notificationActionLabels[notification.action_status]}</span>}</div>)}</div> : <div className="utility-empty"><span className="utility-empty-icon"><BellIcon /></span><h2>No alerts yet</h2><p>We&apos;ll let you know when a game fits your preferences or someone requests to join.</p></div>}</section>}
      {settingsOpen && user && profile && <section className="utility-page settings-page" aria-labelledby="settings-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">PREFERENCES</span><h1 id="settings-title">Your play setup</h1><p>Set the details CourtMate uses to find better games.</p></div></div><form className="settings-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Age</span><input type="number" min="13" max="100" step="1" value={profileDraft.age} onChange={(event) => setProfileDraft({ ...profileDraft, age: event.target.value })} placeholder="Optional" /></label><label><span>Gender</span><select value={profileDraft.gender} onChange={(event) => setProfileDraft({ ...profileDraft, gender: event.target.value as ProfileDraft["gender"] })}><option value="">Prefer not to say</option>{genderOptions.map((gender) => <option value={gender.value} key={gender.value}>{gender.label}</option>)}</select></label><label><span>Locality</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation} disabled={locationSaving}>{locationSaving ? "Updating location..." : profile?.latitude != null && profile?.longitude != null ? "Update current location" : "Use current location"}<span>⌖</span></button></label></div><fieldset className="settings-preference-fieldset"><legend>Who do you like to play with?</legend><label><span>Age range</span><select value={profileDraft.preferred_age_range} onChange={(event) => setProfileDraft({ ...profileDraft, preferred_age_range: event.target.value as AgeRange })}>{ageRangeOptions.map((range) => <option value={range.value} key={range.value}>{range.label}</option>)}</select></label><span className="settings-hint">Leave gender unselected to keep every group in the mix.</span><div className="gender-preference-grid">{genderOptions.map((gender) => <label className={`availability-option ${profileDraft.preferred_genders.includes(gender.value) ? "selected" : ""}`} key={gender.value}><input type="checkbox" checked={profileDraft.preferred_genders.includes(gender.value)} onChange={() => togglePreferredGender(gender.value)} /><span>{gender.label}</span></label>)}</div></fieldset><label><span>Play style</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>Usual availability</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save preferences <span>→</span></button></div></form></section>}
      {settingsOpen && user && profile && <section className="settings-privacy-panel" aria-labelledby="privacy-settings-title"><div className="settings-privacy-heading"><div><span className="kicker">PRIVACY</span><h2 id="privacy-settings-title">Who can see your play?</h2></div><span>Applies to new games</span></div><form className="settings-privacy-form" onSubmit={saveProfile}><label className="settings-toggle-row"><span><strong>Private profile</strong><small>Hide your profile from recommendations and public player pages.</small></span><input type="checkbox" checked={profileDraft.is_profile_private} onChange={(event) => setProfileDraft({ ...profileDraft, is_profile_private: event.target.checked })} /><span className="settings-switch" aria-hidden="true" /></label><label><span>Default game session visibility</span><select value={profileDraft.default_session_visibility} onChange={(event) => setProfileDraft({ ...profileDraft, default_session_visibility: event.target.value as SessionVisibility })}><option value="public">Everyone nearby</option><option value="followers">Followers of the organizer</option><option value="private">Only players in the game</option></select></label><p className="settings-hint">This controls who can discover the games you create. You can still share a private game directly.</p><button className="dark-button" type="submit">Save privacy settings <span>→</span></button></form><div className="settings-sign-out"><div><strong>Sign out of CourtMate</strong><span>Your saved profile and game history will remain available next time you sign in.</span></div><button type="button" onClick={() => void signOutUser()}>Sign out</button></div></section>}
      {calendarOpen && user && socialProfile && <section className="utility-page profile-calendar-page" aria-labelledby="profile-calendar-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">YOUR ACTIVITY</span><h1 id="profile-calendar-title">Activity calendar</h1><p>Every game day, all in one place.</p></div></div><ActivityCalendar activity={socialProfile.activity_by_date} /></section>}
      {viewedGroup && <div className="group-modal-backdrop" onClick={() => setViewedGroup(null)}><section className="group-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">{sportLabel(viewedGroup.session.sport).toUpperCase()} GROUP PREVIEW</span><h2>{viewedGroup.session.group_name}</h2><p>{viewedGroup.session.start_time} – {viewedGroup.session.end_time} · {viewedGroup.session.area}</p></div><button className="close-button" onClick={() => setViewedGroup(null)}>×</button></div><div className="group-summary"><span><strong>{viewedGroup.members.length}/{viewedGroup.session.capacity}</strong><small>PLAYERS</small></span><span><strong>{viewedGroup.session.skill_min.toFixed(1)}–{viewedGroup.session.skill_max.toFixed(1)}</strong><small>SKILL BAND</small></span><span><strong>{viewedGroup.session.style}</strong><small>INTENSITY</small></span></div><div className="member-grid">{viewedGroup.members.map((member) => { const memberCmr = member.cmr_ratings?.[viewedGroup.session.sport]; const memberRating = memberCmr ?? member.sport_ratings?.[viewedGroup.session.sport] ?? (viewedGroup.session.sport === "pickleball" ? member.dupr_rating : undefined); return <button type="button" className="member-profile profile-link" key={member.id} onClick={() => void viewPlayerProfile(member.id)} disabled={profileLoadingId === member.id} aria-label={`View ${member.display_name}'s profile`}><div className="member-profile-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</div><div className="member-profile-copy"><h3>{member.display_name}</h3><p>{member.area} · {member.style}</p><div className="member-profile-meta"><strong>{memberCmr != null ? `CMR ${memberCmr.toFixed(1)} / 10` : memberRating ? `${sportLabel(viewedGroup.session.sport)} ${memberRating.toFixed(1)}` : "Rating not set"}</strong><span>{member.is_following ? "Following" : "View profile"}</span></div></div></button>; })}</div><div className="modal-game-actions"><button className="copy-link-button" onClick={() => void copyGroupSpaceLink(viewedGroup.session)} aria-label={`Copy ${viewedGroup.session.group_name} link`} title="Copy share link"><CopyIcon /><span>Copy link</span></button><button className="game-share-button" onClick={() => void shareGame(viewedGroup.session)}>Share game <span>↗</span></button>{viewedGroup.session.organizer_id === user?.uid ? <span className="status-badge approved modal-join">You created this group</span> : <button className="dark-button modal-join" onClick={() => void joinSession(viewedGroup.session.id, viewedGroup.session.group_name, viewedGroup.session.organizer_id, true, viewedGroup.session)} disabled={joiningSessionId !== null}>{joiningSessionId === viewedGroup.session.id ? "Joining..." : viewedGroup.session.visibility === "private" ? "Join game" : "Request to join"} <span>→</span></button>}</div></section></div>}
      {activeTab === "profile" && viewedProfile && <PublicProfileView key={viewedProfile.id} profile={viewedProfile} followLoading={profileLoadingId === `profile-follow-${viewedProfile.id}`} onBack={closePlayerProfile} onFollow={() => void toggleFollowProfile()} onShare={() => void shareProfile(viewedProfile.id, viewedProfile.display_name, viewedProfile.is_profile_private)} onToast={showToast} />}
      {workspaceGroup && workspaceLoading && <section className="group-space-page group-space-loading"><TennisBallLoader label="Opening Rally Circle" detail="Loading chat, players, and the waitlist..." /></section>}
      {workspaceGroup && !workspaceLoading && <GroupSpace key={workspaceGroup.id} group={workspaceGroup} members={groupMembers} waitlist={groupWaitlist} posts={chatPosts} currentUserId={user?.uid} apiUrl={apiUrl} authorizedFetch={authorizedFetch} initialFeedbackRequired={pendingFeedbackSessionId === workspaceGroup.id} initialShareOpen={pendingShareSessionId === workspaceGroup.id} onClose={() => { setPendingFeedbackSessionId(null); setPendingShareSessionId(null); setWorkspaceGroup(null); }} onRefresh={() => { setPendingFeedbackSessionId(null); void openGroupSpace(workspaceGroup); }} onMarkDone={() => markGroupDone(workspaceGroup.id)} onLeave={() => leaveGame(workspaceGroup.id, workspaceGroup.group_name)} onChatPosted={(post) => setChatPosts((current) => { const existing = current.find((item) => item.id === post.id); if (existing && !hasStateChanged(existing, post)) return current; return existing ? current.map((item) => item.id === post.id ? post : item) : [...current, post]; })} onToast={showToast} onViewProfile={(playerId) => void viewPlayerProfile(playerId)} />}
      {rankingGame && <section className="ranking-page" aria-labelledby="ranking-page-title"><header className="ranking-page-header"><button type="button" className="ranking-back-button" onClick={() => { if (window.location.hash) window.history.back(); else setRankingGame(null); }} aria-label="Back to games">←</button><div><span className="kicker">FINAL RANKINGS</span><h1 id="ranking-page-title">{rankingGame.group_name}</h1><p>{sportLabel(rankingGame.sport)} · {rankingGame.session_date} · {rankingGame.area}</p></div></header>{rankingLoading ? <div className="ranking-loading"><TennisBallLoader label="Loading rankings" detail="Fetching the final table..." /></div> : <div className="ranking-page-content"><section className="ranking-only-panel"><div className="ranking-only-heading"><div><span className="kicker">THIS GAME</span><h2>Group rankings</h2></div><span>{rankingEntries.length} players</span></div>{rankingEntries.length ? <div className="ranking-only-list">{rankingEntries.map((entry) => <div className={`ranking-only-row ${entry.player.id === user?.uid ? "current" : ""}`} key={entry.player.id}><span className="ranking-only-rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div> : <p className="ranking-only-empty">No confirmed rankings for this game yet.</p>}</section>{localRankingEntries.length > 0 && <section className="ranking-only-panel local-ranking-only-panel"><div className="ranking-only-heading"><div><span className="kicker">{rankingGame.area.toUpperCase()} · LOCAL</span><h2>Local leaderboard</h2></div><span>Top {Math.min(localRankingEntries.length, 5)}</span></div><div className="ranking-only-list">{localRankingEntries.slice(0, 5).map((entry) => <div className="ranking-only-row" key={entry.player.id}><span className="ranking-only-rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div></section>}</div>}</section>}
      {toast && !(activeTab === "home" && user) && <div className={`toast ${toast === "Copied link to clipboard" ? "share-copy-toast" : ""}`}>{toast === "Copied link to clipboard" && <span className="share-copy-toast-icon" aria-hidden="true">✓</span>}{toast}</div>}
    </main>
  );
}

function StreakFireIcon() {
  return <svg className="nav-streak-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.4 2.5c.4 3.5-1.8 4.8-3.1 6.7-.8 1.1-.9 2.2-.5 3.2.4-1 1.2-1.8 2.3-2.4-.2 2.3.8 3.1 1.9 4.1.8.7 1.3 1.5 1.3 2.5 0 .5-.1.9-.3 1.3 1.9-.8 3.2-2.6 3.2-4.8 0-1.3-.5-2.7-1.6-4.2 3.1 1.9 4.8 4.5 4.8 7.4 0 4.3-3.5 7.5-8 7.5s-8-3.1-8-7.5c0-3.8 2.4-6.8 6.6-9.2-.1 1.4.2 2.4.8 3.1.7-2.1 1.3-4.4.6-7.7Z" fill="currentColor" /></svg>;
}

interface SpeechRecognitionEvent extends Event { results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } } }
interface SpeechRecognition { lang: string; interimResults: boolean; continuous: boolean; onstart: () => void; onend: () => void; onresult: (event: SpeechRecognitionEvent) => void; start: () => void }

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join("") || "CM").toUpperCase();
}
