"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";
import { usePathname, useRouter } from "next/navigation";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { auth, isFirebaseConfigured, storage } from "../firebase";
import { GroupSpace } from "./group-space";
import { CommunityHub, type NearbyGame } from "./community-hub";
import { PostGameFeedbackPanel } from "./post-game-feedback";
import { SocialFeed } from "./social-feed";
import { TennisBallLoader } from "./tennis-ball-loader";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type Gender = "woman" | "man" | "non_binary" | "prefer_not_to_say";
type AgeRange = "any" | "18_24" | "25_34" | "35_44" | "45_plus";
type SessionVisibility = "public" | "followers" | "private";
type Theme = "light" | "dark";
type ExploreTimeFilter = "all" | "morning" | "day" | "evening" | "night";
type ExploreCmrFilter = "all" | "beginner" | "intermediate" | "advanced";

const sportOptions: { value: Sport; label: string }[] = [
  { value: "pickleball", label: "Pickleball" },
  { value: "badminton", label: "Badminton" },
  { value: "tennis", label: "Tennis" },
  { value: "padel", label: "Padel" },
  { value: "squash", label: "Squash" },
  { value: "table_tennis", label: "Table tennis" },
];

const cmrLevelChoices = [
  { value: 1, label: "Complete beginner" },
  { value: 2, label: "Beginner" },
  { value: 3, label: "Learning / recreational" },
  { value: 4, label: "Intermediate" },
  { value: 5, label: "Strong intermediate" },
  { value: 6, label: "Advanced" },
  { value: 7, label: "Very advanced" },
  { value: 8, label: "Expert" },
  { value: 9, label: "Elite" },
  { value: 10, label: "Competitive / professional" },
] as const;

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

function ShareIcon() {
  return <svg className="social-share-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M5 13v7h14v-7" /></svg>;
}

function activityCacheKey(playerId: string) {
  return `courtmate:activity:${playerId}`;
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

type AppTab = "home" | "social" | "games" | "profile" | "communities";
type GamesViewTab = "explore" | "pending" | "upcoming" | "awaiting_feedback" | "history" | "requested" | "confirmed" | "past" | "incoming";
type ConnectionsTab = "following" | "followers";

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

function cmrGraphPoints(history: CMRHistoryPoint[]): string {
  const width = 560;
  const height = 190;
  const padding = 28;
  const ratedHistory = history.filter((point) => point.rating != null);
  return ratedHistory.map((point, index) => {
    const x = ratedHistory.length === 1 ? width / 2 : padding + (index * (width - padding * 2)) / (ratedHistory.length - 1);
    const y = height - padding - ((clampCmr(point.rating ?? 1) - 1) * (height - padding * 2)) / 9;
    return `${x},${y}`;
  }).join(" ");
}

function localDateInput(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
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
  return /\b(cmr|rating|ratings|stats|statistics|calories|steps|heart rate|distance|wearable|progress|trend|fitness|form)\b/.test(normalized)
    || (/\b(my|me|i|mine|i've|i have)\b/.test(normalized) && /\b(performance|history|played|games|activity|progress|trend|improve|form)\b/.test(normalized));
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 0 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 0 1 0-3h.2a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 0 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3h-.2a1.8 1.8 0 0 0-.9 3Z" /></svg>;
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
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

function MapIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z" /><path d="M9 3v16M15 5v16" /></svg>;
}

function ProfileIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
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
  async function shareActivity() {
    const text = `My CourtMate play streak\n\n${activeDays} active day${activeDays === 1 ? "" : "s"} in the last 12 weeks. Keep showing up, keep improving your CMR.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "My CourtMate play streak", text });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Sharing can be cancelled by the user.
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

function ProfileSportOverview({ profile, sports, selectedSport, onSelect }: { profile: PlayerProfile; sports: { value: Sport; label: string }[]; selectedSport: Sport | null; onSelect: (sport: Sport) => void }) {
  const courtSportValues = new Set(sportOptions.map((sport) => sport.value));
  const cards = sports
    .filter((sport) => courtSportValues.has(sport.value))
    .map((sport) => {
      const history = profile.cmr_history?.[sport.value] ?? [];
      const ratedHistory = history.filter((point) => point.rating != null);
      return {
        ...sport,
        rating: profile.cmr_ratings?.[sport.value] ?? ratedHistory[ratedHistory.length - 1]?.rating ?? 0,
        games: profile.cmr_game_counts?.[sport.value] ?? ratedHistory.length,
      };
    })
    .sort((left, right) => right.games - left.games);

  if (!cards.length) return null;
  return <section className="profile-sport-overview" aria-label="Sport-wise CMR stats"><div className="profile-sport-overview-heading"><div><span className="kicker">YOUR SPORTS</span><h2>CMR by sport</h2></div><span>Tap a circle to explore</span></div><div className="profile-sport-overview-grid">{cards.map((sport) => <button type="button" className={`profile-sport-stat ${selectedSport === sport.value ? "selected" : ""}`} key={sport.value} onClick={() => onSelect(sport.value)} aria-label={`${sport.label}, ${sport.rating.toFixed(2)} CMR`} aria-pressed={selectedSport === sport.value}><span className="cmr-ring" style={{ background: `conic-gradient(var(--lime) ${Math.max(0, Math.min(100, ((sport.rating - 1) / 9) * 100))}%, #e5eadc 0)` }}><span><b>{sport.rating.toFixed(2)}</b></span></span><strong>{sport.label}</strong></button>)}</div></section>;
}

function ProfileReliability({ profile }: { profile: PlayerProfile }) {
  const showUpCount = profile.on_time_check_in_count + profile.late_check_in_count;
  return <section className="profile-reliability-card" aria-label="Reliability and attendance record">
    <header><div><span className="kicker">RELIABILITY RECORD</span><h2>Show-up history</h2><p>Tracked separately from skill and CMR.</p></div><strong>{Math.round(profile.reliability * 100)}%</strong></header>
    <div className="profile-reliability-summary"><b>{showUpCount}</b><span>confirmed show-ups</span><small>{profile.withdrawal_count} withdrawal{profile.withdrawal_count === 1 ? "" : "s"} recorded</small></div>
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
  const [createGroupDraft, setCreateGroupDraft] = useState<CreateGroupDraft>({ sport: "pickleball", area: "", session_date: localDateInput(), start_time: "19:00", end_time: "21:00", skill_min: "3.2", skill_max: "6.8", style: "casual", rating_mode: "casual", game_format: "doubles", capacity: 6 });
  const [createQuery, setCreateQuery] = useState("");
  const [showCreateGame, setShowCreateGame] = useState(false);
  const [createGameVisibility, setCreateGameVisibility] = useState<SessionVisibility>("public");
  const [showCraftedGame, setShowCraftedGame] = useState(false);
  const [creationStep, setCreationStep] = useState<"confirm" | "sport" | "time" | "area" | "skill" | "vibe">("confirm");
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [cmrSetupSport, setCmrSetupSport] = useState<Sport | null>(null);
  const [cmrSetupLevel, setCmrSetupLevel] = useState(3);
  const [cmrSetupSaving, setCmrSetupSaving] = useState(false);
  const [cmrSetupError, setCmrSetupError] = useState("");
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ bio: "", is_profile_private: false, default_session_visibility: "public", area: "Whitefield", age: "", gender: "", preferred_age_range: "any", preferred_genders: [], travel_radius_km: "10", style: "casual", availability: [] });
  const [bioEditing, setBioEditing] = useState(false);
  const [bioSaving, setBioSaving] = useState(false);
  const [profilePictureUploading, setProfilePictureUploading] = useState(false);
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
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | null>(null);
  const cmrSetupAutoPromptedRef = useRef(false);
  const activityRequestRef = useRef<Promise<ActivitySnapshot> | null>(null);
  const activityLoadVersionRef = useRef(0);
  const groupSpaceCacheRef = useRef(new Map<string, GroupSpaceCacheEntry>());
  const groupSpaceRequestRef = useRef(0);
  const sharedGameHandledRef = useRef("");

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
    if (!cmrSetupSport) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !cmrSetupSaving) setCmrSetupSport(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cmrSetupSaving, cmrSetupSport]);

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
        } else if (tabParam && ["home", "social", "games", "profile", "communities"].includes(tabParam)) {
          setActiveTab(tabParam === "communities" ? "games" : tabParam as AppTab);
          if (tabParam === "communities") setGamesViewTab("explore");
        } else {
          setActiveTab("social");
        }
        if (viewParam && ["explore", "pending", "upcoming", "awaiting_feedback", "history", "requested", "confirmed", "past", "incoming"].includes(viewParam)) {
          setGamesViewTab(viewParam as GamesViewTab);
        }
        void loadProfile(nextUser);
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
    if (!user) return;
    const interval = window.setInterval(() => void loadNotifications(user), 30000);
    return () => window.clearInterval(interval);
  }, [user]);

  useEffect(() => {
    if (!connectionsOpen || !user) return;
    void loadConnections(connectionsTab, user);
  }, [connectionsOpen, connectionsTab, user]);

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

  async function loadNotifications(authUser: User = user as User) {
    if (!authUser) return;
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/notifications`, {}, authUser);
      if (!response.ok) throw new Error("Notifications unavailable");
      const payload = await response.json() as { notifications: AppNotification[] };
      setNotifications(payload.notifications);
      if (payload.notifications.some((notification) => notification.kind === "request_update" && !notification.read)) {
        void loadGamesActivity(authUser, false, false);
      }
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

  async function loadConnections(tab: ConnectionsTab, authUser: User = user as User) {
    if (!authUser) return;
    try {
      setConnectionsLoading(true);
      setConnectionsError("");
      const response = await authorizedFetch(`${apiUrl}/v1/me/${tab}`, {}, authUser);
      if (!response.ok) throw new Error("Connections unavailable");
      const payload = await response.json() as { profiles?: PublicPlayerProfile[] };
      setConnections(payload.profiles ?? []);
    } catch {
      setConnections([]);
      setConnectionsError("Could not load connections");
    } finally {
      setConnectionsLoading(false);
    }
  }

  async function viewPlayerProfile(playerId: string) {
    if (playerId === user?.uid) {
      setViewedProfile(null);
      setActiveTab("profile");
      return;
    }
    setProfileLoadingId(playerId);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/players/${playerId}`);
      if (!response.ok) throw new Error("Player profile unavailable");
      openPlayerProfile(await response.json() as PublicPlayerProfile);
    } catch {
      setToast("Could not load this player profile");
      window.setTimeout(() => setToast(""), 2600);
    } finally {
      setProfileLoadingId(null);
    }
  }

  function openPlayerProfile(playerProfile: PublicPlayerProfile) {
    setProfileLoadingId(null);
    setWorkspaceGroup(null);
    setViewedGroup(null);
    setConnectionsOpen(false);
    setProfileReturnTab(activeTab);
    setViewedProfile(playerProfile);
    setActiveTab("profile");
    window.history.replaceState({ courtMatePage: "home" }, "", `${window.location.pathname}${window.location.search}`);
    window.history.pushState({ courtMatePage: "player-profile" }, "", `#player-profile-${playerProfile.id}`);
  }

  function closePlayerProfile() {
    setViewedProfile(null);
    setActiveTab(profileReturnTab);
    if (window.location.hash.startsWith("#player-profile-")) window.history.back();
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

  async function toggleConnection(connection: PublicPlayerProfile) {
    if (!user || connection.id === user.uid) return;
    const wasFollowing = connection.is_following;
    try {
      setProfileLoadingId(`connection-${connection.id}`);
      const action = wasFollowing ? "unfollow" : "follow";
      const response = await authorizedFetch(`${apiUrl}/v1/players/${connection.id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error("Connection update failed");
      const updated = await response.json() as PublicPlayerProfile;
      setConnections((current) => connectionsTab === "following" && wasFollowing ? current.filter((item) => item.id !== connection.id) : current.map((item) => item.id === updated.id ? updated : item));
      setSocialProfile((current) => current ? { ...current, following_count: Math.max(0, current.following_count + (wasFollowing ? -1 : 1)) } : current);
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

  async function loadProfile(authUser: User = user as User) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me`, {}, authUser);
      if (!response.ok) throw new Error("Profile unavailable");
      const nextProfile = await response.json() as PlayerProfile;
      setProfile(nextProfile);
      const mostPlayedSport = sportOptions
        .filter((sport) => nextProfile.cmr_ratings?.[sport.value] != null)
        .sort((a, b) => (nextProfile.cmr_game_counts?.[b.value] ?? 0) - (nextProfile.cmr_game_counts?.[a.value] ?? 0))[0];
      const preferredSport = nextProfile.primary_sport ?? mostPlayedSport?.value ?? "pickleball";
      setSelectedSport(preferredSport);
      if (!cmrSetupAutoPromptedRef.current && (!nextProfile.primary_sport || nextProfile.self_assessed_levels?.[preferredSport] == null)) {
        cmrSetupAutoPromptedRef.current = true;
        const externalSuggestion = nextProfile.sport_ratings?.[preferredSport]
          ?? (preferredSport === "pickleball" ? nextProfile.dupr_rating ?? undefined : undefined);
        setCmrSetupSport(preferredSport);
        setCmrSetupLevel(externalSuggestion != null ? Math.round(cmrFromLegacySkillBand(externalSuggestion)) : 3);
      }
      setProfileDraft({ bio: nextProfile.bio ?? "", is_profile_private: nextProfile.is_profile_private ?? false, default_session_visibility: nextProfile.default_session_visibility ?? "public", area: nextProfile.area, age: nextProfile.age?.toString() ?? "", gender: nextProfile.gender ?? "", preferred_age_range: nextProfile.preferred_age_range ?? "any", preferred_genders: nextProfile.preferred_genders ?? [], latitude: nextProfile.latitude, longitude: nextProfile.longitude, travel_radius_km: nextProfile.travel_radius_km?.toString() ?? "10", style: nextProfile.style as ProfileDraft["style"], availability: nextProfile.availability ?? [] });
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
    activityRequestRef.current = null;
    setProfile(null);
    setCmrSetupSport(null);
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
      setToast("Profile preferences saved");
      closeUtilityPage();
    } catch {
      setToast("Could not save your profile preferences");
    }
  }

  function requestCmrSetup(sport: Sport) {
    const externalSuggestion = profile?.sport_ratings?.[sport]
      ?? (sport === "pickleball" ? profile?.dupr_rating ?? undefined : undefined);
    setCmrSetupSport(sport);
    setCmrSetupLevel(externalSuggestion != null ? Math.round(cmrFromLegacySkillBand(externalSuggestion)) : 3);
    setCmrSetupError("");
  }

  async function saveCmrSetup() {
    if (!user || !cmrSetupSport) return;
    const sport = cmrSetupSport;
    try {
      setCmrSetupSaving(true);
      setCmrSetupError("");
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport,
          self_assessed_level: cmrSetupLevel,
          primary_sport: profile?.primary_sport ?? sport,
        }),
      });
      const updated = await response.json().catch(() => ({})) as PlayerProfile & { detail?: string };
      if (!response.ok) throw new Error(updated.detail ?? "Could not save your starting level");
      setProfile(updated);
      setSelectedSport(sport);
      setCmrSetupSport(null);
      setToast(`${sportLabel(sport)} starting level saved. Complete ${CMR_VERIFICATION_GAME_THRESHOLD} confirmed games to verify your CMR.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save your starting level";
      setCmrSetupError(message);
      setToast(message);
    } finally {
      setCmrSetupSaving(false);
    }
  }

  async function saveBio(event: FormEvent) {
    event.preventDefault();
    if (!user) {
      setToast("Sign in with Google before updating your bio");
      return;
    }
    const bio = profileDraft.bio.trim();
    if (bio.length > 240) {
      setToast("Bio must be 240 characters or fewer");
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
    const shouldShowMessage = exact && requestQuery.trim().length > 0;
    const requestTimestamp = Date.now();
    if (shouldShowMessage) {
      setLastChatRequest(null);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-user`, role: "user", text: requestQuery.trim() }]);
      setQuery("");
    }
    setShowCreateGame(false);
    setShowCraftedGame(false);
    setLoading(true);
    setLoadingMessage(isPerformanceQuery(requestQuery) ? "Reading your CourtMate history..." : "Finding your best match...");
    const loadingTimer = window.setTimeout(() => setLoadingMessage(isPerformanceQuery(requestQuery) ? "Comparing your recent form..." : "Finding your best match..."), 420);
    try {
      if (isPerformanceQuery(requestQuery)) {
        const response = await authorizedFetch(`${apiUrl}/v1/me/performance-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: requestQuery }),
        }, authUser);
        const payload = await response.json().catch(() => ({})) as { answer?: string; detail?: string };
        if (!response.ok) throw new Error(payload.detail ?? "Performance coach is unavailable");
        setSessions([]);
        setGroupProposal(null);
        setSearchScope("performance");
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: payload.answer ?? "I could not read that performance question." }]);
        return;
      }
      const requestSport = sportFromText(requestQuery) ?? selectedSport;
      if (profile && profile.self_assessed_levels?.[requestSport] == null) {
        requestCmrSetup(requestSport);
        setToast(`Choose your ${sportLabel(requestSport)} level before matching games.`);
        return;
      }
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
      if (shouldStartCreation) setCreationStep(needsSport ? "sport" : "time");
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
          rating_mode: "casual",
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
        const firstStep = needsSport ? "sport" : "time";
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-creation-assistant`, role: "assistant", text: `I can create one around those requirements. ${creationQuestion(firstStep)}` }]);
      }
    } catch {
      setSessions([]);
      setGroupProposal(null);
      setGroupNameDraft("");
      setSearchScope("court_discovery");
      if (shouldShowMessage) {
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: "I couldn't reach the live game search. Please try again." }]);
      }
      setToast("Could not search live groups. Check that the API is running.");
    } finally {
      window.clearTimeout(loadingTimer);
      setLoading(false);
      setLoadingMessage("Finding your best match...");
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  function openCreateGame() {
    if (!user) {
      setToast("Sign in with Google before creating a game");
      return;
    }
    const sourceQuery = query.trim() || createQuery.trim();
    const explicitSport = sportFromText(sourceQuery);
    const requestSport = explicitSport ?? selectedSport;
    if (profile && profile.self_assessed_levels?.[requestSport] == null) {
      requestCmrSetup(requestSport);
      setToast(`Choose your ${sportLabel(requestSport)} level before creating a game.`);
      return;
    }
    const area = profile?.area || "Whitefield";
    const playerCmr = cmrForSport(requestSport);
    const cmrMin = clampCmr(playerCmr - 1.8);
    const cmrMax = clampCmr(playerCmr + 1.8);
    const nextProposal: GroupProposal = {
      group_name: `${area} ${sportLabel(requestSport)} Game`,
      sport: requestSport,
      area,
      session_date: localDateInput(),
      start_time: "19:00",
      end_time: "21:00",
      skill_min: skillBandFromCmr(cmrMin),
      skill_max: skillBandFromCmr(cmrMax),
      style: profile?.style ?? "casual",
      game_format: "doubles",
      capacity: 6,
      explanation: "Set the details for your game. CourtMate will keep the group organized and help you find compatible players.",
    };
    setSelectedSport(requestSport);
    setSessions([]);
    setGroupProposal(nextProposal);
    setGroupNameDraft(nextProposal.group_name);
    setShowCraftedGame(false);
    setShowCreateGame(false);
    const firstStep = explicitSport ? "time" : "sport";
    setCreationStep(firstStep);
    setCreateQuery(sourceQuery || `Create a ${sportLabel(requestSport)} game near ${area}`);
    setCreateGroupDraft({ sport: nextProposal.sport, area: nextProposal.area, session_date: nextProposal.session_date ?? localDateInput(), start_time: nextProposal.start_time ?? "19:00", end_time: nextProposal.end_time ?? "21:00", skill_min: nextProposal.skill_min.toString(), skill_max: nextProposal.skill_max.toString(), style: nextProposal.style as CreateGroupDraft["style"], rating_mode: "casual", game_format: nextProposal.game_format, capacity: nextProposal.capacity });
    setCreateGameVisibility(profile?.default_session_visibility ?? "public");
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-creation-assistant`, role: "assistant", text: `I can create a ${sportLabel(requestSport)} game. ${creationQuestion(firstStep)}` }]);
  }

  function toggleGamesForm() {
    if (!user) {
      setToast("Sign in with Google before creating a game");
      return;
    }
    if (showCreateGame) {
      setShowCreateGame(false);
      return;
    }
    const sport = selectedSport;
    if (profile && profile.self_assessed_levels?.[sport] == null) {
      requestCmrSetup(sport);
      setToast(`Choose your ${sportLabel(sport)} level before creating a game.`);
      return;
    }
    const area = profile?.area?.trim() || "";
    const playerCmr = cmrForSport(sport);
    const cmrMin = clampCmr(playerCmr - 1.8);
    const cmrMax = clampCmr(playerCmr + 1.8);
    const style: CreateGroupDraft["style"] = profile?.style === "social" || profile?.style === "competitive" ? profile.style : "casual";
    setGroupNameDraft(`${area || "Local"} ${sportLabel(sport)} Game`);
    setCreateGroupDraft({ sport, area, session_date: localDateInput(), start_time: "19:00", end_time: "21:00", skill_min: skillBandFromCmr(cmrMin).toString(), skill_max: skillBandFromCmr(cmrMax).toString(), style, rating_mode: "casual", game_format: "doubles", capacity: 6 });
    setCreateGameVisibility(profile?.default_session_visibility ?? "public");
    setShowCreateGame(true);
  }

  function cmrForSport(sport: Sport) {
    const currentCmr = profile?.cmr_ratings?.[sport];
    if (currentCmr != null) return clampCmr(currentCmr);
    const legacyRating = profile?.sport_ratings?.[sport] ?? (sport === "pickleball" ? profile?.dupr_rating ?? undefined : undefined);
    return legacyRating != null ? cmrFromLegacySkillBand(legacyRating) : 5;
  }

  function setCreateGroupCmrRange(minimum: number, maximum: number) {
    // Older buttons supplied a ±20 range. Treat that impossible 1-10 range
    // as a request for the current product default instead of widening it.
    const requestedWidth = Math.abs(maximum - minimum);
    const center = (minimum + maximum) / 2;
    const cmrMin = clampCmr(requestedWidth > 9 ? center - 1.8 : Math.min(minimum, maximum));
    const cmrMax = clampCmr(requestedWidth > 9 ? center + 1.8 : Math.max(minimum, maximum));
    setCreateGroupDraft((draft) => ({ ...draft, skill_min: skillBandFromCmr(cmrMin).toString(), skill_max: skillBandFromCmr(cmrMax).toString() }));
  }

  function creationQuestion(step = creationStep) {
    if (step === "sport") return "Which sport should I use? Pickleball, badminton, tennis, padel, squash, or table tennis?";
    if (step === "time") return "What day and time should I post it?";
    if (step === "area") return "Which area should I use? A neighbourhood is enough.";
    if (step === "skill") return "Who should this game be for? Beginner, intermediate, advanced, or a CMR range?";
    if (step === "vibe") return "What should the game feel like: casual, social, or competitive?";
    return "Here is the game plan. Ready to create it, or would you like to change something?";
  }

  function creationPlanLabel(draft = createGroupDraft) {
    const dateLabel = draft.session_date
      ? new Date(`${draft.session_date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
      : "Date to be decided";
    return `${sportLabel(draft.sport)} · ${dateLabel} · ${draft.start_time}–${draft.end_time} availability window · 1-hour game · ${draft.area || "Area to be decided"}`;
  }

  function creationQuickPrompts() {
    if (creationStep === "sport") return ["Pickleball", "Badminton", "Tennis", "Padel"];
    if (creationStep === "time") return ["Saturday at 8 AM", "Tomorrow at 7 PM", "Sunday at 9 AM"];
    if (creationStep === "area") return ["Use my saved area", "Near me"];
    if (creationStep === "skill") return ["Beginner", "Intermediate", "Advanced"];
    if (creationStep === "vibe") return ["Casual", "Social", "Competitive"];
    return ["Create this game", "Change time", "Change area"];
  }

  function formatCreationDate(value: Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseCreationReply(reply: string) {
    const lowered = reply.toLowerCase().trim();
    const nextDraft = { ...createGroupDraft };
    let changed = false;
    const detectedSport = sportFromText(reply);
    if (detectedSport) {
      nextDraft.sport = detectedSport;
      changed = true;
    }
    const style = ["casual", "social", "competitive"].find((value) => lowered.includes(value)) as CreateGroupDraft["style"] | undefined;
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
    const savedArea = profile?.area?.trim() || createGroupDraft.area.trim();
    const normalizedReply = reply.trim().replace(/[,.!?]+$/, "").trim();
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
      const reservedTerms = /\b(?:today|tomorrow|morning|afternoon|evening|tonight|beginner|intermediate|advanced|casual|social|competitive|pickleball|badminton|tennis|padel|squash|table tennis|ping pong)\b/i;
      const areaCandidate = normalizedReply.replace(/^(?:near|around|in)\s+/i, "").trim();
      if (areaCandidate.length >= 2 && areaCandidate.length <= 80 && !reservedTerms.test(areaCandidate)) {
        nextDraft.area = areaCandidate.replace(/\s+/g, " ");
        changed = true;
      }
    }
    return { nextDraft, changed };
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
    const { nextDraft, changed } = parseCreationReply(cleanReply);
    if (changed) {
      const previousGeneratedName = `${createGroupDraft.area || "Whitefield"} ${sportLabel(createGroupDraft.sport)} Game`;
      const nextGeneratedName = `${nextDraft.area || "Whitefield"} ${sportLabel(nextDraft.sport)} Game`;
      const nextGroupName = !groupNameDraft || groupNameDraft === previousGeneratedName ? nextGeneratedName : groupNameDraft;
      setCreateGroupDraft(nextDraft);
      setGroupNameDraft(nextGroupName);
      setGroupProposal((proposal) => proposal ? { ...proposal, group_name: nextGroupName, sport: nextDraft.sport, area: nextDraft.area, session_date: nextDraft.session_date, start_time: nextDraft.start_time, end_time: nextDraft.end_time, skill_min: Number(nextDraft.skill_min), skill_max: Number(nextDraft.skill_max), style: nextDraft.style } : proposal);
      const nextStep = creationStep === "sport" ? "time" : creationStep === "time" ? "area" : creationStep === "area" ? "skill" : creationStep === "skill" ? "vibe" : "confirm";
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
    setFeedbackSessionId(null);
    setFeedbackMembers([]);
    setFeedbackPickerOpen(pastGames.length > 0);
    setQuery("");
    setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-feedback-prompt`, role: "assistant", text: pastGames.length ? "Which completed game would you like to review?" : "You do not have a completed game to review yet. Play a game and I will collect feedback here." }]);
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
    if (prompt === "Log a score") {
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
    setQuery(prompt);
    void search(undefined, prompt);
  }

  function quickPrompts() {
    if (feedbackSessionId) return ["Great and fair", "It was okay", "Not for me"];
    if (feedbackPickerOpen) return ["Back to game search"];
    if (scoreSessionId) return ["Back to game search", "Create a game"];
    if (scorePickerOpen) return ["Back to game search"];
    const feedbackPrompt = pastGames.length ? ["Give game feedback"] : [];
    if (searchScope === "performance") return ["How is my CMR changing?", "What should I improve?", "Summarise my recent games", "Create a game", ...feedbackPrompt];
    if (groupProposal && !sessions.length) return creationQuickPrompts();
    if (sessions.length) return ["Show another option", "Make it more casual", "Only show games after 7 PM", "Create a game", ...(approvedGames.length ? ["Log a score"] : []), ...feedbackPrompt];
    return ["Find games around me", "This weekend", "Casual after work", "Create a game", ...(approvedGames.length ? ["Log a score"] : []), ...feedbackPrompt];
  }

  function handleChatSubmit(event: FormEvent) {
    event.preventDefault();
    if (!scoreSessionId && !feedbackSessionId && !groupProposal && requestSessionFromChat(query)) {
      return;
    }
    if (!scoreSessionId && !feedbackSessionId && /\b(?:feedback|review|rate)\b.*\b(?:game|match|session|player|group)\b/i.test(query)) {
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
    void search(undefined, query);
  }

  function changeCreateSport(sport: Sport) {
    if (profile && profile.self_assessed_levels?.[sport] == null) {
      requestCmrSetup(sport);
      return;
    }
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
    if (!user) {
      setToast("Sign in with Google before creating a group");
      return;
    }
    const today = localDateInput();
    if (!createGroupDraft.session_date || createGroupDraft.session_date < today) {
      setToast("Choose today or a future game date");
      return;
    }
    if (!createGroupDraft.start_time || !createGroupDraft.end_time) {
      setToast("Choose the start and end of your available time window");
      return;
    }
    if (createGroupDraft.end_time <= createGroupDraft.start_time) {
      setToast("Your available-until time must be after the available-from time");
      return;
    }
    const windowMinutes = (Number(createGroupDraft.end_time.slice(0, 2)) * 60 + Number(createGroupDraft.end_time.slice(3, 5))) - (Number(createGroupDraft.start_time.slice(0, 2)) * 60 + Number(createGroupDraft.start_time.slice(3, 5)));
    if (windowMinutes < 60) {
      setToast("Choose a window of at least one hour for the game");
      return;
    }
    if (createGroupDraft.session_date === today && createGroupDraft.start_time <= localTimeInput()) {
      setToast("Your available-from time must be in the future");
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
          time_window_start: createGroupDraft.start_time || undefined,
          time_window_end: createGroupDraft.end_time || undefined,
          duration_minutes: 60,
          skill_min: Number(createGroupDraft.skill_min),
          skill_max: Number(createGroupDraft.skill_max),
          style: createGroupDraft.style,
          rating_mode: createGroupDraft.rating_mode,
          game_format: createGroupDraft.game_format,
          capacity: createGroupDraft.game_format === "singles" ? 2 : createGroupDraft.capacity,
          visibility: createGameVisibility,
        }),
      });
      if (!response.ok) throw new Error("Unable to create group");
      const payload = await response.json() as { session: Omit<Session, "open_slots" | "score" | "explanation">; message: string };
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
      setShowCreateGame(false);
      setShowCraftedGame(false);
      setCreationStep("confirm");
      setManagedGroupId(createdSession.id);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-created-assistant`, role: "assistant", text: `${createdSession.group_name} is live. Head over to the Games tab to see it and manage requests.` }]);
      void loadGamesActivity(user, false, false, true);
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
      if (groupProposal) {
        if (Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).some(Boolean)) {
          void handleCreationReply(transcript);
        }
        return;
      }
      if (/\b(?:feedback|review|rate)\b.*\b(?:game|match|session|player|group)\b/i.test(transcript)) {
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
        headers: { "content-type": "application/json" },
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
        setMyRequests((requests) =>
          requests.some(({ request }) => request.id === payload.id || request.session_id === sessionId)
            ? requests
            : [{ request: payload, session: resolvedSession }, ...requests],
        );
      }
      setSessions((currentSessions) => currentSessions.filter((session) => session.id !== sessionId));
      setViewedGroup(null);

      if (redirectToPending) {
        setJustRequestedSessionId(sessionId);
        setActiveTab("games");
        setGamesViewTab("pending");
        window.setTimeout(() => {
          setJustRequestedSessionId((current) => (current === sessionId ? null : current));
        }, 7000);
      }

      const statusMessage =
        payload.status === "waitlisted"
          ? `You are on the waitlist for ${name}. I’ve saved your place and you can track it in Games → Pending.`
          : `Request sent to ${name}. The organizer needs to approve you. You can track it in Games → Pending.`;
      setChatMessages((messages) => [
        ...messages.slice(-8),
        { id: `${Date.now()}-join-confirmation`, role: "assistant", text: statusMessage },
      ]);
      setToast(payload.status === "waitlisted" ? `Waitlisted for ${name} · Track in Pending` : `Requested ${name} · Landed in Pending Games`);
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
      skill_min: group.skill_min,
      skill_max: group.skill_max,
      style: group.style,
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
    if (initial) {
      setWorkspaceGroup(initial.group);
      setGroupMembers(initial.members);
      setGroupWaitlist(initial.waitlist);
      setChatPosts(initial.posts);
    } else {
      setGroupMembers([]);
      setGroupWaitlist([]);
      setChatPosts([]);
    }
    setWorkspaceLoading(false);
    setChatDraft("");
    setPlayerRatings({});
    try {
      const chatPromise = authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/chat`, {}, authUser);
      const membersPromise = prefetchedGroup
        ? Promise.resolve<Response | null>(null)
        : authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/group`, {}, authUser);
      const [chatResponse, membersResponse] = await Promise.all([chatPromise, membersPromise]);
      if (!chatResponse.ok || (!prefetchedGroup && !membersResponse?.ok)) {
        if (chatResponse.status === 403 || membersResponse?.status === 403) throw new Error("Only confirmed players can open this Rally Circle");
        throw new Error("Rally Circle unavailable");
      }
      const chatPayload = await chatResponse.json() as { posts: ChatPost[] };
      const membersPayload = prefetchedGroup ?? await membersResponse!.json() as GroupView;
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
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not open this Rally Circle");
    }
  }

  async function markGroupDone(sessionId: string) {
    const finalizingFeedback = workspaceGroup?.id === sessionId && workspaceGroup.status === "awaiting_feedback";
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/complete`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as Session & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not mark this game done");
      setWorkspaceGroup(toActivityGroup(payload));
      groupSpaceCacheRef.current.delete(sessionId);
      invalidateSocialFeedCache();
      setToast(finalizingFeedback ? "Game completed and posted to Home." : "Game closed. Everyone can now add private player ratings.");
      void loadGamesActivity(user, false, false, true);
      void loadSocialProfile();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not mark this game done");
      throw error;
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
        request = authorizedFetch(`${apiUrl}/v1/me/activity`, {}, authUser)
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
      setMyRequests(payload.requests ?? []);
      setIncomingRequests(payload.incoming_requests ?? []);
      setMyGroups(payload.groups ?? []);
      setApprovedGames(payload.games ?? []);
      setAwaitingFeedbackGames(payload.awaiting_feedback ?? []);
      setPastGames((payload.past_games ?? []).filter((game) => game.session.status === "completed"));
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
    const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim();
    const publicOrigin = configuredOrigin || (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "https://court-mate-blr.vercel.app"
      : window.location.origin);
    const shareUrl = new URL("/home", publicOrigin);
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
      if (groupId === managedGroupId) await loadJoinRequests(groupId, false);
      await loadGamesActivity(user, false, true, true);
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
    if (tab === "communities") {
      setGamesViewTab("explore");
      tab = "games";
    }
    setActiveTab(tab);
    setViewedGroup(null);
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
    void loadNotifications();
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

  const requestedGames = myRequests.filter(({ request }) => request.status === "pending" || request.status === "waitlisted");
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
  const activeSports = sportOptions.filter((sport) => profile?.cmr_ratings?.[sport.value] != null || (profile?.cmr_game_counts?.[sport.value] ?? 0) > 0);
  const ratedSports = activeSports.filter((sport) => profile?.cmr_ratings?.[sport.value] != null);
  const mostPlayedSport = [...activeSports].sort((left, right) => (profile?.cmr_game_counts?.[right.value] ?? 0) - (profile?.cmr_game_counts?.[left.value] ?? 0))[0]?.value;
  const profileSelectedSport = profileSport && activeSports.some((sport) => sport.value === profileSport) ? profileSport : mostPlayedSport ?? "pickleball";
  const profileViewLabel = profileStatsSport ? sportLabel(profileStatsSport) : "All sports";
  const profileHistory = profileStatsSport
    ? profile?.cmr_history?.[profileStatsSport] ?? []
    : Object.entries(profile?.cmr_history ?? {}).flatMap(([sport, history]) => history.map((point) => ({ ...point, sport }))).sort((left, right) => left.session_date.localeCompare(right.session_date));
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
  const createPlayerCmr = cmrForSport(createGroupDraft.sport);

  function showToast(message: string) {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 2600);
  }

  return (
    <main className={`shell ${settingsOpen || notificationsOpen || calendarOpen || connectionsOpen || cmrDetailsOpen ? "utility-page-open" : ""} ${workspaceGroup || viewedGroup ? "detail-page-open" : ""} ${rankingGame ? "ranking-page-open" : ""}`}>
      <nav className="nav">
        <div className="brand" aria-label="CourtMate"><img className="brand-icon brand-logo-light" src="/courtmate-header-logo-light.png" alt="CourtMate" /><img className="brand-icon brand-logo-dark" src="/courtmate-header-logo-dark.png" alt="" aria-hidden="true" /></div>
        <div className="nav-right"><button className="about-link" onClick={() => { if (!user) document.querySelector(".guest-story")?.scrollIntoView({ behavior: "smooth" }); else selectTab("home"); }}>How it works</button><span className="location-pill"><span className="dot" /> Whitefield, Bengaluru</span><button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><ThemeIcon dark={theme === "dark"} /></button>{user ? <><button className={`settings-button ${settingsOpen ? "active" : ""}`} type="button" onClick={openSettings} aria-label="Open preferences" title="Preferences"><SettingsIcon /></button><div className="notification-wrap">
          <button className={`notification-button ${notificationsOpen ? "active" : ""}`} type="button" onClick={openNotifications} aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`} title="Notifications"><BellIcon />{unreadNotifications > 0 && <span className="notification-count">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
        </div><span className="user-name">{user.displayName ?? user.email}</span><button className="avatar" onClick={() => selectTab("profile")} title="Open profile">{profile?.profile_image_url ? <img src={profile.profile_image_url} alt="" /> : initials(user.displayName ?? user.email ?? "CourtMate")}</button></> : <button className="sign-in-button" onClick={() => void signIn()}>{authReady ? "Sign in with Google" : "Loading auth"}</button>}</div>
      </nav>
      {user && <span className="nav-streak" title={`${socialProfile?.weekly_streak ?? 0} week streak`} aria-label={`${socialProfile?.weekly_streak ?? 0} week streak`}><StreakFireIcon /><b>{socialProfile?.weekly_streak ?? 0}</b></span>}
      {user && <nav className="app-tabs" aria-label="CourtMate sections">
        <button className={activeTab === "social" ? "active" : ""} onClick={() => { setSocialFeedEntry("all"); selectTab("social"); }} title="Home"><span className="app-tab-icon"><HomeIcon /></span><span>Home</span></button>
        <button className={activeTab === "games" ? "active" : ""} onClick={() => selectTab("games")} title="Your games"><span className="app-tab-icon"><PickleballPaddleIcon /></span><span>Games</span></button>
        <button className={activeTab === "home" ? "active" : ""} onClick={() => selectTab("home")} title="Assistant"><span className="app-tab-icon"><ChatIcon /></span><span>Assistant</span></button>
        <button className={activeTab === "profile" ? "active" : ""} onClick={() => selectTab("profile")} title="Profile"><span className="app-tab-icon"><ProfileIcon /></span><span>Profile</span></button>
      </nav>}
      {!user && Boolean(activeTab === "games") && <nav className="app-tabs guest-app-tabs" aria-label="CourtMate discovery sections"><button className={activeTab === "home" ? "active" : ""} onClick={() => selectTab("home")} title="Welcome"><span className="app-tab-icon"><HomeIcon /></span><span>Welcome</span></button><button className={activeTab === "games" ? "active" : ""} onClick={() => selectTab("games")} title="Browse games"><span className="app-tab-icon"><MapIcon /></span><span>Browse games</span></button></nav>}
      {activeTab === "home" && !user && <section className="guest-home" aria-label="CourtMate introduction">
        <div className="guest-copy"><span className="eyebrow">PLAY BETTER TOGETHER</span><h1>Find a game.<br /><em>Find your people.</em></h1><p>CourtMate listens to how you want to play and finds groups that fit your pace, people, and place.</p><div className="guest-cta"><button className="guest-sign-in" type="button" onClick={() => void signIn()}>Continue with Google <span>↗</span></button><button className="guest-about" type="button" onClick={() => document.querySelector(".guest-story")?.scrollIntoView({ behavior: "smooth" })}>How it works</button></div><div className="guest-trust"><span>VOICE + TEXT</span><span>BETTER-FIT GROUPS</span><span>CMR BY PLAYING</span></div></div>
        <div className="guest-preview" aria-label="Example CourtMate conversation"><div className="guest-preview-top"><span>COURTMATE</span><span>AI GROUP CONCIERGE</span></div><div className="guest-preview-thread"><div className="guest-preview-message guest-preview-user">Intermediate tennis near Whitefield, Saturday morning. Social, not too serious.</div><div className="guest-preview-message guest-preview-assistant"><strong>3 groups worth a look</strong><span>Matched by skill, timing, distance, and group vibe.</span></div><div className="guest-preview-options"><div><span className="guest-preview-date">SAT · 8:00 AM</span><strong>Whitefield Rally</strong><small>4.6 CMR fit · 2 spots open</small></div><div><span className="guest-preview-date">SAT · 9:30 AM</span><strong>Easy Baseline</strong><small>4.2 CMR fit · 1 spot open</small></div></div><div className="guest-preview-footer"><span>See the group before you join</span><i>→</i></div></div></div>
        <div className="guest-story" aria-label="CourtMate features and benefits"><div className="guest-story-heading"><span className="eyebrow">MORE THAN A MATCH</span><h2>Your next game should feel easy to show up for.</h2><p>From the first “I’m free Saturday” to the post-match CMR update, CourtMate keeps the whole rally together.</p></div><div className="guest-feature-grid"><article><span>01</span><strong>Find your fit</strong><p>Search by sport, time, place, skill, and vibe. Get groups that match how you actually want to play.</p></article><article><span>02</span><strong>Keep it moving</strong><p>One Rally Circle for logistics, waitlists, lineup, chat, and a quick game finish.</p></article><article><span>03</span><strong>Build your CMR</strong><p>Private player feedback turns real games into a rating trajectory that gets better with every rally.</p></article><article><span>04</span><strong>Share the story</strong><p>Completed games become thoughtful Home updates with leaderboard movement and game moments.</p></article></div><div className="guest-social-proof"><div><b>6</b><span>court sports</span></div><div><b>1</b><span>easy Rally Circle</span></div><div><b>∞</b><span>rallies to grow through</span></div><div className="guest-social-links"><a href="https://www.instagram.com/courtmate.blr/" target="_blank" rel="noreferrer">Instagram ↗</a><a href="mailto:courtmate.blr@gmail.com">Say hello</a></div></div></div>
        <button className="guest-about guest-browse-games" type="button" onClick={() => selectTab("games")}>Browse nearby games <span>→</span></button>
      </section>}
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
          {!loading && <div className="chat-quick-replies" aria-label="Suggested replies">{quickPrompts().map((prompt) => <button type="button" key={prompt} onClick={() => prompt === "Create this game" ? openCreateGame() : sendQuickPrompt(prompt)}>{prompt}</button>)}</div>}
        </div>
        {joiningSessionId && <div className="chat-request-sending" role="status">Sending your request to the group...</div>}
        <form className="chat-input-shell" onSubmit={handleChatSubmit}><div className="chat-input-label"><span className="chat-message-mark">{initials(user?.displayName ?? "You")}</span><span>{feedbackSessionId ? "Tell me how the game felt" : scoreSessionId ? "Say who played and the score" : showCraftedGame ? "Tell me what to change, or post this game" : "Describe your next game or ask about your performance"}</span></div><div className="chat-input-row"><label className="chat-attach-action" aria-label="Attach wearable screenshot" title="Attach a wearable screenshot"><input type="file" accept="image/jpeg, image/png, image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachPerformanceScreenshot(file); event.currentTarget.value = ""; }} /><span>+</span></label><input value={query} placeholder={feedbackSessionId ? "Great, fair, or not for me" : scoreSessionId ? "e.g. Rhea beat Ananya 11 to 8" : showCraftedGame ? "Change the time, area, level, or vibe" : "Ask for a game or performance"} onChange={(event) => { setQuery(event.target.value); const detectedSport = sportFromText(event.target.value); if (detectedSport) selectDetectedSport(detectedSport); }} aria-label="Describe the game you want to find or ask about performance" /><button type="button" className={`mic ${isListening ? "listening" : ""}`} onClick={startVoice} aria-label={isListening ? "Listening" : "Search by voice"} title={isListening ? "Listening" : "Search by voice"}><MicrophoneIcon /></button><button className="chat-send-action" type="submit" disabled={loading || !query.trim()} aria-label="Send message">{loading ? "..." : "↗"}</button></div></form>
      </section>
      {scorePickerOpen && <div className="home-score-picker" aria-label="Choose an active game to score"><div className="home-score-picker-heading"><span className="eyebrow">{scorePickerSport ? `YOUR ${sportLabel(scorePickerSport).toUpperCase()} GAMES` : "CHOOSE AN ACTIVE GAME"}</span><button type="button" onClick={() => { setScorePickerOpen(false); setScorePickerSport(null); }} aria-label="Close score picker">×</button></div>{visibleScoreGames.length ? visibleScoreGames.map((game) => <button className="home-score-session" type="button" key={game.id} onClick={() => chooseScoreSession(game)}><span className="date-badge"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(game.session_date).getDate()}</small></span><span><strong>{game.group_name}</strong><small>{sportLabel(game.sport)} · {game.start_time}–{game.end_time} · {game.area}</small></span><b>→</b></button>) : <p className="home-score-empty">No active {scorePickerSport ? `${sportLabel(scorePickerSport)} ` : ""}games found yet.</p>}</div>}
      {feedbackPickerOpen && <div className="home-score-picker" aria-label="Choose a completed game for feedback"><div className="home-score-picker-heading"><span className="eyebrow">REVIEW A GAME</span><button type="button" onClick={() => setFeedbackPickerOpen(false)} aria-label="Close feedback picker">×</button></div>{pastGames.map((pastGame) => <button className="home-score-session" type="button" key={pastGame.session.id} onClick={() => void chooseFeedbackSession(pastGame)}><span className="date-badge"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(pastGame.session.session_date).getDate()}</small></span><span><strong>{pastGame.session.group_name}</strong><small>{sportLabel(pastGame.session.sport)} · {pastGame.session.start_time}–{pastGame.session.end_time} · {pastGame.session.area}</small></span><b>→</b></button>)}</div>}
      </>}

      {activeTab === "social" && user && <SocialFeed apiUrl={apiUrl} currentUserId={user.uid} currentUserName={user.displayName ?? user.email ?? "CourtMate player"} currentProfileImage={profile?.profile_image_url} initialFilter={socialFeedEntry} authorizedFetch={authorizedFetch} onToast={showToast} onViewProfile={(playerId) => void viewPlayerProfile(playerId)} />}

      {activeTab === "games" && <section className="page-view games-page">
        <button type="button" className="section-fab games-fab" onClick={toggleGamesForm} aria-label={showCreateGame ? "Close game form" : "Create a game"} title={showCreateGame ? "Close" : "Create a game"}>{showCreateGame ? "×" : "+"}</button>
        {showCreateGame && <div className="game-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreateGame(false); }}><form className="game-create-form" onSubmit={(event) => { event.preventDefault(); void createGroup(); }}><div className="game-create-heading"><div><span className="kicker">NEW GAME</span><h2>Create a game</h2></div><span>Fill in the details</span><label className="game-create-visibility"><span>Who can join?</span><select value={createGameVisibility} onChange={(event) => setCreateGameVisibility(event.target.value as SessionVisibility)}><option value="public">Discoverable on Explore</option><option value="followers">Followers can discover</option><option value="private">Private link only</option></select></label><button className="game-create-close" type="button" onClick={() => setShowCreateGame(false)} aria-label="Close create game form">×</button></div><div className="game-create-grid"><label className="game-create-wide"><span>Game name</span><input value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} placeholder="Whitefield Saturday Rally" required /></label><label><span>Sport</span><select value={createGroupDraft.sport} onChange={(event) => changeCreateSport(event.target.value as Sport)}>{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label><label><span>Area</span><input value={createGroupDraft.area} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, area: event.target.value })} placeholder="Any neighbourhood" required /></label><label><span>Date</span><input type="date" min={localDateInput()} value={createGroupDraft.session_date} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, session_date: event.target.value })} required /></label><label><span>Available from</span><input type="time" value={createGroupDraft.start_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, start_time: event.target.value })} required /></label><label><span>Available until</span><input type="time" value={createGroupDraft.end_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, end_time: event.target.value })} required /></label><div className="game-create-wide game-create-time-note"><strong>1-hour game</strong><span>Players vote on the final time in the Rally Circle after they join.</span></div><div className="cmr-range-field game-create-wide"><div className="cmr-range-heading"><div><span>Preferred player CMR</span><strong>{createCmrMin.toFixed(2)}–{createCmrMax.toFixed(2)}</strong></div><button type="button" onClick={() => setCreateGroupCmrRange(createPlayerCmr - 1.8, createPlayerCmr + 1.8)}>Use my CMR</button></div><p>Current {sportLabel(createGroupDraft.sport)} CMR: <strong>{createPlayerCmr.toFixed(2)}</strong>. The default range is CMR ±1.8; adjust either end below.</p><div className="cmr-range-sliders"><span className="cmr-range-value cmr-range-value-min">From <b>{createCmrMin.toFixed(2)}</b></span><span className="cmr-range-value cmr-range-value-max">To <b>{createCmrMax.toFixed(2)}</b></span><input className="cmr-range-input cmr-range-input-min" type="range" min="1" max="10" step="0.01" value={createCmrMin} onChange={(event) => setCreateGroupCmrRange(Number(event.target.value), createCmrMax)} aria-label="Minimum player CMR" /><input className="cmr-range-input cmr-range-input-max" type="range" min="1" max="10" step="0.01" value={createCmrMax} onChange={(event) => setCreateGroupCmrRange(createCmrMin, Number(event.target.value))} aria-label="Maximum player CMR" /></div></div><label><span>Match type</span><select value={createGroupDraft.game_format} onChange={(event) => changeGameFormat(event.target.value as CreateGroupDraft["game_format"])}><option value="singles">Singles</option><option value="doubles">Doubles</option></select></label><label><span>Total player slots</span><select value={createGroupDraft.capacity} onChange={(event) => setCreateGroupDraft((draft) => ({ ...draft, capacity: Number(event.target.value) }))} disabled={createGroupDraft.game_format === "singles"}>{(createGroupDraft.game_format === "singles" ? [2] : [4, 6, 8]).map((capacity) => <option value={capacity} key={capacity}>{capacity} players</option>)}</select><small className="game-create-hint">{createGroupDraft.game_format === "singles" ? "One opponent plus you." : "Includes you. Six players is the usual doubles rally."}</small></label><label><span>Game mood</span><select value={createGroupDraft.style} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, style: event.target.value as CreateGroupDraft["style"] })}><option value="casual">Casual</option><option value="social">Social</option><option value="competitive">Competitive</option></select></label><label className="game-create-wide"><span>CMR impact</span><select value={createGroupDraft.rating_mode} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, rating_mode: event.target.value as CreateGroupDraft["rating_mode"] })}><option value="casual">Casual - no CMR change</option><option value="competitive">Competitive - confirmed results update CMR</option></select><small className="game-create-hint">{createGroupDraft.rating_mode === "competitive" ? "Players must confirm a valid final score after the game." : "The game still counts for attendance, streaks, and community quality."}</small></label></div><div className="game-create-actions"><button className="dark-button" type="submit" disabled={createGroupLoading}>{createGroupLoading ? "Creating..." : "Create game"}<span>→</span></button><button className="text-button" type="button" onClick={() => setShowCreateGame(false)}>Cancel</button></div></form></div>}
        <div className="tournament-tabs" role="tablist" aria-label="Game views"><button className={gamesViewTab === "explore" ? "active" : ""} onClick={() => { setGamesViewTab("explore"); void loadExploreGames(); }}>Explore <span>{exploreGames.length}</span></button><button className={gamesViewTab === "upcoming" ? "active" : ""} onClick={() => setGamesViewTab("upcoming")}>My games <span>{upcomingGames.length}</span></button><button className={gamesViewTab === "pending" ? "active" : ""} onClick={() => setGamesViewTab("pending")} aria-label="Pending Requests">Pending <span>{requestedGames.length}</span></button><button className={gamesViewTab === "awaiting_feedback" ? "active" : ""} onClick={() => setGamesViewTab("awaiting_feedback")} aria-label="Awaiting feedback">Feedback <span>{awaitingFeedbackGames.length}</span></button></div>
        {gamesViewTab === "explore" && <div className="explore-filters" aria-label="Filter games"><label className="explore-filter-search"><span>Search games</span><input value={exploreSearchDraft} onChange={(event) => setExploreSearchDraft(event.target.value)} placeholder="Name, sport, or area" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyExploreFilters(); } }} /></label><label><span>Sport</span><select value={exploreSportFilter} onChange={(event) => setExploreSportFilter(event.target.value as Sport | "all")}><option value="all">All sports</option>{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label><label><span>Skill level (CMR)</span><select value={exploreCmrFilter} onChange={(event) => setExploreCmrFilter(event.target.value as ExploreCmrFilter)}><option value="all">Any CMR</option><option value="beginner">Beginner · 0–34</option><option value="intermediate">Intermediate · 35–64</option><option value="advanced">Advanced · 65–100</option></select></label><label><span>Availability</span><select value={exploreTimeFilter} onChange={(event) => setExploreTimeFilter(event.target.value as ExploreTimeFilter)}><option value="all">Any time</option><option value="morning">Morning · 12 AM–9 AM</option><option value="day">Day · 9 AM–4 PM</option><option value="evening">Evening · 4 PM–9 PM</option><option value="night">Night · 9 PM–12 AM</option></select></label><label><span>Date</span><input type="date" value={exploreDateFilter} onChange={(event) => setExploreDateFilter(event.target.value)} /></label><button type="button" className="explore-filter-search-button" onClick={applyExploreFilters}>See results</button><button type="button" className="explore-filter-reset" onClick={() => { setExploreSearchDraft(""); setExploreSearch(""); setExploreSportFilter("all"); setExploreDateFilter(""); setExploreCmrFilter("all"); setExploreTimeFilter("all"); setExploreSportApplied("all"); setExploreDateApplied(""); setExploreCmrApplied("all"); setExploreTimeApplied("all"); }} disabled={!exploreSearch && exploreSportApplied === "all" && !exploreDateApplied && exploreCmrApplied === "all" && exploreTimeApplied === "all"}>Reset</button></div>}
        {gamesViewTab === "explore" && <div className="game-list">{exploreLoading ? <TennisBallLoader label="Finding nearby games" /> : filteredExploreGames.length ? filteredExploreGames.map((game) => <article className="game-row" key={game.id}><div className="game-date"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p><small className="waitlist-summary">{Math.round(game.score * 100)}% match · {game.open_slots} spot{game.open_slots === 1 ? "" : "s"} open</small></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void viewGroup(game.id)} disabled={loadingGroupId === game.id}>{loadingGroupId === game.id ? "Loading..." : "View group"}</button><button className="copy-link-button" onClick={() => void copyGroupSpaceLink(game)} aria-label={`Copy ${game.group_name} link`} title="Copy share link"><CopyIcon /><span>Copy link</span></button><button className="game-share-button" onClick={() => void shareGame(game)} aria-label={`Share ${game.group_name}`}>Share <span>↗</span></button><button className="join-button" onClick={() => void joinSession(game.id, game.group_name, game.organizer_id)} disabled={joiningSessionId !== null}>{joiningSessionId === game.id ? "Requesting..." : "Request to join"}<span>→</span></button></div></article>) : <div className="page-empty"><strong>No games match these filters.</strong><p>Try widening the sport, CMR, date, or availability filters.</p><button className="dark-button" onClick={() => { setExploreSportFilter("all"); setExploreDateFilter(""); setExploreCmrFilter("all"); setExploreTimeFilter("all"); setExploreSportApplied("all"); setExploreDateApplied(""); setExploreCmrApplied("all"); setExploreTimeApplied("all"); }}>Clear filters <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "upcoming" && <div className="game-list">{upcomingGames.length ? upcomingGames.map((game) => { const owned = myGroups.some((group) => group.id === game.id); const groupRequests = incomingRequests.filter(({ session }) => session.id === game.id); const waitlistCount = game.waitlist_player_ids?.length ?? 0; return <article className="game-row upcoming-game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p><small className="waitlist-summary">{waitlistCount ? `${waitlistCount} player${waitlistCount === 1 ? "" : "s"} on waitlist` : "Waitlist empty"}</small></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="copy-link-button" onClick={() => void copyGroupSpaceLink(game)} aria-label={`Copy ${game.group_name} link`} title="Copy share link"><CopyIcon /><span>Copy link</span></button><button className="game-share-button" onClick={() => void shareGame(game)} aria-label={`Share ${game.group_name}`}>Share <span>↗</span></button>{owned && <button className="manage-group-button" onClick={() => { if (managedGroupId === game.id) { setManagedGroupId(null); setJoinRequests([]); } else { setManagedGroupId(game.id); void loadJoinRequests(game.id); } }}>{managedGroupId === game.id ? "Hide requests" : `${groupRequests.length ? `${groupRequests.length} ` : ""}Review requests`}</button>}{!owned && <><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></>}</div>{managedGroupId === game.id && <div className="inline-request-list">{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved", game.id)}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined", game.id)}>Decline</button></div>}</div>) : <p className="request-empty">No requests waiting for approval.</p>}</div>}</article>; }) : <div className="page-empty"><strong>No upcoming games yet.</strong><p>Join a nearby game or create a game from Home.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "pending" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className={`game-row ${justRequestedSessionId === session.id ? "just-landed" : ""}`} key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><div className="game-row-title-row"><h2>{session.group_name}</h2>{justRequestedSessionId === session.id && <span className="just-landed-badge" role="status">✨ Just landed in Pending</span>}</div><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p><small className="waitlist-summary">{request.status === "waitlisted" ? "On waitlist" : "Waiting for organizer approval"}</small></div><div className="game-row-actions game-row-status-actions"><span className={`status-badge game-row-status ${request.status}`} role="status"><i aria-hidden="true" />{request.status === "waitlisted" ? "Waitlisted" : "Pending"}</span><button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name, request.id)} disabled={leavingGameId === session.id}>{leavingGameId === session.id ? "Withdrawing..." : request.status === "waitlisted" ? "Leave waitlist" : "Withdraw request"}</button></div></article>) : <div className="page-empty"><strong>No pending requests.</strong><p>Games you request will stay here until the organizer approves them.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "awaiting_feedback" && <div className="game-list">{awaitingFeedbackGames.length ? awaitingFeedbackGames.map((game) => <article className="game-row awaiting-feedback-row" key={game.id}><div className="game-date completed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.area}</p><small className="waitlist-summary">Game ended. Rate every other player to update CMR.</small></div><div className="game-row-actions game-row-status-actions"><span className="status-badge awaiting_feedback" role="status"><i aria-hidden="true" />Awaiting feedback</span><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Rate lineup <span>→</span></button><button className="feedback-reminder-button" type="button" onClick={() => setToast(`Reminder set for feedback on ${game.group_name}.`)}>Remind me</button></div></article>) : <div className="page-empty"><strong>No games awaiting feedback.</strong><p>After a game ends, it will appear here until everyone submits private ratings.</p></div>}</div>}
        {!activityLoading && gamesViewTab === "history" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions game-row-status-actions"><span className="status-badge game-row-status completed" role="status"><i aria-hidden="true" />Game done</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No history yet.</strong><p>Played games and your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {activityLoading && gamesViewTab !== "explore" && <TennisBallLoader label="Refreshing games" />}
        {!activityLoading && gamesViewTab === "past" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions"><span className="status-badge completed">Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No past games yet.</strong><p>Once a completed game has been played, your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "requested" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><span className={`status-badge ${request.status}`}>{request.status}</span>{["pending", "waitlisted"].includes(request.status) && <button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name, request.id)}>{request.status === "waitlisted" ? "Leave waitlist" : "Withdraw request"}</button>}</div></article>) : <div className="page-empty"><strong>No open requests.</strong><p>Confirmed games live in the Confirmed tab. New requests will appear here until the organizer responds.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "confirmed" && <div className="game-list">{approvedGames.length ? approvedGames.map((game) => <article className="game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></div></article>) : <div className="page-empty"><strong>No confirmed games yet.</strong><p>Once an organizer accepts your request, the game will appear here ready for your calendar.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "incoming" && <div className="game-list">{incomingRequests.length ? incomingRequests.map(({ request, session }) => <article className="game-row incoming-request-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{request.player_display_name ?? request.player_id.slice(0, 10)} wants to join</h2><p>{session.group_name} · {sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void decideJoinRequest(request.id, "approved", session.id)}>Approve</button><button className="leave-game-button" onClick={() => void decideJoinRequest(request.id, "declined", session.id)}>Decline</button></div></article>) : <div className="page-empty"><strong>No incoming requests.</strong><p>When someone requests to join one of your groups, you can approve them here.</p><button className="dark-button" onClick={() => { selectTab("home"); openCreateGame(); }}>Create a game <span>→</span></button></div>}</div>}
        {myGroups.length > 0 && <div className="organizer-page-card"><div><span className="kicker">ORGANIZER</span><h2>Your groups</h2><p>Manage requests, chat, and feedback for groups you created.</p></div>{myGroups.map((group) => <div className="organizer-page-row" key={group.id}><div><strong>{group.group_name}</strong><small>{sportLabel(group.sport)} · {group.session_date} · {group.confirmed_player_ids.length}/{group.capacity} players</small></div><div className="organizer-page-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(group)}>Group space</button><button className="manage-group-button" onClick={() => { setManagedGroupId(group.id); void loadJoinRequests(group.id); }}>Requests</button></div></div>)}{managedGroupId && <div className="request-card page-request-card"><p>Requests for <strong>{myGroups.find((group) => group.id === managedGroupId)?.group_name ?? "your group"}</strong>. Approve a player before they join.</p>{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? <div className="request-list">{joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved")}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined")}>Decline</button></div>}</div>)}</div> : <p className="request-empty">No requests waiting for approval.</p>}</div>}</div>}
      </section>}

      {activeTab === "games" && gamesViewTab === "explore" && (
        <CommunityHub
          apiUrl={apiUrl}
          authorizedFetch={discoveryFetch}
          currentCmr={profile?.cmr_ratings?.[selectedSport]}
          gamesLogged={profile?.cmr_game_counts?.[selectedSport] ?? 0}
          requestedSessionIds={myRequests
            .filter(({ request }) => request.status === "pending" || request.status === "waitlisted")
            .map(({ request }) => request.session_id)}
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
          isGuest={!user}
          onSignIn={() => void signIn()}
          initialLatitude={profile?.latitude}
          initialLongitude={profile?.longitude}
          initialArea={profile?.area}
        />
      )}

      {activeTab === "profile" && !viewedProfile && !cmrDetailsOpen && <section className="page-view profile-page">
        {user && profile && <section className="player-profile-hero">
          <div className="player-profile-identity">
            <div className="profile-photo-avatar profile-avatar-editor player-profile-avatar">{profile.profile_image_url ? <img src={profile.profile_image_url} alt={`${profile.display_name} profile`} /> : initials(profile.display_name)}<label className="profile-avatar-edit" title="Change profile photo"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProfilePicture(file); event.currentTarget.value = ""; }} disabled={profilePictureUploading} /><span aria-hidden="true">{profilePictureUploading ? "..." : "✎"}</span></label></div>
            <div className="player-profile-copy"><span className="kicker">PLAYER CARD</span><h1>{profile.display_name}</h1><p><span className="player-profile-presence" />{profile.area || "Set your locality"} · {profile.style} player<button className="profile-bio-pencil" type="button" onClick={() => { setProfileDraft((draft) => ({ ...draft, bio: profile.bio ?? "" })); setBioEditing(true); }} aria-label="Edit bio" title="Edit bio">✎</button></p>{bioEditing ? <form className="profile-bio-inline-editor" onSubmit={saveBio}><textarea value={profileDraft.bio} onChange={(event) => setProfileDraft((draft) => ({ ...draft, bio: event.target.value }))} maxLength={240} placeholder="Add a short bio" autoFocus /><button className="dark-button" type="submit" disabled={bioSaving}>{bioSaving ? "Saving..." : "Save"}</button><button className="profile-bio-cancel" type="button" onClick={() => setBioEditing(false)}>Cancel</button></form> : <small className="profile-bio-line">{profile.bio?.trim() || "Add a short bio to let your next group know your game."}</small>}</div>
            {socialProfile && <div className="player-profile-connections" aria-label="Your connections"><button type="button" onClick={() => openConnections("followers")}><b>{socialProfile.followers_count}</b><small>Followers</small></button><button type="button" onClick={() => openConnections("following")}><b>{socialProfile.following_count}</b><small>Following</small></button></div>}
          </div>
          <details className="cmr-glossary"><summary>How {sportLabel(profileSelectedSport)} CMR is calculated</summary><div className="cmr-glossary-copy"><p><strong>CMR means CourtMate Rating.</strong> It is a separate 1.00–10.00 skill signal for each sport. You choose a whole-number starting level, then only completed competitive games with a confirmed final score can change it.</p><section className="cmr-glossary-section"><h3>What moves CMR</h3><dl><div><dt>Starting point</dt><dd>Your confirmed 1–10 sport level is your CMR starting point. A supported linked rating can suggest a level, but never replaces your selection.</dd></div><div><dt>Teams and opponents</dt><dd>We compare the combined strength of both sides, so stronger partners and stronger opponents are part of the expected result.</dd></div><div><dt>Result and score margin</dt><dd>A win, loss, or draw is compared with that expectation. The final score adds a small bounded margin adjustment; it never overwhelms the result.</dd></div><div><dt>Player confirmation</dt><dd>Every player named in the two sides must confirm the score in the Rally Circle. A disputed or incomplete score cannot affect CMR.</dd></div></dl></section><section className="cmr-glossary-section"><h3>Why new ratings move more</h3><dl><div><dt>CMR confidence</dt><dd>Confidence builds only through confirmed competitive results. Early games can move CMR more; as the record grows, the same result makes a smaller change.</dd></div><div><dt>One result per game</dt><dd>CourtMate replays confirmed results in date order. Posting feedback again does not create a second CMR change.</dd></div></dl></section><section className="cmr-glossary-section cmr-glossary-exclusions"><h3>Not part of CMR</h3><p>Casual games, locality, followers, streaks, private player feedback, match quality, fun, fairness, attendance, and reliability do not directly change CMR. They are used separately for trust, community quality, or recommendations.</p></section><small>CMR is a CourtMate compatibility signal, not an official DUPR or tournament ranking.</small></div></details>
          <div className="player-profile-metrics"><span><b>{totalGames}</b><small>Games</small></span>{socialProfile && <span className={`player-profile-streak ${socialProfile.weekly_streak_active ? "active" : "at-risk"}`} title={socialProfile.weekly_streak_active ? "You completed a game this week." : "Complete a game this week to start a streak."}><i className="player-profile-streak-fire" aria-hidden="true"><StreakFireIcon /></i><b>{socialProfile.weekly_streak}</b><small>Weekly streak</small></span>}<span><b>{Math.round(profile.reliability * 100)}%</b><small>Reliable</small></span></div>
        </section>}
        {user && profile && <ProfileSportOverview profile={profile} sports={activeSports} selectedSport={profileStatsSport} onSelect={(sport) => { setProfileStatsSport(sport); setProfileSport(sport); }} />}
        {user && profile && totalGames === 0 && <section className="profile-cmr-setup-card" aria-labelledby="profile-cmr-setup-title"><div><span className="kicker">SKILL LEVEL</span><h2 id="profile-cmr-setup-title">Set your level by sport</h2><p>Choose a simple 1–10 starting point. Confirmed game results make your CMR more precise over time.</p></div><div className="profile-cmr-setup-action"><select value={profileSelectedSport} onChange={(event) => setProfileSport(event.target.value as Sport)} aria-label="Choose sport to set level">{sportOptions.map((sport) => <option key={sport.value} value={sport.value}>{sport.label}</option>)}</select><button type="button" className="dark-button" onClick={() => requestCmrSetup(profileSelectedSport)}>Set {sportLabel(profileSelectedSport)} level <span>→</span></button></div></section>}
        {user && profile && <section className={`profile-insights ${profileStatsSport ? "sport-focused" : "all-sports"}`}>
          {!ratedSports.length && <div className="cmr-no-ratings"><strong>Choose a sport level to begin.</strong><span>Your confirmed 1–10 level becomes the starting CMR for that sport.</span></div>}
          {socialProfile && <div className="social-stats"><button type="button" onClick={() => openConnections("followers")}><strong>{socialProfile.followers_count}</strong><span>Followers</span></button><button type="button" onClick={() => openConnections("following")}><strong>{socialProfile.following_count}</strong><span>Following</span></button><span><strong>{Math.round(profile.reliability * 100)}%</strong><span>Reliability</span></span></div>}
          {!profileStatsSport && <section className="profile-cumulative-overview" aria-label="All sports summary"><div><span className="kicker">ALL SPORTS</span><h2>Your CourtMate overview</h2><p>Cumulative progress across every sport. Select a sport above for its detailed CMR trajectory.</p></div><div className="profile-cumulative-metrics"><span><strong>{totalGames}</strong><small>Games played</small></span><span><strong>{activeSports.length}</strong><small>Sports played</small></span><span><strong>{Math.round(profile.reliability * 100)}%</strong><small>Reliability</small></span><span><strong>{currentCmr?.toFixed(2) ?? "--"}</strong><small>Overall CMR</small></span></div></section>}
          {ratedSports.length > 0 && <><p className="cmr-summary">Current {sportLabel(profileSelectedSport)} CMR: <strong>{currentCmr?.toFixed(2) ?? "not built"} / 10.00</strong><span>{currentCmr ? ` · ${cmrLevelForRating(currentCmr)}` : " · Choose a starting level"}</span></p>{profileHistory.length ? <><div className="cmr-chart-heading"><div><span className="kicker">CMR JOURNEY · {sportLabel(profileSelectedSport).toUpperCase()}</span><h2>Rating trajectory</h2></div><span>{profileHistory.length} game{profileHistory.length === 1 ? "" : "s"}</span></div><div className="cmr-chart"><svg viewBox="0 0 560 190" role="img" aria-label={`CMR trend for ${sportLabel(profileSelectedSport)}`}><line x1="28" y1="28" x2="28" y2="162" /><line x1="28" y1="162" x2="532" y2="162" /><polyline points={cmrGraphPoints(profileHistory)} fill="none" /><g>{profileHistory.filter((point) => point.rating != null).map((point, index, ratedHistory) => { const x = ratedHistory.length === 1 ? 280 : 28 + (index * 504) / (ratedHistory.length - 1); const y = 162 - ((clampCmr(point.rating ?? 1) - 1) * 134) / 9; return <circle key={point.session_id} cx={x} cy={y} r="5"><title>{`${point.group_name}: ${(point.rating ?? 0).toFixed(2)} CMR (${(point.delta ?? 0) >= 0 ? "+" : ""}${(point.delta ?? 0).toFixed(2)})`}</title></circle>; })}</g></svg><div className="cmr-chart-scale"><span>10.00</span><span>1.00</span></div></div><div className="cmr-history-list">{profileHistory.slice().reverse().map((point) => <article className="cmr-history-row" key={point.session_id}><div><strong>{point.group_name}</strong><small>{point.session_date} · {point.game_rating != null ? `game rating ${point.game_rating.toFixed(2)} / 10` : "awaiting player feedback"}</small></div><div>{point.rating != null ? <b>{point.rating.toFixed(2)}</b> : <b>--</b>}{point.delta != null ? <span className={`cmr-history-change ${point.delta >= 0 ? "positive" : "negative"}`}><span aria-hidden="true">{point.delta > 0 ? "↑" : point.delta < 0 ? "↓" : "•"}</span>{point.delta >= 0 ? "+" : ""}{point.delta.toFixed(2)}</span> : <span className="cmr-history-change pending"><span aria-hidden="true">•</span>Pending</span>}</div></article>)}</div></> : <div className="profile-empty-insight"><strong>Your {sportLabel(profileSelectedSport)} CMR starts at your selected level.</strong><p>Confirmed competitive results add movement here; casual games do not change CMR.</p></div>}</>}</section>}
        {!user && <div className="page-empty"><strong>Sign in to manage your profile.</strong><p>Your rating and preferences are saved securely to your CourtMate profile.</p><button className="dark-button" onClick={() => void signIn()}>Sign in with Google <span>→</span></button></div>}
        {user && profile && <form id="profile-preferences" className="profile-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Locality label</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation}>{profileDraft.latitude != null && profileDraft.longitude != null ? "Location saved" : "Use my current location"}<span>⌖</span></button></label></div><label><span>How do you like to play?</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>When are you usually available?</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save profile <span>→</span></button></div><div className="profile-sign-out"><span>Done playing for now?</span><button type="button" onClick={() => void signOutUser()}>Sign out</button></div></form>}
      </section>}

      {cmrDetailsOpen && user && profile && <section className="utility-page cmr-details-page" aria-labelledby="cmr-details-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Back to profile">←</button><div><span className="kicker">COURTMATE RATING</span><h1 id="cmr-details-title">How CMR works</h1><p>A clearer skill signal for every sport you play.</p></div></div><div className="cmr-details-content"><div className="cmr-details-score"><span>{sportLabel(profileSelectedSport)} CMR</span><strong>{currentCmr?.toFixed(2) ?? "--"}</strong><small>{currentCmrGames} confirmed game{currentCmrGames === 1 ? "" : "s"}</small></div><p><strong>CMR means CourtMate Rating.</strong> It starts with your simple 1–10 level, then becomes more precise as confirmed competitive games are played.</p><section><h2>What affects your rating</h2><dl><div><dt>Starting level</dt><dd>Your selected level is the starting point for that sport.</dd></div><div><dt>Opponent and team strength</dt><dd>The expected result considers the combined strength on both sides.</dd></div><div><dt>Result and score margin</dt><dd>Wins, losses, draws, and a small bounded score-margin adjustment move the rating.</dd></div><div><dt>Confirmed results</dt><dd>Every player must confirm the final score in the Rally Circle before it changes CMR.</dd></div></dl></section><section><h2>What does not affect CMR</h2><p>Locality, followers, streaks, attendance, reliability, fun, fairness, and private player feedback are tracked separately.</p></section><small className="cmr-details-note">CMR is a CourtMate compatibility signal, not an official DUPR or tournament ranking.</small></div></section>}

      {connectionsOpen && user && <section className="utility-page connections-page" aria-labelledby="connections-title"><div className="connections-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><h1 id="connections-title">Connections</h1></div><div className="connections-tabs" role="tablist" aria-label="Connections"><button type="button" className={connectionsTab === "following" ? "active" : ""} onClick={() => setConnectionsTab("following")} role="tab" aria-selected={connectionsTab === "following"}>Following</button><button type="button" className={connectionsTab === "followers" ? "active" : ""} onClick={() => setConnectionsTab("followers")} role="tab" aria-selected={connectionsTab === "followers"}>Followers</button></div>{connectionsLoading ? <div className="connections-loader"><TennisBallLoader label="Loading connections" detail="Finding your people..." /></div> : connectionsError ? <div className="utility-empty"><h2>Could not load connections</h2><p>Try again and we&apos;ll fetch your latest following list.</p><button className="dark-button" type="button" onClick={() => void loadConnections(connectionsTab)}>Try again <span>→</span></button></div> : connections.length ? <div className="connections-list" role="tabpanel">{connections.map((connection) => <article className="connection-row" key={connection.id}><button type="button" className="connection-profile" onClick={() => void viewPlayerProfile(connection.id)} disabled={profileLoadingId === connection.id} aria-label={`View ${connection.display_name}'s profile`}><span className="connection-avatar">{connection.profile_image_url ? <img src={connection.profile_image_url} alt="" /> : initials(connection.display_name)}</span><span><strong>{connection.display_name}</strong><small>{connection.area || "CourtMate player"}</small></span></button><button type="button" className={`connection-follow-button ${connection.is_following ? "following" : ""}`} onClick={() => void toggleConnection(connection)} disabled={profileLoadingId === `connection-${connection.id}`}>{profileLoadingId === `connection-${connection.id}` ? "..." : connection.is_following ? "Following" : "Follow"}</button></article>)}</div> : <div className="utility-empty"><h2>No {connectionsTab} yet</h2><p>{connectionsTab === "following" ? "Follow players from games and social to see them here." : "When players follow you, they&apos;ll appear here."}</p></div>}</section>}
      {notificationsOpen && user && <section className="utility-page notifications-page" aria-labelledby="notifications-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">COURTMATE ALERTS</span><h1 id="notifications-title">Notifications</h1><p>Requests, follows, and games that fit.</p></div><button className="utility-refresh-button" type="button" onClick={() => void loadNotifications()}>Refresh</button></div>{notifications.length ? <div className="utility-notification-list">{notifications.map((notification) => <div className={`notification-item ${notification.read ? "" : "unread"}`} key={notification.id}><button type="button" className="notification-item-main" onClick={() => openNotification(notification)}><span className="notification-mark"><BellIcon /></span><span><strong>{notification.title}</strong><small>{notification.message}</small><em>{new Date(notification.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</em></span></button>{notification.kind === "join_request" && notification.request_id && (notification.action_status ?? "pending") === "pending" && <div className="notification-actions"><button type="button" disabled={notificationActioningId === notification.id} onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "approved"); }}>{notificationActioningId === notification.id ? "Confirming..." : "Confirm"}</button><button type="button" disabled={notificationActioningId === notification.id} onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "declined"); }}>{notificationActioningId === notification.id ? "Updating..." : "Decline"}</button></div>}{notification.kind === "join_request" && notification.action_status && notification.action_status !== "pending" && <span className={`notification-action-status ${notification.action_status}`}>Request {notificationActionLabels[notification.action_status]}</span>}</div>)}</div> : <div className="utility-empty"><span className="utility-empty-icon"><BellIcon /></span><h2>No alerts yet</h2><p>We&apos;ll let you know when a game fits your preferences or someone requests to join.</p></div>}</section>}
      {notificationsOpen && user && notifications.some((notification) => notification.kind === "follow" && notification.actor_id && (notification.action_status ?? "pending") === "pending") && <section className="follow-request-actions" aria-label="Follow requests">{notifications.filter((notification) => notification.kind === "follow" && notification.actor_id && (notification.action_status ?? "pending") === "pending").map((notification) => <div className="follow-request-action" key={notification.id}><span>{notification.message}</span><div><button type="button" disabled={notificationActioningId === notification.id} onClick={() => void decideFollowRequest(notification, "approved")}>{notificationActioningId === notification.id ? "Accepting..." : "Accept"}</button><button type="button" disabled={notificationActioningId === notification.id} onClick={() => void decideFollowRequest(notification, "declined")}>{notificationActioningId === notification.id ? "Updating..." : "Decline"}</button></div></div>)}</section>}
      {settingsOpen && user && profile && <section className="utility-page settings-page" aria-labelledby="settings-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">PREFERENCES</span><h1 id="settings-title">Your play setup</h1><p>Set the details CourtMate uses to find better games.</p></div></div><form className="settings-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Age</span><input type="number" min="13" max="100" step="1" value={profileDraft.age} onChange={(event) => setProfileDraft({ ...profileDraft, age: event.target.value })} placeholder="Optional" /></label><label><span>Gender</span><select value={profileDraft.gender} onChange={(event) => setProfileDraft({ ...profileDraft, gender: event.target.value as ProfileDraft["gender"] })}><option value="">Prefer not to say</option>{genderOptions.map((gender) => <option value={gender.value} key={gender.value}>{gender.label}</option>)}</select></label><label><span>Locality</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation}>{profileDraft.latitude != null && profileDraft.longitude != null ? "Location saved" : "Use current location"}<span>⌖</span></button></label></div><fieldset className="settings-preference-fieldset"><legend>Who do you like to play with?</legend><label><span>Age range</span><select value={profileDraft.preferred_age_range} onChange={(event) => setProfileDraft({ ...profileDraft, preferred_age_range: event.target.value as AgeRange })}>{ageRangeOptions.map((range) => <option value={range.value} key={range.value}>{range.label}</option>)}</select></label><span className="settings-hint">Leave gender unselected to keep every group in the mix.</span><div className="gender-preference-grid">{genderOptions.map((gender) => <label className={`availability-option ${profileDraft.preferred_genders.includes(gender.value) ? "selected" : ""}`} key={gender.value}><input type="checkbox" checked={profileDraft.preferred_genders.includes(gender.value)} onChange={() => togglePreferredGender(gender.value)} /><span>{gender.label}</span></label>)}</div></fieldset><label><span>Play style</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>Usual availability</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save preferences <span>→</span></button></div></form></section>}
      {settingsOpen && user && profile && <section className="settings-privacy-panel" aria-labelledby="privacy-settings-title"><div className="settings-privacy-heading"><div><span className="kicker">PRIVACY</span><h2 id="privacy-settings-title">Who can see your play?</h2></div><span>Applies to new games</span></div><form className="settings-privacy-form" onSubmit={saveProfile}><label className="settings-toggle-row"><span><strong>Private profile</strong><small>Hide your profile from recommendations and public player pages.</small></span><input type="checkbox" checked={profileDraft.is_profile_private} onChange={(event) => setProfileDraft({ ...profileDraft, is_profile_private: event.target.checked })} /><span className="settings-switch" aria-hidden="true" /></label><label><span>Default game session visibility</span><select value={profileDraft.default_session_visibility} onChange={(event) => setProfileDraft({ ...profileDraft, default_session_visibility: event.target.value as SessionVisibility })}><option value="public">Everyone nearby</option><option value="followers">Followers of the organizer</option><option value="private">Only players in the game</option></select></label><p className="settings-hint">This controls who can discover the games you create. You can still share a private game directly.</p><button className="dark-button" type="submit">Save privacy settings <span>→</span></button></form><div className="settings-sign-out"><div><strong>Sign out of CourtMate</strong><span>Your saved profile and game history will remain available next time you sign in.</span></div><button type="button" onClick={() => void signOutUser()}>Sign out</button></div></section>}
      {calendarOpen && user && socialProfile && <section className="utility-page profile-calendar-page" aria-labelledby="profile-calendar-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">YOUR ACTIVITY</span><h1 id="profile-calendar-title">Activity calendar</h1><p>Every game day, all in one place.</p></div></div><ActivityCalendar activity={socialProfile.activity_by_date} /></section>}
      {viewedGroup && <div className="group-modal-backdrop" onClick={() => setViewedGroup(null)}><section className="group-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">{sportLabel(viewedGroup.session.sport).toUpperCase()} GROUP PREVIEW</span><h2>{viewedGroup.session.group_name}</h2><p>{viewedGroup.session.start_time} – {viewedGroup.session.end_time} · {viewedGroup.session.area}</p></div><button className="close-button" onClick={() => setViewedGroup(null)}>×</button></div><div className="group-summary"><span><strong>{viewedGroup.members.length}/{viewedGroup.session.capacity}</strong><small>PLAYERS</small></span><span><strong>{viewedGroup.session.skill_min.toFixed(1)}–{viewedGroup.session.skill_max.toFixed(1)}</strong><small>SKILL BAND</small></span><span><strong>{viewedGroup.session.style}</strong><small>INTENSITY</small></span></div><div className="member-grid">{viewedGroup.members.map((member) => { const memberCmr = member.cmr_ratings?.[viewedGroup.session.sport]; const memberRating = memberCmr ?? member.sport_ratings?.[viewedGroup.session.sport] ?? (viewedGroup.session.sport === "pickleball" ? member.dupr_rating : undefined); return <button type="button" className="member-profile profile-link" key={member.id} onClick={() => void viewPlayerProfile(member.id)} disabled={profileLoadingId === member.id} aria-label={`View ${member.display_name}'s profile`}><div className="member-profile-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</div><div className="member-profile-copy"><h3>{member.display_name}</h3><p>{member.area} · {member.style}</p><div className="member-profile-meta"><strong>{memberCmr != null ? `CMR ${memberCmr.toFixed(1)} / 100` : memberRating ? `${sportLabel(viewedGroup.session.sport)} ${memberRating.toFixed(1)}` : "Rating not set"}</strong><span>{member.is_following ? "Following" : "View profile"}</span></div></div></button>; })}</div><div className="modal-game-actions"><button className="copy-link-button" onClick={() => void copyGroupSpaceLink(viewedGroup.session)} aria-label={`Copy ${viewedGroup.session.group_name} link`} title="Copy share link"><CopyIcon /><span>Copy link</span></button><button className="game-share-button" onClick={() => void shareGame(viewedGroup.session)}>Share game <span>↗</span></button>{viewedGroup.session.organizer_id === user?.uid ? <span className="status-badge approved modal-join">You created this group</span> : <button className="dark-button modal-join" onClick={() => void joinSession(viewedGroup.session.id, viewedGroup.session.group_name, viewedGroup.session.organizer_id)} disabled={joiningSessionId !== null}>{joiningSessionId === viewedGroup.session.id ? "Requesting..." : "Request to join"} <span>→</span></button>}</div></section></div>}
      {activeTab === "profile" && viewedProfile && <section className="page-view profile-page public-profile-page" aria-labelledby="public-profile-title"><section className="profile-photo-card public-profile-card"><button type="button" className="profile-back-button" onClick={closePlayerProfile} aria-label="Back to previous page">←</button><div className="profile-photo-avatar">{viewedProfile.profile_image_url ? <img src={viewedProfile.profile_image_url} alt={`${viewedProfile.display_name} profile`} /> : initials(viewedProfile.display_name)}</div><div className="profile-photo-copy"><span className="kicker">PLAYER PROFILE</span><strong id="public-profile-title">{viewedProfile.display_name}</strong><small>{viewedProfile.area || "Local player"} · {viewedProfile.style}</small><div className="profile-photo-social-stats"><span><strong>{totalGamesFor(viewedProfile)}</strong><span>GAMES</span></span><span><strong>{viewedProfile.followers_count}</strong><span>FOLLOWERS</span></span><span><strong>{viewedProfile.following_count}</strong><span>FOLLOWING</span></span></div></div><div className="profile-photo-actions public-profile-actions"><button className={`dark-button ${viewedProfile.is_following ? "following-button" : ""}`} onClick={() => void toggleFollowProfile()}>{viewedProfile.is_following ? "Following" : "Follow"}<span>{viewedProfile.is_following ? "✓" : "+"}</span></button>{viewedProfile.follows_you && <span className="follows-you">Follows you</span>}</div></section><section className="public-profile-activity"><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Activity calendar</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={viewedProfile.activity_by_date} /></section><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">RECENT GAMES</span><h2>Where they played</h2></div><span>{viewedProfile.recent_games.length} shown</span></div><RecentGames games={viewedProfile.recent_games} /></section></section><section className="profile-sport-ratings public-profile-ratings"><span className="kicker">CMR BY SPORT</span>{Object.entries(viewedProfile.cmr_ratings ?? {}).length ? <div className="profile-rating-list">{Object.entries(viewedProfile.cmr_ratings ?? {}).map(([sport, rating]) => <span key={sport}><strong>{sportLabel(sport)}</strong><b>{rating.toFixed(1)} / 100</b></span>)}</div> : <p>No CMR ratings yet. Completed games will build them here.</p>}</section></section>}
      {workspaceGroup && workspaceLoading && <section className="group-space-page group-space-loading"><TennisBallLoader label="Opening Rally Circle" detail="Loading chat, players, and the waitlist..." /></section>}
      {workspaceGroup && !workspaceLoading && <GroupSpace group={workspaceGroup} members={groupMembers} waitlist={groupWaitlist} posts={chatPosts} currentUserId={user?.uid} apiUrl={apiUrl} authorizedFetch={authorizedFetch} onClose={() => setWorkspaceGroup(null)} onRefresh={() => void openGroupSpace(workspaceGroup)} onMarkDone={() => markGroupDone(workspaceGroup.id)} onOpenPersonalRally={() => { setSocialFeedEntry("personal"); setWorkspaceGroup(null); selectTab("social"); }} onChatPosted={(post) => setChatPosts((current) => current.some((item) => item.id === post.id) ? current.map((item) => item.id === post.id ? post : item) : [...current, post])} onToast={setToast} onViewProfile={(playerId) => void viewPlayerProfile(playerId)} />}
      {rankingGame && <section className="ranking-page" aria-labelledby="ranking-page-title"><header className="ranking-page-header"><button type="button" className="ranking-back-button" onClick={() => { if (window.location.hash) window.history.back(); else setRankingGame(null); }} aria-label="Back to games">←</button><div><span className="kicker">FINAL RANKINGS</span><h1 id="ranking-page-title">{rankingGame.group_name}</h1><p>{sportLabel(rankingGame.sport)} · {rankingGame.session_date} · {rankingGame.area}</p></div></header>{rankingLoading ? <div className="ranking-loading"><TennisBallLoader label="Loading rankings" detail="Fetching the final table..." /></div> : <div className="ranking-page-content"><section className="ranking-only-panel"><div className="ranking-only-heading"><div><span className="kicker">THIS GAME</span><h2>Group rankings</h2></div><span>{rankingEntries.length} players</span></div>{rankingEntries.length ? <div className="ranking-only-list">{rankingEntries.map((entry) => <div className={`ranking-only-row ${entry.player.id === user?.uid ? "current" : ""}`} key={entry.player.id}><span className="ranking-only-rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div> : <p className="ranking-only-empty">No confirmed rankings for this game yet.</p>}</section>{localRankingEntries.length > 0 && <section className="ranking-only-panel local-ranking-only-panel"><div className="ranking-only-heading"><div><span className="kicker">{rankingGame.area.toUpperCase()} · LOCAL</span><h2>Local leaderboard</h2></div><span>Top {Math.min(localRankingEntries.length, 5)}</span></div><div className="ranking-only-list">{localRankingEntries.slice(0, 5).map((entry) => <div className="ranking-only-row" key={entry.player.id}><span className="ranking-only-rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div></section>}</div>}</section>}
      {cmrSetupSport && <div className="cmr-setup-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !cmrSetupSaving) setCmrSetupSport(null); }}><section className="cmr-setup-card" role="dialog" aria-modal="true" aria-labelledby="cmr-setup-title" onMouseDown={(event) => event.stopPropagation()}><button className="cmr-setup-close" type="button" onClick={() => setCmrSetupSport(null)} disabled={cmrSetupSaving} aria-label="Close level setup">×</button><span className="kicker">YOUR STARTING POINT</span><h2 id="cmr-setup-title">What&apos;s your current level?</h2><p>Choose the closest whole-number level for <strong>{sportLabel(cmrSetupSport)}</strong>. CourtMate then tracks your CMR from 1.00 to 10.00 using confirmed competitive results.</p><label><span>Sport</span><select value={cmrSetupSport} onChange={(event) => requestCmrSetup(event.target.value as Sport)}>{sportOptions.map((sport) => <option key={sport.value} value={sport.value}>{sport.label}</option>)}</select></label><div className="cmr-setup-levels" role="list" aria-label="Choose your current level">{cmrLevelChoices.map((choice) => <button type="button" className={cmrSetupLevel === choice.value ? "selected" : ""} key={choice.value} onClick={() => { setCmrSetupLevel(choice.value); setCmrSetupError(""); }} role="listitem"><b>{choice.value}</b><span>{choice.label}</span></button>)}</div>{cmrSetupError && <p className="cmr-setup-error" role="alert">{cmrSetupError}</p>}<div className="cmr-setup-footer"><span>Starting CMR <strong>{cmrSetupLevel.toFixed(2)}</strong></span><button className="dark-button" type="button" onClick={() => void saveCmrSetup()} disabled={cmrSetupSaving}>{cmrSetupSaving ? "Saving..." : "Start with this level"}<span>→</span></button></div><small>You can use a linked rating as a suggestion, but your selected level is always the starting point.</small></section></div>}
      {toast && !(activeTab === "home" && user) && <div className="toast">{toast}</div>}
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
