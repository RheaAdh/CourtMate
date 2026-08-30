"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { auth, isFirebaseConfigured, storage } from "../firebase";
import { GroupSpace } from "./group-space";
import { PostGameFeedbackPanel } from "./post-game-feedback";
import { SocialFeed } from "./social-feed";
import { TennisBallLoader } from "./tennis-ball-loader";
import { TournamentHub } from "./tournament-hub";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type Gender = "woman" | "man" | "non_binary" | "prefer_not_to_say";
type AgeRange = "any" | "18_24" | "25_34" | "35_44" | "45_plus";
type SessionVisibility = "public" | "followers" | "private";
type Theme = "light" | "dark";

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
  skill_min: number;
  skill_max: number;
  style: string;
  capacity: number;
  confirmed_player_ids: string[];
  waitlist_player_ids?: string[];
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
  tournaments?: ChatTournament[];
  group_proposal?: GroupProposal;
  scope?: "court_discovery" | "sports_general" | "out_of_scope";
};

type ChatTournament = {
  id: string;
  name: string;
  sport: Sport;
  area: string;
  venue_name?: string | null;
  tournament_date: string;
  capacity: number;
  status: "registration" | "in_progress" | "completed" | "cancelled";
  registration_ids: string[];
  my_registration_status?: "pending" | "registered" | "waitlisted" | "declined" | "withdrawn" | null;
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
  bio?: string;
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
  skill_min: number;
  skill_max: number;
  style: string;
  capacity: number;
  confirmed_player_ids: string[];
  waitlist_player_ids?: string[];
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

type ChatPost = {
  id: string;
  player_id: string;
  player_display_name: string;
  message: string;
  post_type?: "message" | "match_result";
  teams?: { name: string; player_ids: string[]; score?: number | null }[];
  result_status?: "pending_confirmation" | "confirmed" | "disputed" | null;
  confirmation_ids?: string[];
  created_at: string;
};

type AppNotification = {
  id: string;
  kind: "game_match" | "join_request" | "request_update" | "tournament_request" | "tournament_update" | "follow";
  title: string;
  message: string;
  session_id: string;
  request_id?: string | null;
  tournament_id?: string | null;
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
type AppTab = "home" | "social" | "games" | "profile" | "tournaments" | "about";
type GamesViewTab = "explore" | "pending" | "upcoming" | "history" | "requested" | "confirmed" | "past" | "incoming";
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

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
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

function TournamentIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v4a6 6 0 0 1-12 0V4ZM4 4h2v3a4 4 0 0 1-4-4v-1h4M20 4h2v-2h-4M12 14v5M8 21h8" /><path d="M18 5a4 4 0 0 0 4-4" /></svg>;
}

function SocialIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.3 21c4.3 0 7.2-2.8 7.2-6.6 0-2.7-1.5-4.8-3.9-6.8.1 2.2-.8 3.5-2 4.2.3-3.5-1.1-6.1-4.1-8.8.2 3.2-1.2 4.8-2.5 6.5A8 8 0 0 0 5 14.5C5 18.3 7.9 21 12.3 21Z" /><path d="M12 20.8c-1.8-.8-2.8-2.2-2.8-3.9 0-1.4.7-2.5 1.8-3.7.2 1.2.7 2 1.5 2.5.1-1.3.7-2.3 1.5-3.2.8 1.2 1.2 2.3 1.2 3.5 0 2.1-1.2 3.9-3.2 4.8Z" /></svg>;
}

function ChatIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" /><path d="M7 10h10M7 13.5h6" /></svg>;
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

function ProfileSportOverview({ profile, sports, selectedSport, onSelect }: { profile: PlayerProfile; sports: { value: Sport; label: string }[]; selectedSport: Sport; onSelect: (sport: Sport) => void }) {
  const courtSportValues = new Set(sportOptions.map((sport) => sport.value));
  const cards = sports.filter((sport) => courtSportValues.has(sport.value)).map((sport) => {
    const history = profile.cmr_history?.[sport.value] ?? [];
    const ratedHistory = history.filter((point) => point.rating != null);
    const rating = profile.cmr_ratings?.[sport.value] ?? ratedHistory[ratedHistory.length - 1]?.rating ?? 0;
    const peak = Math.max(rating, ...ratedHistory.map((point) => point.rating ?? 0));
    const delta = ratedHistory[ratedHistory.length - 1]?.delta ?? 0;
    const momentum = delta > 0.5 ? "Rising" : delta < -0.5 ? "Needs a reset" : "Steady form";
    return { ...sport, rating, peak, delta, momentum, games: profile.cmr_game_counts?.[sport.value] ?? ratedHistory.length };
  });

  if (!cards.length) return null;
  cards.sort((a, b) => b.games - a.games);
  return <section className="profile-sport-overview" aria-label="Sport-wise CMR stats"><div className="profile-sport-overview-heading"><div><span className="kicker">YOUR SPORTS</span><h2>CMR by sport</h2></div><span>Tap a circle to explore</span></div><div className="profile-sport-overview-grid">{cards.map((sport) => { const movement = sport.delta > 0 ? "up" : sport.delta < 0 ? "down" : "flat"; const movementLabel = sport.delta > 0 ? `up ${sport.delta.toFixed(1)}` : sport.delta < 0 ? `down ${Math.abs(sport.delta).toFixed(1)}` : "no change"; return <button type="button" className={`profile-sport-stat ${selectedSport === sport.value ? "selected" : ""}`} key={sport.value} onClick={() => onSelect(sport.value)} aria-label={`${sport.label}, ${Math.round(sport.rating)} CMR, ${sport.games} games, ${movementLabel}`}><span className="cmr-ring" style={{ background: `conic-gradient(var(--lime) ${Math.max(0, Math.min(100, sport.rating))}%, #e5eadc 0)` }}><span><b>{Math.round(sport.rating)}</b></span></span><strong>{sport.label}</strong><small>{sport.games} game{sport.games === 1 ? "" : "s"}</small><span className={`cmr-movement ${movement}`}><span className="cmr-movement-icon" aria-hidden="true">{movement === "up" ? "↑" : movement === "down" ? "↓" : "•"}</span>{sport.delta === 0 ? "No change" : `${sport.delta > 0 ? "+" : ""}${sport.delta.toFixed(1)}`}</span></button>; })}</div></section>;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [searchScope, setSearchScope] = useState<"court_discovery" | "sports_general" | "out_of_scope" | "performance">("court_discovery");
  const [selectedSport, setSelectedSport] = useState<Sport>("pickleball");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tournamentResults, setTournamentResults] = useState<ChatTournament[]>([]);
  const [joiningSessionId, setJoiningSessionId] = useState<string | null>(null);
  const [lastChatRequest, setLastChatRequest] = useState<{ name: string; status: JoinRequest["status"] } | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Finding your best match...");
  const [groupProposal, setGroupProposal] = useState<GroupProposal | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [createGroupDraft, setCreateGroupDraft] = useState<CreateGroupDraft>({ sport: "pickleball", area: "", session_date: localDateInput(), start_time: "19:00", end_time: "21:00", skill_min: "3.0", skill_max: "3.5", style: "casual" });
  const [createQuery, setCreateQuery] = useState("");
  const [showCreateGame, setShowCreateGame] = useState(false);
  const [showCraftedGame, setShowCraftedGame] = useState(false);
  const [creationStep, setCreationStep] = useState<"confirm" | "sport" | "time" | "area" | "skill" | "vibe">("confirm");
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ bio: "", is_profile_private: false, default_session_visibility: "public", area: "Whitefield", age: "", gender: "", preferred_age_range: "any", preferred_genders: [], travel_radius_km: "10", style: "casual", availability: [] });
  const [bioEditing, setBioEditing] = useState(false);
  const [bioSaving, setBioSaving] = useState(false);
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
  const [exploreGames, setExploreGames] = useState<Session[]>([]);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [leavingGameId, setLeavingGameId] = useState<string | null>(null);
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
  const [activityProofs, setActivityProofs] = useState<ActivityProof[]>([]);
  const [groupLeaderboard, setGroupLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [localLeaderboard, setLocalLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
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
  const [gamesViewTab, setGamesViewTab] = useState<GamesViewTab>("upcoming");
  const [profileSport, setProfileSport] = useState<Sport | null>(null);
  const [feedFilter, setFeedFilter] = useState("best");
  const [toast, setToast] = useState("");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("courtmate-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
      return;
    }
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) setTheme("dark");
  }, []);

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
    if (new URLSearchParams(window.location.search).get("tournament")) setActiveTab("tournaments");
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
        const sharedGameId = new URLSearchParams(window.location.search).get("game");
        const hasTournamentLink = Boolean(new URLSearchParams(window.location.search).get("tournament"));
        setActiveTab(sharedGameId ? "games" : hasTournamentLink ? "tournaments" : "social");
        void loadProfile(nextUser);
        void loadNotifications(nextUser);
        if (sharedGameId) void viewGroup(sharedGameId);
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
    if (!workspaceGroup && hash.startsWith("#group-space-")) window.history.back();
    if (!rankingGame && hash.startsWith("#ranking-")) window.history.back();
    if (!viewedGroup && hash.startsWith("#group-preview-")) window.history.back();
  }, [workspaceGroup, viewedGroup, viewedProfile]);

  useEffect(() => {
    if (viewedProfile || window.location.hash.startsWith("#player-profile-")) return;
    setActiveTab(profileReturnTab);
  }, [viewedProfile, profileReturnTab]);

  async function authorizedFetch(url: string, options: RequestInit = {}, authUser: User | null = user) {
    if (!authUser) throw new Error("Sign in required");
    const token = await authUser.getIdToken();
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  }

  async function uploadProfilePicture(file: File) {
    if (!user) return;
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
      const uploadTicketResponse = await authorizedFetch(`${apiUrl}/v1/me/profile-image/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content_type: file.type }),
      });
      if (!uploadTicketResponse.ok) {
        const payload = await uploadTicketResponse.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Profile picture upload URL could not be created");
      }
      const uploadTicket = await uploadTicketResponse.json() as { upload_url: string; image_url: string };
      const upload = await fetch(uploadTicket.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!upload.ok) throw new Error("Profile picture could not be uploaded to Cloud Storage");
      const response = await authorizedFetch(`${apiUrl}/v1/me/profile-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_image_url: uploadTicket.image_url }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Profile photo could not be saved");
      }
      const savedProfile = await response.json() as PlayerProfile;
      setProfile(savedProfile);
      setSocialProfile((current) => current ? { ...current, profile_image_url: uploadTicket.image_url } : current);
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

  async function analyzeActivityScreenshot(file: File, sessionId: string): Promise<ActivityProof | null> {
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
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const imageRef = ref(storage, `activity-proofs/${user.uid}/${sessionId}/${crypto.randomUUID()}.${extension}`);
      const upload = await uploadBytes(imageRef, file, { contentType: file.type });
      const imageUrl = await getDownloadURL(upload.ref);
      setToast("Gemini is reading your game stats...");
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/activity-proof/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image_url: imageUrl }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Could not analyse tracker screenshot");
      }
      const proof = await response.json() as ActivityProof;
      setActivityProofs((current) => [proof, ...current.filter((item) => item.id !== proof.id)]);
      setToast("Game stats added");
      return proof;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not analyse tracker screenshot");
      return null;
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
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const imageRef = ref(storage, `activity-proofs/${user.uid}/profile/${crypto.randomUUID()}.${extension}`);
      const upload = await uploadBytes(imageRef, file, { contentType: file.type });
      const imageUrl = await getDownloadURL(upload.ref);
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
    if (!notification.request_id) return;
    await markNotificationRead(notification.id);
    await decideJoinRequest(notification.request_id, status, notification.session_id);
    closeUtilityPage();
  }

  function openNotification(notification: AppNotification) {
    if (!notification.read) void markNotificationRead(notification.id);
    closeUtilityPage();
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
    if (notification.kind === "tournament_request" || notification.kind === "tournament_update") {
      setActiveTab("tournaments");
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
      if (mostPlayedSport) setSelectedSport(mostPlayedSport.value);
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
    setProfile(null);
    setProfileDraft({ bio: "", is_profile_private: false, default_session_visibility: "public", area: "Whitefield", age: "", gender: "", preferred_age_range: "any", preferred_genders: [], travel_radius_km: "10", style: "casual", availability: [] });
    setManagedGroupId(null);
    setWorkspaceGroup(null);
    setChatPosts([]);
    setGroupMembers([]);
    setActivityProofs([]);
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
    setTournamentResults([]);
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
        setTournamentResults([]);
        setGroupProposal(null);
        setSearchScope("performance");
        setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-assistant`, role: "assistant", text: payload.answer ?? "I could not read that performance question." }]);
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
      if (!response.ok) throw new Error(payload.detail ?? "The game search is temporarily unavailable");
      const isInScope = payload.scope !== "out_of_scope";
      setTournamentResults(payload.tournaments ?? []);
      setSessions(payload.recommendations.map((item: { session: Session; score: number; reasons: { explanation: string } }) => ({
        ...item.session,
        open_slots: item.session.capacity - item.session.confirmed_player_ids.length,
        score: item.score,
        explanation: item.reasons.explanation,
      })));
      setSearchScope(payload.scope ?? "court_discovery");
      setGroupProposal(isInScope ? payload.group_proposal ?? null : null);
      setGroupNameDraft(payload.group_proposal?.group_name ?? "");
      const shouldStartCreation = isInScope && !payload.tournaments?.length && payload.recommendations.length === 0 && Boolean(payload.group_proposal);
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
        });
      }
      if (exact && requestQuery.trim()) {
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
    setSessions([]);
    setTournamentResults([]);
    setGroupProposal(nextProposal);
    setGroupNameDraft(nextProposal.group_name);
    setShowCraftedGame(false);
    setShowCreateGame(false);
    const firstStep = explicitSport ? "time" : "sport";
    setCreationStep(firstStep);
    setCreateQuery(sourceQuery || `Create a ${sportLabel(requestSport)} game near ${area}`);
    setCreateGroupDraft({ sport: nextProposal.sport, area: nextProposal.area, session_date: nextProposal.session_date ?? localDateInput(), start_time: nextProposal.start_time ?? "19:00", end_time: nextProposal.end_time ?? "21:00", skill_min: nextProposal.skill_min.toString(), skill_max: nextProposal.skill_max.toString(), style: nextProposal.style as CreateGroupDraft["style"] });
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
    const area = profile?.area?.trim() || "";
    const rating = profile?.cmr_ratings?.[sport] ?? 3.25;
    const style: CreateGroupDraft["style"] = profile?.style === "social" || profile?.style === "competitive" ? profile.style : "casual";
    setGroupNameDraft(`${area || "Local"} ${sportLabel(sport)} Game`);
    setCreateGroupDraft({ sport, area, session_date: localDateInput(), start_time: "19:00", end_time: "21:00", skill_min: Math.max(1, Math.round((rating - 0.3) * 10) / 10).toString(), skill_max: Math.min(8, Math.round((rating + 0.3) * 10) / 10).toString(), style });
    setShowCreateGame(true);
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
    return `${sportLabel(draft.sport)} · ${dateLabel} · ${draft.start_time}–${draft.end_time} · ${draft.area || "Area to be decided"}`;
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
    const skillBands = { beginner: ["1.0", "2.9"], intermediate: ["3.0", "3.5"], advanced: ["3.6", "5.0"] } as const;
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

  function clearChat() {
    setChatMessages([]);
    setSearchScope("court_discovery");
    setSessions([]);
    setTournamentResults([]);
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
    setTournamentResults([]);
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
    setTournamentResults([]);
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
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-feedback-assistant`, role: "assistant", text: `${selectedGame?.group_name ?? "Your game"} feedback is saved. CMR and player insights have been refreshed from confirmed scores and ratings.` }]);
      void loadProfile(user as User);
      void loadSocialProfile(user as User);
      void loadActivity("games");
    } catch (error) {
      setChatMessages((messages) => [...messages.slice(-8), { id: `${requestTimestamp}-feedback-error`, role: "assistant", text: error instanceof Error ? error.message : "I could not save that feedback." }]);
    } finally {
      setLoading(false);
      setLoadingMessage("Finding your best match...");
    }
  }

  function openTournamentFromChat(tournamentId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("tournament", tournamentId);
    window.history.pushState({ courtMatePage: "tournament" }, "", `${url.pathname}${url.search}`);
    setTournamentResults([]);
    setActiveTab("tournaments");
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
    const rating = profile?.cmr_ratings?.[sport] ?? 3.25;
    const skillMin = Math.max(1, Math.round((rating - 0.3) * 10) / 10);
    const skillMax = Math.min(8, Math.round((rating + 0.3) * 10) / 10);
    setSelectedSport(sport);
    setCreateGroupDraft((draft) => ({ ...draft, sport, skill_min: skillMin.toString(), skill_max: skillMax.toString() }));
    setGroupNameDraft((name) => name.replace(/(Pickleball|Badminton|Tennis|Padel|Squash|Table tennis) Game$/i, `${sportLabel(sport)} Game`));
    setGroupProposal((proposal) => proposal ? { ...proposal, sport, group_name: proposal.group_name.replace(/(Pickleball|Badminton|Tennis|Padel|Squash|Table tennis) Game$/i, `${sportLabel(sport)} Game`), skill_min: skillMin, skill_max: skillMax } : proposal);
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
          visibility: profile?.default_session_visibility ?? "public",
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
      setSessions([]);
      setGroupProposal(null);
      setShowCreateGame(false);
      setShowCraftedGame(false);
      setCreationStep("confirm");
      setManagedGroupId(createdSession.id);
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-created-assistant`, role: "assistant", text: `${createdSession.group_name} is live. Head over to the Games tab to see it and manage requests.` }]);
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

  async function joinSession(sessionId: string, name: string, organizerId?: string) {
    if ((organizerId ?? sessions.find((session) => session.id === sessionId)?.organizer_id) === user?.uid) {
      setToast("You created this group");
      window.setTimeout(() => setToast(""), 2600);
      return;
    }
    try {
      setJoiningSessionId(sessionId);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) throw new Error("Unable to join");
      const payload = await response.json() as { status: JoinRequest["status"] };
      setLastChatRequest({ name, status: payload.status });
      await loadActivity("requests");
      setSessions((currentSessions) => currentSessions.filter((session) => session.id !== sessionId));
      setViewedGroup(null);
      const statusMessage = payload.status === "waitlisted"
        ? `You are on the waitlist for ${name}. I’ve saved your place and you can track it in Games → Pending.`
        : `Request sent to ${name}. The organizer needs to approve you. You can track it in Games → Pending.`;
      setChatMessages((messages) => [...messages.slice(-8), { id: `${Date.now()}-join-confirmation`, role: "assistant", text: statusMessage }]);
      setToast(payload.status === "waitlisted" ? `You are on the waitlist for ${name}` : `Join request sent to ${name}`);
    } catch {
      setToast(`Could not request to join ${name}`);
    } finally {
      setJoiningSessionId(null);
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  async function leaveGame(sessionId: string, name: string, requestId?: string) {
    if (leavingGameId) return;
    setLeavingGameId(sessionId);
    try {
      const endpoint = requestId
        ? `${apiUrl}/v1/me/requests/${encodeURIComponent(requestId)}/withdraw`
        : `${apiUrl}/v1/sessions/${sessionId}/leave`;
      const response = await authorizedFetch(endpoint, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { detail?: string; status?: JoinRequest["status"] };
      if (!response.ok) throw new Error(payload.detail ?? "Unable to leave");
      setWorkspaceGroup(null);
      setApprovedGames((games) => games.filter((game) => game.id !== sessionId));
      setMyRequests((requests) => requests.filter(({ request, session }) => requestId ? request.id !== requestId : session.id !== sessionId));
      await Promise.all([loadActivity("requests"), loadActivity("games")]);
      setToast(requestId ? `Request withdrawn from ${name}` : `You backed out of ${name}`);
    } catch (error) {
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
      if (window.location.hash !== `#group-preview-${sessionId}`) window.history.pushState({ courtMatePage: "group-preview" }, "", `#group-preview-${sessionId}`);
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
    if (window.location.hash !== `#group-space-${normalizedGroup.id}`) window.history.pushState({ courtMatePage: "group-space" }, "", `#group-space-${normalizedGroup.id}`);
    setWorkspaceLoading(true);
    setChatDraft("");
    setPlayerRatings({});
    try {
      // Chat and roster are the core group space. Rankings are useful context,
      // but should not prevent confirmed players from coordinating if one
      // leaderboard request is unavailable.
      const [chatResponse, membersResponse] = await Promise.all([
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/chat`),
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/group`),
      ]);
      if (!chatResponse.ok || !membersResponse.ok) {
        if (chatResponse.status === 403 || membersResponse.status === 403) throw new Error("Only confirmed group members can open this group space");
        throw new Error("Group space unavailable");
      }
      const chatPayload = await chatResponse.json() as { posts: ChatPost[] };
      const membersPayload = await membersResponse.json() as GroupView;
      setWorkspaceGroup(toActivityGroup(membersPayload.session));
      setChatPosts(chatPayload.posts);
      setGroupMembers(membersPayload.members);
      setGroupWaitlist(membersPayload.waitlist ?? []);
      setActivityProofs(membersPayload.activity_proofs ?? []);
      // Chat and roster are enough to start coordinating. Load analytics after the space is visible.
      setWorkspaceLoading(false);
      const [groupResult, localResult] = await Promise.allSettled([
        authorizedFetch(`${apiUrl}/v1/sessions/${normalizedGroup.id}/leaderboard`),
        authorizedFetch(`${apiUrl}/v1/leaderboards/local?area=${encodeURIComponent(normalizedGroup.area)}&sport=${encodeURIComponent(normalizedGroup.sport)}`),
      ]);
      if (groupResult.status === "fulfilled" && groupResult.value.ok) {
        setGroupLeaderboard((await groupResult.value.json() as { entries: LeaderboardEntry[] }).entries);
      } else {
        setGroupLeaderboard([]);
      }
      if (localResult.status === "fulfilled" && localResult.value.ok) {
        setLocalLeaderboard((await localResult.value.json() as { entries: LeaderboardEntry[] }).entries);
      } else {
        setLocalLeaderboard([]);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not open this group space");
      setWorkspaceGroup(null);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function markGroupDone(sessionId: string) {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/complete`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as Session & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not mark this game done");
      setWorkspaceGroup(toActivityGroup(payload));
      setToast("Game marked done and posted to Home. Add your player order below to update CMR.");
      void loadActivity("games");
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

  async function loadExploreGames(authUser: User | null = user) {
    if (!authUser) return;
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

  function shareGameOnWhatsApp(game: ShareableGame) {
    const dateLabel = new Date(`${game.session_date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
    const location = game.venue_name ? `${game.venue_name}, ${game.area}` : game.area;
    const shareUrl = new URL(window.location.origin);
    shareUrl.searchParams.set("game", game.id);
    const message = `Join me for ${game.group_name}\n${sportLabel(game.sport)} · ${dateLabel} · ${game.start_time}–${game.end_time}\n${location}\n\nView the game on CourtMate: ${shareUrl.toString()}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    const shareWindow = window.open(whatsappUrl, "_blank", "noopener,noreferrer");
    if (shareWindow) {
      setToast("Game details ready to share on WhatsApp");
    } else {
      void navigator.clipboard?.writeText(message);
      setToast("WhatsApp could not open. Game details copied instead.");
    }
    window.setTimeout(() => setToast(""), 2600);
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
    if (tab === "home" && user) {
      setQuery("");
      void search(undefined, `Show me nearby ${selectedSport} games that match my saved preferences`, false);
    }
    if (tab === "games") {
      void Promise.all([loadActivity("requests"), loadActivity("games"), loadActivity("groups"), loadActivity("incoming"), loadExploreGames()]);
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
    setConnectionsOpen(false);
    setWorkspaceGroup(null);
    setRankingGame(null);
    setViewedGroup(null);
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
  const upcomingGames = Array.from(new Map([...approvedGames, ...myGroups.filter((group) => group.session_date >= today && group.status !== "completed" && group.status !== "cancelled")].map((game) => [game.id, game])).values()).sort((a, b) => `${a.session_date} ${a.start_time}`.localeCompare(`${b.session_date} ${b.start_time}`));
  const activeSports = sportOptions.filter((sport) => profile?.cmr_ratings?.[sport.value] != null || (profile?.cmr_game_counts?.[sport.value] ?? 0) > 0);
  const ratedSports = activeSports.filter((sport) => profile?.cmr_ratings?.[sport.value] != null);
  const mostPlayedSport = [...activeSports].sort((left, right) => (profile?.cmr_game_counts?.[right.value] ?? 0) - (profile?.cmr_game_counts?.[left.value] ?? 0))[0]?.value;
  const profileSelectedSport = profileSport && activeSports.some((sport) => sport.value === profileSport) ? profileSport : mostPlayedSport ?? "pickleball";
  const profileHistory = profile?.cmr_history?.[profileSelectedSport] ?? [];
  const currentCmr = profile?.cmr_ratings?.[profileSelectedSport];
  const profileRecentGames = socialProfile?.recent_games.filter((game) => game.sport === profileSelectedSport) ?? [];
  const totalGames = profile ? totalGamesFor(profile) : 0;
  const visibleScoreGames = scoreableGames().filter((game) => !scorePickerSport || game.sport === scorePickerSport);
  const unreadNotifications = notifications.filter((notification) => !notification.read).length;

  return (
    <main className={`shell ${settingsOpen || notificationsOpen || calendarOpen || connectionsOpen ? "utility-page-open" : ""} ${workspaceGroup || viewedGroup ? "detail-page-open" : ""} ${rankingGame ? "ranking-page-open" : ""}`}>
      <nav className="nav">
        <div className="brand" aria-label="CourtMate"><img className="brand-icon brand-logo-light" src="/courtmate-header-logo-light.png" alt="CourtMate" /><img className="brand-icon brand-logo-dark" src="/courtmate-header-logo-dark.png" alt="" aria-hidden="true" /></div>
        <div className="nav-right"><button className={`about-link ${activeTab === "about" ? "active" : ""}`} onClick={() => selectTab("about")}>About</button><span className="location-pill"><span className="dot" /> Whitefield, Bengaluru</span><button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><ThemeIcon dark={theme === "dark"} /></button>{user ? <><button className={`settings-button ${settingsOpen ? "active" : ""}`} type="button" onClick={openSettings} aria-label="Open preferences" title="Preferences"><SettingsIcon /></button><div className="notification-wrap">
          <button className={`notification-button ${notificationsOpen ? "active" : ""}`} type="button" onClick={openNotifications} aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`} title="Notifications"><BellIcon />{unreadNotifications > 0 && <span className="notification-count">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
        </div><span className="user-name">{user.displayName ?? user.email}</span><button className="avatar" onClick={() => selectTab("profile")} title="Open profile">{profile?.profile_image_url ? <img src={profile.profile_image_url} alt="" /> : initials(user.displayName ?? user.email ?? "CourtMate")}</button></> : <button className="sign-in-button" onClick={() => void signIn()}>{authReady ? "Sign in with Google" : "Loading auth"}</button>}</div>
      </nav>
      {user && <nav className="app-tabs" aria-label="CourtMate sections">
        <button className={activeTab === "social" ? "active" : ""} onClick={() => selectTab("social")} title="Home"><span className="app-tab-icon"><HomeIcon /></span><span>Home</span></button>
        <button className={activeTab === "games" ? "active" : ""} onClick={() => selectTab("games")} title="Your games"><span className="app-tab-icon"><PickleballPaddleIcon /></span><span>Games</span></button>
        <button className={activeTab === "tournaments" ? "active" : ""} onClick={() => selectTab("tournaments")} title="Tournaments"><span className="app-tab-icon"><TournamentIcon /></span><span>Tournaments</span></button>
        <button className={activeTab === "home" ? "active" : ""} onClick={() => selectTab("home")} title="Assistant"><span className="app-tab-icon"><ChatIcon /></span><span>Assistant</span></button>
      </nav>}
      {activeTab === "home" && !user && <section className="guest-home" aria-label="CourtMate introduction">
        <div className="guest-copy"><span className="eyebrow">PLAY BETTER TOGETHER</span><h1>Find a game.<br /><em>Find your people.</em></h1><p>CourtMate listens to how you want to play and finds groups that fit your pace, people, and place.</p><div className="guest-cta"><button className="guest-sign-in" type="button" onClick={() => void signIn()}>Continue with Google <span>↗</span></button><button className="guest-about" type="button" onClick={() => selectTab("about")}>How it works</button></div><div className="guest-trust"><span>VOICE + TEXT</span><span>BETTER-FIT GROUPS</span><span>CMR BY PLAYING</span></div></div>
        <div className="guest-preview" aria-label="Example CourtMate conversation"><div className="guest-preview-top"><span>COURTMATE</span><span>AI GROUP CONCIERGE</span></div><div className="guest-preview-thread"><div className="guest-preview-message guest-preview-user">Intermediate tennis near Whitefield, Saturday morning. Social, not too serious.</div><div className="guest-preview-message guest-preview-assistant"><strong>3 groups worth a look</strong><span>Matched by skill, timing, distance, and group vibe.</span></div><div className="guest-preview-options"><div><span className="guest-preview-date">SAT · 8:00 AM</span><strong>Whitefield Rally</strong><small>4.6 CMR fit · 2 spots open</small></div><div><span className="guest-preview-date">SAT · 9:30 AM</span><strong>Easy Baseline</strong><small>4.2 CMR fit · 1 spot open</small></div></div><div className="guest-preview-footer"><span>See the group before you join</span><i>→</i></div></div></div>
      </section>}
      {activeTab === "home" && user && <>
      <section className={`home-chat-page ${searchScope === "out_of_scope" ? "chat-out-of-scope" : ""} ${groupProposal && !showCraftedGame ? "creation-in-progress" : ""}`} aria-label="CourtMate game concierge">
        <header className="chat-page-header"><div><span className="eyebrow">COURTMATE CONCIERGE</span></div></header>
        <div className="chat-thread" aria-live="polite">
          {!chatMessages.length && !sessions.length && !groupProposal && <div className="chat-message assistant-message welcome-message"><span className="chat-message-mark">CM</span><div><strong>What are you looking for?</strong><p>Try &ldquo;tennis this Saturday at 8 AM near Whitefield, intermediate and social&rdquo;.</p><div className="chat-suggestions"><button type="button" onClick={() => { const prompt = `Find a casual ${selectedSport} game this weekend near ${profile?.area ?? "Whitefield"}`; setQuery(prompt); void search(undefined, prompt); }}>Weekend game</button><button type="button" onClick={() => { const prompt = `Find a ${selectedSport} game this evening near ${profile?.area ?? "Whitefield"}`; setQuery(prompt); void search(undefined, prompt); }}>Play tonight</button></div></div></div>}
          {chatMessages.map((message) => <div className={`chat-message ${message.role}-message`} key={message.id}><span className="chat-message-mark">{message.role === "assistant" ? "CM" : initials(user?.displayName ?? "You")}</span><div>{message.imageUrl && <img className="chat-attachment-preview" src={message.imageUrl} alt="Attached wearable screenshot" />}{message.role === "assistant" ? <AssistantReply text={message.text} /> : <p>{message.text}</p>}</div></div>)}
          {loading && <TennisBallLoader label="Finding your best match" detail={loadingMessage} />}
          {!loading && searchScope === "court_discovery" && sessions.length > 0 && <div className="chat-message assistant-message result-message"><span className="chat-message-mark">CM</span><div className="result-message-body"><p>{`I found ${sessions.length} option${sessions.length === 1 ? "" : "s"}. Pick one to see the group, request a spot, or skip it.`}</p><div className="chat-choice-list">{sessions.map((session, index) => <article className={`session-card chat-choice-card ${index === 0 ? "featured" : ""}`} key={session.id}><div className="card-top"><span className="date-badge"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(session.session_date).getDate()}</small></span><div className="session-meta"><div className="session-title-row"><h3>{session.group_name}</h3><span className="fit-score">{Math.round(session.score * 100)}% fit</span></div><p>{sportLabel(session.sport)} · {session.start_time} – {session.end_time} · {session.area}</p></div></div><div className="tags"><span className="tag rating">{sportLabel(session.sport)} skill {session.skill_min.toFixed(1)}–{session.skill_max.toFixed(1)}</span><span className="tag">{session.style}</span><span className="tag open">{session.open_slots} spots open</span></div><div className="chat-choice-actions"><button className="join-button secondary-button" onClick={() => void viewGroup(session.id)} disabled={loadingGroupId === session.id}>{loadingGroupId === session.id ? "Loading" : "View group"}</button>{session.organizer_id === user?.uid ? <span className="status-badge approved">Your group</span> : <><button className="join-button chat-join-action" onClick={() => void joinSession(session.id, session.group_name, session.organizer_id)}>{session.open_slots > 0 ? "Request to join" : "Join waitlist"}<span>↗</span></button><button className="chat-skip-action" type="button" onClick={() => skipSession(session.id)}>Not for me</button></>}</div></article>)}</div></div></div>}
        {!loading && tournamentResults.length > 0 && <div className="chat-message assistant-message result-message"><span className="chat-message-mark">CM</span><div className="result-message-body"><p>I found {tournamentResults.length} tournament{tournamentResults.length === 1 ? "" : "s"}. Choose one to see the draw, register, or share it.</p><div className="chat-tournament-list">{tournamentResults.map((tournament) => { const registeredCount = tournament.registration_ids.length; const registrationLabel = tournament.my_registration_status === "pending" ? "Request pending" : tournament.my_registration_status === "registered" ? "Registered" : tournament.my_registration_status === "waitlisted" ? "Waitlisted" : `${Math.max(tournament.capacity - registeredCount, 0)} spots`; return <article className="chat-tournament-card" key={tournament.id}><div className="chat-tournament-date"><strong>{new Date(`${tournament.tournament_date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(`${tournament.tournament_date}T00:00:00`).getDate()}</span></div><div className="chat-tournament-copy"><strong>{tournament.name}</strong><small>{sportLabel(tournament.sport)} · {tournament.area}{tournament.venue_name ? ` · ${tournament.venue_name}` : ""}</small><span>{registrationLabel} · {tournament.status.replace("_", " ")}</span></div><button type="button" className="chat-tournament-open" onClick={() => openTournamentFromChat(tournament.id)}>View &amp; register <span>→</span></button></article>; })}</div></div></div>}
          {!loading && lastChatRequest && <div className="chat-request-confirmation" role="status"><div><strong>{lastChatRequest.status === "waitlisted" ? "You are on the waitlist" : "Request sent"}</strong><span>{lastChatRequest.name}</span></div><button type="button" onClick={() => { setGamesViewTab(lastChatRequest.status === "approved" ? "upcoming" : "pending"); selectTab("games"); }}>Check status in Games <span>→</span></button></div>}
          {!loading && showCraftedGame && groupProposal && <div className="chat-message assistant-message crafted-game-message"><span className="chat-message-mark">CM</span><div className="crafted-game-card"><span className="eyebrow">GAME PLAN</span><p className="create-guide-question">{creationQuestion()}</p><strong>{groupNameDraft}</strong><p>{creationPlanLabel()}</p><div className="tags"><span className="tag rating">{createGroupDraft.skill_min}–{createGroupDraft.skill_max} skill</span><span className="tag">{createGroupDraft.style}</span></div><div className="crafted-game-actions"><button className="join-button create-button" type="button" onClick={() => void createGroup()} disabled={createGroupLoading}>{createGroupLoading ? "Creating..." : "Create game"}<span>↗</span></button></div></div></div>}
          {!loading && <div className="chat-quick-replies" aria-label="Suggested replies">{quickPrompts().map((prompt) => <button type="button" key={prompt} onClick={() => prompt === "Create this game" ? openCreateGame() : sendQuickPrompt(prompt)}>{prompt}</button>)}</div>}
        </div>
        {joiningSessionId && <div className="chat-request-sending" role="status">Sending your request to the group...</div>}
        <form className="chat-input-shell" onSubmit={handleChatSubmit}><div className="chat-input-label"><span className="chat-message-mark">{initials(user?.displayName ?? "You")}</span><span>{feedbackSessionId ? "Tell me how the game felt" : scoreSessionId ? "Say who played and the score" : showCraftedGame ? "Tell me what to change, or post this game" : "Describe your next game or ask about your performance"}</span></div><div className="chat-input-row"><label className="chat-attach-action" aria-label="Attach wearable screenshot" title="Attach a wearable screenshot"><input type="file" accept="image/jpeg, image/png, image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachPerformanceScreenshot(file); event.currentTarget.value = ""; }} /><span>+</span></label><input value={query} placeholder={feedbackSessionId ? "Great, fair, or not for me" : scoreSessionId ? "e.g. Rhea beat Ananya 11 to 8" : showCraftedGame ? "Change the time, area, level, or vibe" : "Ask for a game or performance"} onChange={(event) => { setQuery(event.target.value); const detectedSport = sportFromText(event.target.value); if (detectedSport) selectDetectedSport(detectedSport); }} aria-label="Describe the game you want to find or ask about performance" /><button type="button" className={`mic ${isListening ? "listening" : ""}`} onClick={startVoice} aria-label={isListening ? "Listening" : "Search by voice"} title={isListening ? "Listening" : "Search by voice"}><MicrophoneIcon /></button><button className="chat-send-action" type="submit" disabled={loading || !query.trim()} aria-label="Send message">{loading ? "..." : "↗"}</button></div></form>
      </section>
      {scorePickerOpen && <div className="home-score-picker" aria-label="Choose an active game to score"><div className="home-score-picker-heading"><span className="eyebrow">{scorePickerSport ? `YOUR ${sportLabel(scorePickerSport).toUpperCase()} GAMES` : "CHOOSE AN ACTIVE GAME"}</span><button type="button" onClick={() => { setScorePickerOpen(false); setScorePickerSport(null); }} aria-label="Close score picker">×</button></div>{visibleScoreGames.length ? visibleScoreGames.map((game) => <button className="home-score-session" type="button" key={game.id} onClick={() => chooseScoreSession(game)}><span className="date-badge"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(game.session_date).getDate()}</small></span><span><strong>{game.group_name}</strong><small>{sportLabel(game.sport)} · {game.start_time}–{game.end_time} · {game.area}</small></span><b>→</b></button>) : <p className="home-score-empty">No active {scorePickerSport ? `${sportLabel(scorePickerSport)} ` : ""}games found yet.</p>}</div>}
      {feedbackPickerOpen && <div className="home-score-picker" aria-label="Choose a completed game for feedback"><div className="home-score-picker-heading"><span className="eyebrow">REVIEW A GAME</span><button type="button" onClick={() => setFeedbackPickerOpen(false)} aria-label="Close feedback picker">×</button></div>{pastGames.map((pastGame) => <button className="home-score-session" type="button" key={pastGame.session.id} onClick={() => void chooseFeedbackSession(pastGame)}><span className="date-badge"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><small>{new Date(pastGame.session.session_date).getDate()}</small></span><span><strong>{pastGame.session.group_name}</strong><small>{sportLabel(pastGame.session.sport)} · {pastGame.session.start_time}–{pastGame.session.end_time} · {pastGame.session.area}</small></span><b>→</b></button>)}</div>}
      </>}

      {activeTab === "social" && user && <SocialFeed apiUrl={apiUrl} currentUserId={user.uid} currentUserName={user.displayName ?? user.email ?? "CourtMate player"} currentProfileImage={profile?.profile_image_url} authorizedFetch={authorizedFetch} onToast={setToast} onViewProfile={(playerId) => void viewPlayerProfile(playerId)} />}

      {activeTab === "games" && <section className="page-view games-page">
        <button type="button" className="section-fab games-fab" onClick={toggleGamesForm} aria-label={showCreateGame ? "Close game form" : "Create a game"} title={showCreateGame ? "Close" : "Create a game"}>{showCreateGame ? "×" : "+"}</button>
        {showCreateGame && <form className="game-create-form" onSubmit={(event) => { event.preventDefault(); void createGroup(); }}><div className="game-create-heading"><div><span className="kicker">NEW GAME</span><h2>Create a game</h2></div><span>Fill in the details</span></div><div className="game-create-grid"><label className="game-create-wide"><span>Game name</span><input value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} placeholder="Whitefield Saturday Rally" required /></label><label><span>Sport</span><select value={createGroupDraft.sport} onChange={(event) => changeCreateSport(event.target.value as Sport)}>{sportOptions.map((sport) => <option value={sport.value} key={sport.value}>{sport.label}</option>)}</select></label><label><span>Area</span><input value={createGroupDraft.area} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, area: event.target.value })} placeholder="Any neighbourhood" required /></label><label><span>Date</span><input type="date" min={localDateInput()} value={createGroupDraft.session_date} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, session_date: event.target.value })} required /></label><label><span>Starts</span><input type="time" value={createGroupDraft.start_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, start_time: event.target.value })} required /></label><label><span>Ends</span><input type="time" value={createGroupDraft.end_time} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, end_time: event.target.value })} required /></label><label><span>Skill from</span><input type="number" min="1" max="8" step="0.1" value={createGroupDraft.skill_min} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, skill_min: event.target.value })} required /></label><label><span>Skill to</span><input type="number" min="1" max="8" step="0.1" value={createGroupDraft.skill_max} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, skill_max: event.target.value })} required /></label><label><span>Game mood</span><select value={createGroupDraft.style} onChange={(event) => setCreateGroupDraft({ ...createGroupDraft, style: event.target.value as CreateGroupDraft["style"] })}><option value="casual">Casual</option><option value="social">Social</option><option value="competitive">Competitive</option></select></label></div><div className="game-create-actions"><button className="dark-button" type="submit" disabled={createGroupLoading}>{createGroupLoading ? "Creating..." : "Create game"}<span>→</span></button><button className="text-button" type="button" onClick={() => setShowCreateGame(false)}>Cancel</button></div></form>}
        <div className="tournament-tabs" role="tablist" aria-label="Game views"><button className={gamesViewTab === "explore" ? "active" : ""} onClick={() => { setGamesViewTab("explore"); void loadExploreGames(); }}>Explore <span>{exploreGames.length}</span></button><button className={gamesViewTab === "upcoming" ? "active" : ""} onClick={() => setGamesViewTab("upcoming")}>Upcoming <span>{upcomingGames.length}</span></button><button className={gamesViewTab === "pending" ? "active" : ""} onClick={() => setGamesViewTab("pending")}>Pending <span>{requestedGames.length}</span></button><button className={gamesViewTab === "history" ? "active" : ""} onClick={() => setGamesViewTab("history")}>History <span>{pastGames.length}</span></button></div>
        {gamesViewTab === "explore" && <div className="game-list">{exploreLoading || activityLoading ? <TennisBallLoader label="Finding nearby games" /> : exploreGames.length ? exploreGames.map((game) => <article className="game-row" key={game.id}><div className="game-date"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p><small className="waitlist-summary">{Math.round(game.score * 100)}% match · {game.open_slots} spot{game.open_slots === 1 ? "" : "s"} open</small></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void viewGroup(game.id)} disabled={loadingGroupId === game.id}>{loadingGroupId === game.id ? "Loading..." : "View group"}</button><button className="game-share-button" onClick={() => shareGameOnWhatsApp(game)} aria-label={`Share ${game.group_name} on WhatsApp`}>WhatsApp <span>↗</span></button><button className="join-button" onClick={() => void joinSession(game.id, game.group_name, game.organizer_id)}>Request to join <span>→</span></button></div></article>) : <div className="page-empty"><strong>No nearby games match yet.</strong><p>Try a different sport or describe what you want on Home.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "upcoming" && <div className="game-list">{upcomingGames.length ? upcomingGames.map((game) => { const owned = myGroups.some((group) => group.id === game.id); const groupRequests = incomingRequests.filter(({ session }) => session.id === game.id); const waitlistCount = game.waitlist_player_ids?.length ?? 0; return <article className="game-row upcoming-game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p><small className="waitlist-summary">{waitlistCount ? `${waitlistCount} player${waitlistCount === 1 ? "" : "s"} on waitlist` : "Waitlist empty"}</small></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="game-share-button" onClick={() => shareGameOnWhatsApp(game)} aria-label={`Share ${game.group_name} on WhatsApp`}>WhatsApp <span>↗</span></button>{owned && <button className="manage-group-button" onClick={() => { if (managedGroupId === game.id) { setManagedGroupId(null); setJoinRequests([]); } else { setManagedGroupId(game.id); void loadJoinRequests(game.id); } }}>{managedGroupId === game.id ? "Hide requests" : `${groupRequests.length ? `${groupRequests.length} ` : ""}Review requests`}</button>}{!owned && <><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></>}</div>{managedGroupId === game.id && <div className="inline-request-list">{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved", game.id)}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined", game.id)}>Decline</button></div>}</div>) : <p className="request-empty">No requests waiting for approval.</p>}</div>}</article>; }) : <div className="page-empty"><strong>No upcoming games yet.</strong><p>Join a nearby game or create a game from Home.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "pending" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p><small className="waitlist-summary">{request.status === "waitlisted" ? "On waitlist" : "Waiting for organizer approval"}</small></div><div className="game-row-actions"><span className={`status-badge ${request.status}`}>{request.status}</span><button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name, request.id)} disabled={leavingGameId === session.id}>{leavingGameId === session.id ? "Withdrawing..." : request.status === "waitlisted" ? "Leave waitlist" : "Withdraw request"}</button></div></article>) : <div className="page-empty"><strong>No pending requests.</strong><p>Games you request will stay here until the organizer approves them.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "history" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions"><span className="status-badge completed">Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No history yet.</strong><p>Played games and your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {activityLoading && gamesViewTab !== "explore" && <TennisBallLoader label="Refreshing games" />}
        {!activityLoading && gamesViewTab === "past" && <div className="game-list">{pastGames.length ? pastGames.map((pastGame) => <article className="game-row past-game-row" key={pastGame.session.id}><div className="game-date completed"><strong>{new Date(pastGame.session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(pastGame.session.session_date).getDate()}</span></div><div className="game-copy"><h2>{pastGame.session.group_name}</h2><p>{sportLabel(pastGame.session.sport)} · {pastGame.session.session_date} · {pastGame.session.area}</p><small className="past-game-summary">{pastGame.rank ? `You ranked #${pastGame.rank} of ${pastGame.group_size}` : "Unranked for this game"}{pastGame.score != null ? ` · ${pastGame.score.toFixed(1)} rating` : ""}</small></div><div className="game-row-actions"><span className="status-badge completed">Completed</span><button className="manage-group-button" onClick={() => void openGroupSpace(pastGame.session)}>View ranking</button></div></article>) : <div className="page-empty"><strong>No past games yet.</strong><p>Once a completed game has been played, your group ranking will appear here.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "requested" && <div className="game-list">{requestedGames.length ? requestedGames.map(({ request, session }) => <article className="game-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{session.group_name}</h2><p>{sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><span className={`status-badge ${request.status}`}>{request.status}</span>{["pending", "waitlisted"].includes(request.status) && <button className="leave-game-button" onClick={() => void leaveGame(session.id, session.group_name, request.id)}>{request.status === "waitlisted" ? "Leave waitlist" : "Withdraw request"}</button>}</div></article>) : <div className="page-empty"><strong>No open requests.</strong><p>Confirmed games live in the Confirmed tab. New requests will appear here until the organizer responds.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "confirmed" && <div className="game-list">{approvedGames.length ? approvedGames.map((game) => <article className="game-row" key={game.id}><div className="game-date confirmed"><strong>{new Date(game.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(game.session_date).getDate()}</span></div><div className="game-copy"><h2>{game.group_name}</h2><p>{sportLabel(game.sport)} · {game.session_date} · {game.start_time}–{game.end_time} · {game.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(game)}>Group space</button><button className="calendar-button" onClick={() => addToGoogleCalendar(game)}>Add to Google Calendar</button><button className="leave-game-button" onClick={() => void leaveGame(game.id, game.group_name)}>Back out</button></div></article>) : <div className="page-empty"><strong>No confirmed games yet.</strong><p>Once an organizer accepts your request, the game will appear here ready for your calendar.</p><button className="dark-button" onClick={() => selectTab("home")}>Find a game <span>→</span></button></div>}</div>}
        {!activityLoading && gamesViewTab === "incoming" && <div className="game-list">{incomingRequests.length ? incomingRequests.map(({ request, session }) => <article className="game-row incoming-request-row" key={request.id}><div className="game-date"><strong>{new Date(session.session_date).toLocaleDateString("en-IN", { weekday: "short" })}</strong><span>{new Date(session.session_date).getDate()}</span></div><div className="game-copy"><h2>{request.player_display_name ?? request.player_id.slice(0, 10)} wants to join</h2><p>{session.group_name} · {sportLabel(session.sport)} · {session.start_time}–{session.end_time} · {session.area}</p></div><div className="game-row-actions"><button className="manage-group-button" onClick={() => void decideJoinRequest(request.id, "approved", session.id)}>Approve</button><button className="leave-game-button" onClick={() => void decideJoinRequest(request.id, "declined", session.id)}>Decline</button></div></article>) : <div className="page-empty"><strong>No incoming requests.</strong><p>When someone requests to join one of your groups, you can approve them here.</p><button className="dark-button" onClick={() => { selectTab("home"); openCreateGame(); }}>Create a game <span>→</span></button></div>}</div>}
        {myGroups.length > 0 && <div className="organizer-page-card"><div><span className="kicker">ORGANIZER</span><h2>Your groups</h2><p>Manage requests, chat, and feedback for groups you created.</p></div>{myGroups.map((group) => <div className="organizer-page-row" key={group.id}><div><strong>{group.group_name}</strong><small>{sportLabel(group.sport)} · {group.session_date} · {group.confirmed_player_ids.length}/{group.capacity} players</small></div><div className="organizer-page-actions"><button className="manage-group-button" onClick={() => void openGroupSpace(group)}>Group space</button><button className="manage-group-button" onClick={() => { setManagedGroupId(group.id); void loadJoinRequests(group.id); }}>Requests</button></div></div>)}{managedGroupId && <div className="request-card page-request-card"><p>Requests for <strong>{myGroups.find((group) => group.id === managedGroupId)?.group_name ?? "your group"}</strong>. Approve a player before they join.</p>{requestsLoading ? <p className="request-empty">Loading requests...</p> : joinRequests.length ? <div className="request-list">{joinRequests.map((request) => <div className="request-row" key={request.id}><div><strong>{request.player_display_name ?? request.player_id.slice(0, 10)}</strong><small className={`status-badge ${request.status}`}>{request.status}</small></div>{request.status === "pending" && <div className="request-actions"><button onClick={() => void decideJoinRequest(request.id, "approved")}>Approve</button><button onClick={() => void decideJoinRequest(request.id, "declined")}>Decline</button></div>}</div>)}</div> : <p className="request-empty">No requests waiting for approval.</p>}</div>}</div>}
      </section>}

      {activeTab === "tournaments" && <TournamentHub apiUrl={apiUrl} currentUserId={user?.uid} playerArea={profile?.area} authorizedFetch={authorizedFetch} onToast={setToast} onSignIn={() => void signIn()} />}

        {activeTab === "about" && <section className="page-view about-page">
        <div className="about-hero"><span className="kicker">THE COURTMATE IDEA</span><h1>Don&apos;t just find a court. <em>Find your people.</em></h1><p>CourtMate helps you discover the group you&apos;ll actually enjoy playing with. Ask by voice or text, see the best-fit games, and let your rating improve through real play.</p><img className="about-logo" src="/courtmate-logo.png" alt="CourtMate logo" /></div>
        <div className="about-grid"><article><span>01</span><h2>Describe the game</h2><p>Say the sport, place, time, and energy you want. Gemini understands the request and turns it into a search.</p></article><article><span>02</span><h2>See the group fit</h2><p>Results are ranked using distance, skill, availability, reliability, and the people you have enjoyed playing with.</p></article><article><span>03</span><h2>Keep the group alive</h2><p>Request to join, invite friends, coordinate in the group space, and replace dropouts without rebuilding a WhatsApp group.</p></article><article><span>04</span><h2>Build CMR by playing</h2><p>Your CourtMate Rating is computed from completed games and peer feedback. It is not a number you have to invent for yourself.</p></article></div>
        <div className="about-note"><strong>Works with your existing habits.</strong><span>Use WhatsApp to share the link. Book on Playo, Hudle, or directly with the venue. CourtMate is the layer that helps make the game worth showing up for.</span></div>
      </section>}

      {activeTab === "profile" && !viewedProfile && <section className="page-view profile-page">
        {user && profile && <section className="profile-photo-card"><div className="profile-photo-avatar profile-avatar-editor">{profile.profile_image_url ? <img src={profile.profile_image_url} alt={`${profile.display_name} profile`} /> : initials(profile.display_name)}<label className="profile-avatar-edit" title="Change profile photo"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProfilePicture(file); event.currentTarget.value = ""; }} disabled={profilePictureUploading} /><span aria-hidden="true">{profilePictureUploading ? "..." : "✎"}</span></label></div><div className="profile-photo-copy"><strong>{profile.display_name}</strong><small className="profile-bio-line">{profile.bio?.trim() || "Add a short bio"}</small>{socialProfile && <div className="profile-photo-social-stats"><span><strong>{totalGames}</strong><span>Games</span></span><button type="button" onClick={() => openConnections("followers")}><strong>{socialProfile.followers_count}</strong><span>Followers</span></button><button type="button" onClick={() => openConnections("following")}><strong>{socialProfile.following_count}</strong><span>Following</span></button></div>}<div className="profile-photo-actions"><button type="button" className="profile-edit-bio-button" onClick={() => setBioEditing((editing) => !editing)}>{bioEditing ? "Cancel" : "Edit bio"}</button>{profile.profile_image_url && <button type="button" className="profile-remove-photo" onClick={() => void removeProfilePicture()} disabled={profilePictureUploading}>Use initials</button>}<button type="button" className="profile-calendar-inline-button" onClick={openProfileCalendar}><span className="profile-calendar-inline-icon">▦</span><span>Activity calendar</span></button></div>{bioEditing && <form className="profile-bio-inline-editor" onSubmit={saveBio}><textarea value={profileDraft.bio} maxLength={240} placeholder="A line about how you like to play..." onChange={(event) => setProfileDraft({ ...profileDraft, bio: event.target.value })} aria-label="Profile bio" autoFocus /><button className="dark-button" type="submit" disabled={bioSaving}>{bioSaving ? "Saving..." : "Save bio"}<span>→</span></button></form>}</div></section>}
        {user && profile && <ProfileSportOverview profile={profile} sports={activeSports} selectedSport={profileSelectedSport} onSelect={setProfileSport} />}
        {user && profile && <section className="profile-insights">{!ratedSports.length && <div className="cmr-no-ratings"><strong>No sport ratings yet.</strong><span>Complete a game and submit feedback to build your first CMR.</span></div>}{socialProfile && <div className="social-stats"><button type="button" onClick={() => openConnections("followers")}><strong>{socialProfile.followers_count}</strong><span>Followers</span></button><button type="button" onClick={() => openConnections("following")}><strong>{socialProfile.following_count}</strong><span>Following</span></button><span><strong>{Math.round(profile.reliability * 100)}%</strong><span>Reliability</span></span></div>}{socialProfile && <div className="profile-activity-grid"><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Show up streak</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={socialProfile.activity_by_date} /></section><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">RECENT GAMES</span><h2>{sportLabel(profileSelectedSport)} sessions</h2></div><span>{profileRecentGames.length} shown</span></div><RecentGames games={socialProfile.recent_games} sport={profileSelectedSport} /></section></div>}{ratedSports.length > 0 && <><p className="cmr-summary">Current {sportLabel(profileSelectedSport)} CMR: <strong>{currentCmr?.toFixed(1) ?? "not built"} / 100</strong><span>{currentCmr ? ` · ${cmrLevelForRating(currentCmr)}` : " · Search by level to get started"}</span></p>{profileHistory.length ? <><div className="cmr-chart-heading"><div><span className="kicker">CMR JOURNEY · {sportLabel(profileSelectedSport).toUpperCase()}</span><h2>Rating trajectory</h2></div><span>{profileHistory.length} game{profileHistory.length === 1 ? "" : "s"}</span></div><div className="cmr-chart"><svg viewBox="0 0 560 190" role="img" aria-label={`CMR trend for ${sportLabel(profileSelectedSport)}`}><line x1="28" y1="28" x2="28" y2="162" /><line x1="28" y1="162" x2="532" y2="162" /><polyline points={cmrGraphPoints(profileHistory)} fill="none" /><g>{profileHistory.filter((point) => point.rating != null).map((point, index, ratedHistory) => { const x = ratedHistory.length === 1 ? 280 : 28 + (index * 504) / (ratedHistory.length - 1); const y = 162 - ((Math.max(0, Math.min(100, point.rating ?? 0)) * 134) / 100); return <circle key={point.session_id} cx={x} cy={y} r="5"><title>{`${point.group_name}: ${(point.rating ?? 0).toFixed(1)} CMR (${(point.delta ?? 0) >= 0 ? "+" : ""}${(point.delta ?? 0).toFixed(1)})`}</title></circle>; })}</g></svg><div className="cmr-chart-scale"><span>100</span><span>0</span></div></div><div className="cmr-history-list">{profileHistory.slice().reverse().map((point) => <article className="cmr-history-row" key={point.session_id}><div><strong>{point.group_name}</strong><small>{point.session_date} · {point.game_rating != null ? `game rating ${point.game_rating.toFixed(1)} / 100` : "awaiting player feedback"}</small></div><div>{point.rating != null ? <b>{point.rating.toFixed(1)}</b> : <b>--</b>}{point.delta != null ? <span className={`cmr-history-change ${point.delta >= 0 ? "positive" : "negative"}`}><span aria-hidden="true">{point.delta > 0 ? "↑" : point.delta < 0 ? "↓" : "•"}</span>{point.delta >= 0 ? "+" : ""}{point.delta.toFixed(1)}</span> : <span className="cmr-history-change pending"><span aria-hidden="true">•</span>Pending</span>}</div></article>)}</div></> : <div className="profile-empty-insight"><strong>Your {sportLabel(profileSelectedSport)} CMR starts after your first completed game.</strong><p>CMR changes will appear here after scores and player feedback are confirmed.</p></div>}</>}</section>}
        {!user && <div className="page-empty"><strong>Sign in to manage your profile.</strong><p>Your rating and preferences are saved securely to your CourtMate profile.</p><button className="dark-button" onClick={() => void signIn()}>Sign in with Google <span>→</span></button></div>}
        {user && profile && <form id="profile-preferences" className="profile-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Locality label</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation}>{profileDraft.latitude != null && profileDraft.longitude != null ? "Location saved" : "Use my current location"}<span>⌖</span></button></label></div><label><span>How do you like to play?</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>When are you usually available?</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save profile <span>→</span></button><button className="text-button" type="button" onClick={() => void signOutUser()}>Sign out</button></div></form>}
      </section>}

      {connectionsOpen && user && <section className="utility-page connections-page" aria-labelledby="connections-title"><div className="connections-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><h1 id="connections-title">Connections</h1></div><div className="connections-tabs" role="tablist" aria-label="Connections"><button type="button" className={connectionsTab === "following" ? "active" : ""} onClick={() => setConnectionsTab("following")} role="tab" aria-selected={connectionsTab === "following"}>Following</button><button type="button" className={connectionsTab === "followers" ? "active" : ""} onClick={() => setConnectionsTab("followers")} role="tab" aria-selected={connectionsTab === "followers"}>Followers</button></div>{connectionsLoading ? <div className="connections-loader"><TennisBallLoader label="Loading connections" detail="Finding your people..." /></div> : connectionsError ? <div className="utility-empty"><h2>Could not load connections</h2><p>Try again and we&apos;ll fetch your latest following list.</p><button className="dark-button" type="button" onClick={() => void loadConnections(connectionsTab)}>Try again <span>→</span></button></div> : connections.length ? <div className="connections-list" role="tabpanel">{connections.map((connection) => <article className="connection-row" key={connection.id}><button type="button" className="connection-profile" onClick={() => void viewPlayerProfile(connection.id)} disabled={profileLoadingId === connection.id} aria-label={`View ${connection.display_name}'s profile`}><span className="connection-avatar">{connection.profile_image_url ? <img src={connection.profile_image_url} alt="" /> : initials(connection.display_name)}</span><span><strong>{connection.display_name}</strong><small>{connection.area || "CourtMate player"}</small></span></button><button type="button" className={`connection-follow-button ${connection.is_following ? "following" : ""}`} onClick={() => void toggleConnection(connection)} disabled={profileLoadingId === `connection-${connection.id}`}>{profileLoadingId === `connection-${connection.id}` ? "..." : connection.is_following ? "Following" : "Follow"}</button></article>)}</div> : <div className="utility-empty"><h2>No {connectionsTab} yet</h2><p>{connectionsTab === "following" ? "Follow players from games and social to see them here." : "When players follow you, they&apos;ll appear here."}</p></div>}</section>}
      {notificationsOpen && user && <section className="utility-page notifications-page" aria-labelledby="notifications-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">COURTMATE ALERTS</span><h1 id="notifications-title">Notifications</h1><p>Requests, follows, and games that fit.</p></div><button className="utility-refresh-button" type="button" onClick={() => void loadNotifications()}>Refresh</button></div>{notifications.length ? <div className="utility-notification-list">{notifications.map((notification) => <div className={`notification-item ${notification.read ? "" : "unread"}`} key={notification.id}><button type="button" className="notification-item-main" onClick={() => openNotification(notification)}><span className="notification-mark"><BellIcon /></span><span><strong>{notification.title}</strong><small>{notification.message}</small><em>{new Date(notification.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</em></span></button>{notification.kind === "join_request" && notification.request_id && <div className="notification-actions"><button type="button" onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "approved"); }}>Confirm</button><button type="button" onClick={(event) => { event.stopPropagation(); void decideNotificationRequest(notification, "declined"); }}>Decline</button></div>}</div>)}</div> : <div className="utility-empty"><span className="utility-empty-icon"><BellIcon /></span><h2>No alerts yet</h2><p>We&apos;ll let you know when a game fits your preferences or someone requests to join.</p></div>}</section>}
      {settingsOpen && user && profile && <section className="utility-page settings-page" aria-labelledby="settings-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">PREFERENCES</span><h1 id="settings-title">Your play setup</h1><p>Set the details CourtMate uses to find better games.</p></div></div><form className="settings-form" onSubmit={saveProfile}><div className="profile-form-grid"><label><span>Age</span><input type="number" min="13" max="100" step="1" value={profileDraft.age} onChange={(event) => setProfileDraft({ ...profileDraft, age: event.target.value })} placeholder="Optional" /></label><label><span>Gender</span><select value={profileDraft.gender} onChange={(event) => setProfileDraft({ ...profileDraft, gender: event.target.value as ProfileDraft["gender"] })}><option value="">Prefer not to say</option>{genderOptions.map((gender) => <option value={gender.value} key={gender.value}>{gender.label}</option>)}</select></label><label><span>Locality</span><input value={profileDraft.area} onChange={(event) => setProfileDraft({ ...profileDraft, area: event.target.value })} placeholder="e.g. Whitefield" /></label><label><span>Travel radius (km)</span><input type="number" min="1" max="100" step="1" value={profileDraft.travel_radius_km} onChange={(event) => setProfileDraft({ ...profileDraft, travel_radius_km: event.target.value })} placeholder="10" /></label><label className="location-field"><span>Map coordinates</span><button className="location-button" type="button" onClick={useCurrentLocation}>{profileDraft.latitude != null && profileDraft.longitude != null ? "Location saved" : "Use current location"}<span>⌖</span></button></label></div><fieldset className="settings-preference-fieldset"><legend>Who do you like to play with?</legend><label><span>Age range</span><select value={profileDraft.preferred_age_range} onChange={(event) => setProfileDraft({ ...profileDraft, preferred_age_range: event.target.value as AgeRange })}>{ageRangeOptions.map((range) => <option value={range.value} key={range.value}>{range.label}</option>)}</select></label><span className="settings-hint">Leave gender unselected to keep every group in the mix.</span><div className="gender-preference-grid">{genderOptions.map((gender) => <label className={`availability-option ${profileDraft.preferred_genders.includes(gender.value) ? "selected" : ""}`} key={gender.value}><input type="checkbox" checked={profileDraft.preferred_genders.includes(gender.value)} onChange={() => togglePreferredGender(gender.value)} /><span>{gender.label}</span></label>)}</div></fieldset><label><span>Play style</span><select value={profileDraft.style} onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value as ProfileDraft["style"] })}><option value="casual">Casual and easy-going</option><option value="social">Social and chatty</option><option value="competitive">Competitive and focused</option></select></label><fieldset><legend>Usual availability</legend><div className="availability-grid">{availabilityOptions.map((slot) => <label className={`availability-option ${profileDraft.availability.includes(slot) ? "selected" : ""}`} key={slot}><input type="checkbox" checked={profileDraft.availability.includes(slot)} onChange={() => toggleAvailability(slot)} /><span>{slot}</span></label>)}</div></fieldset><div className="profile-form-actions"><button className="dark-button" type="submit">Save preferences <span>→</span></button></div></form></section>}
      {settingsOpen && user && profile && <section className="settings-privacy-panel" aria-labelledby="privacy-settings-title"><div className="settings-privacy-heading"><div><span className="kicker">PRIVACY</span><h2 id="privacy-settings-title">Who can see your play?</h2></div><span>Applies to new games</span></div><form className="settings-privacy-form" onSubmit={saveProfile}><label className="settings-toggle-row"><span><strong>Private profile</strong><small>Hide your profile from recommendations and public player pages.</small></span><input type="checkbox" checked={profileDraft.is_profile_private} onChange={(event) => setProfileDraft({ ...profileDraft, is_profile_private: event.target.checked })} /><span className="settings-switch" aria-hidden="true" /></label><label><span>Default game session visibility</span><select value={profileDraft.default_session_visibility} onChange={(event) => setProfileDraft({ ...profileDraft, default_session_visibility: event.target.value as SessionVisibility })}><option value="public">Everyone nearby</option><option value="followers">Followers of the organizer</option><option value="private">Only players in the game</option></select></label><p className="settings-hint">This controls who can discover the games you create. You can still share a private game directly.</p><button className="dark-button" type="submit">Save privacy settings <span>→</span></button></form></section>}
      {calendarOpen && user && socialProfile && <section className="utility-page profile-calendar-page" aria-labelledby="profile-calendar-title"><div className="utility-page-header"><button className="utility-back-button" type="button" onClick={closeUtilityPage} aria-label="Go back">←</button><div><span className="kicker">YOUR ACTIVITY</span><h1 id="profile-calendar-title">Activity calendar</h1><p>Every game day, all in one place.</p></div></div><ActivityCalendar activity={socialProfile.activity_by_date} /></section>}
      {viewedGroup && <div className="group-modal-backdrop" onClick={() => setViewedGroup(null)}><section className="group-modal" onClick={(event) => event.stopPropagation()}><div className="group-modal-header"><div><span className="kicker">{sportLabel(viewedGroup.session.sport).toUpperCase()} GROUP PREVIEW</span><h2>{viewedGroup.session.group_name}</h2><p>{viewedGroup.session.start_time} – {viewedGroup.session.end_time} · {viewedGroup.session.area}</p></div><button className="close-button" onClick={() => setViewedGroup(null)}>×</button></div><div className="group-summary"><span><strong>{viewedGroup.members.length}/{viewedGroup.session.capacity}</strong><small>PLAYERS</small></span><span><strong>{viewedGroup.session.skill_min.toFixed(1)}–{viewedGroup.session.skill_max.toFixed(1)}</strong><small>SKILL BAND</small></span><span><strong>{viewedGroup.session.style}</strong><small>INTENSITY</small></span></div><div className="member-grid">{viewedGroup.members.map((member) => { const memberCmr = member.cmr_ratings?.[viewedGroup.session.sport]; const memberRating = memberCmr ?? member.sport_ratings?.[viewedGroup.session.sport] ?? (viewedGroup.session.sport === "pickleball" ? member.dupr_rating : undefined); return <button type="button" className="member-profile profile-link" key={member.id} onClick={() => void viewPlayerProfile(member.id)} disabled={profileLoadingId === member.id} aria-label={`View ${member.display_name}'s profile`}><div className="member-profile-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</div><div className="member-profile-copy"><h3>{member.display_name}</h3><p>{member.area} · {member.style}</p><div className="member-profile-meta"><strong>{memberCmr != null ? `CMR ${memberCmr.toFixed(1)} / 100` : memberRating ? `${sportLabel(viewedGroup.session.sport)} ${memberRating.toFixed(1)}` : "Rating not set"}</strong><span>{member.is_following ? "Following" : "View profile"}</span></div></div></button>; })}</div><div className="modal-game-actions"><button className="game-share-button" onClick={() => shareGameOnWhatsApp(viewedGroup.session)}>Share on WhatsApp <span>↗</span></button>{viewedGroup.session.organizer_id === user?.uid ? <span className="status-badge approved modal-join">You created this group</span> : <button className="dark-button modal-join" onClick={() => void joinSession(viewedGroup.session.id, viewedGroup.session.group_name, viewedGroup.session.organizer_id)}>Request to join <span>→</span></button>}</div></section></div>}
      {activeTab === "profile" && viewedProfile && <section className="page-view profile-page public-profile-page" aria-labelledby="public-profile-title"><header className="public-profile-header"><button type="button" className="profile-back-button" onClick={closePlayerProfile} aria-label="Back to previous page">←</button><div><span className="kicker">PLAYER PROFILE</span><h1 id="public-profile-title">{viewedProfile.display_name}</h1><p>{viewedProfile.area} · {viewedProfile.style}</p></div></header><section className="public-profile-identity"><div className="profile-photo-avatar">{viewedProfile.profile_image_url ? <img src={viewedProfile.profile_image_url} alt={`${viewedProfile.display_name} profile`} /> : initials(viewedProfile.display_name)}</div><div><strong>{viewedProfile.display_name}</strong><span>{viewedProfile.area}</span><div className="social-profile-stats"><span><strong>{totalGamesFor(viewedProfile)}</strong><small>GAMES</small></span><span><strong>{viewedProfile.followers_count}</strong><small>FOLLOWERS</small></span><span><strong>{viewedProfile.following_count}</strong><small>FOLLOWING</small></span></div></div></section><section className="public-profile-activity"><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">ACTIVITY</span><h2>Activity calendar</h2></div><span>Last 12 weeks</span></div><ActivityHeatmap activity={viewedProfile.activity_by_date} /></section><section className="profile-activity-card"><div className="profile-activity-heading"><div><span className="kicker">RECENT GAMES</span><h2>Where they played</h2></div><span>{viewedProfile.recent_games.length} shown</span></div><RecentGames games={viewedProfile.recent_games} /></section></section><section className="profile-sport-ratings public-profile-ratings"><span className="kicker">CMR BY SPORT</span>{Object.entries(viewedProfile.cmr_ratings ?? {}).length ? <div className="profile-rating-list">{Object.entries(viewedProfile.cmr_ratings ?? {}).map(([sport, rating]) => <span key={sport}><strong>{sportLabel(sport)}</strong><b>{rating.toFixed(1)} / 100</b></span>)}</div> : <p>No CMR ratings yet. Completed games will build them here.</p>}</section><div className="public-profile-follow"><button className={`dark-button ${viewedProfile.is_following ? "following-button" : ""}`} onClick={() => void toggleFollowProfile()}>{viewedProfile.is_following ? "Following" : "Follow"}<span>{viewedProfile.is_following ? "✓" : "+"}</span></button>{viewedProfile.follows_you && <span className="follows-you">Follows you</span>}</div></section>}
      {workspaceGroup && workspaceLoading && <section className="group-space-page group-space-loading"><TennisBallLoader label="Opening group space" detail="Loading chat, players, and the latest leaderboard..." /></section>}
      {workspaceGroup && !workspaceLoading && <GroupSpace group={workspaceGroup} members={groupMembers} waitlist={groupWaitlist} posts={chatPosts} leaderboard={groupLeaderboard} localLeaderboard={localLeaderboard} currentUserId={user?.uid} apiUrl={apiUrl} authorizedFetch={authorizedFetch} onClose={() => setWorkspaceGroup(null)} onRefresh={() => void openGroupSpace(workspaceGroup)} onMarkDone={() => markGroupDone(workspaceGroup.id)} onChatPosted={(post) => setChatPosts((current) => current.some((item) => item.id === post.id) ? current : [...current, post])} onToast={setToast} onViewProfile={(playerId) => void viewPlayerProfile(playerId)} activityProofs={activityProofs} onAnalyzeActivityProof={(file) => analyzeActivityScreenshot(file, workspaceGroup.id)} />}
      {rankingGame && <section className="ranking-page" aria-labelledby="ranking-page-title"><header className="ranking-page-header"><button type="button" className="ranking-back-button" onClick={() => { if (window.location.hash) window.history.back(); else setRankingGame(null); }} aria-label="Back to games">←</button><div><span className="kicker">FINAL RANKINGS</span><h1 id="ranking-page-title">{rankingGame.group_name}</h1><p>{sportLabel(rankingGame.sport)} · {rankingGame.session_date} · {rankingGame.area}</p></div></header>{rankingLoading ? <div className="ranking-loading"><TennisBallLoader label="Loading rankings" detail="Fetching the final table..." /></div> : <div className="ranking-page-content"><section className="ranking-only-panel"><div className="ranking-only-heading"><div><span className="kicker">THIS GAME</span><h2>Group rankings</h2></div><span>{rankingEntries.length} players</span></div>{rankingEntries.length ? <div className="ranking-only-list">{rankingEntries.map((entry) => <div className={`ranking-only-row ${entry.player.id === user?.uid ? "current" : ""}`} key={entry.player.id}><span className="ranking-only-rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div> : <p className="ranking-only-empty">No confirmed rankings for this game yet.</p>}</section>{localRankingEntries.length > 0 && <section className="ranking-only-panel local-ranking-only-panel"><div className="ranking-only-heading"><div><span className="kicker">{rankingGame.area.toUpperCase()} · LOCAL</span><h2>Local leaderboard</h2></div><span>Top {Math.min(localRankingEntries.length, 5)}</span></div><div className="ranking-only-list">{localRankingEntries.slice(0, 5).map((entry) => <div className="ranking-only-row" key={entry.player.id}><span className="ranking-only-rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div></section>}</div>}</section>}
      {toast && !(activeTab === "home" && user) && <div className="toast">{toast}</div>}
    </main>
  );
}

interface SpeechRecognitionEvent extends Event { results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } } }
interface SpeechRecognition { lang: string; interimResults: boolean; continuous: boolean; onstart: () => void; onend: () => void; onresult: (event: SpeechRecognitionEvent) => void; start: () => void }

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join("") || "CM").toUpperCase();
}
