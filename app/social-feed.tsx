"use client";

import { FormEvent, useEffect, useState } from "react";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { storage } from "../firebase";
import { TennisBallLoader } from "./tennis-ball-loader";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";

type SocialPost = {
  id: string;
  player_id: string;
  player_display_name: string;
  profile_image_url?: string | null;
  sport: Sport;
  session_id?: string | null;
  session_name?: string | null;
  session_date?: string | null;
  session_area?: string | null;
  caption: string;
  media_url?: string | null;
  media_type?: "image" | "video" | null;
  media_urls?: string[];
  like_count: number;
  comment_count: number;
  share_count: number;
  liked_by_me: boolean;
  created_at: string;
  activity_type?: "post" | "session";
  session_status?: string | null;
  session_players?: SessionActivityPlayer[];
  session_leaderboard?: SessionLeaderboardEntry[];
};

const SOCIAL_FEED_CACHE_TTL_MS = 120_000;
const SOCIAL_RECOMMENDATIONS_CACHE_TTL_MS = 300_000;
const socialFeedRequests = new Map<string, Promise<SocialPost[]>>();
const socialRecommendationRequests = new Map<string, Promise<RecommendedPlayer[]>>();

type FeedFilter = "all" | "following" | "personal";

function socialFeedCacheKey(playerId: string, feed: FeedFilter) {
  return `courtmate:social-feed:${playerId}:${feed}`;
}

function socialRecommendationsCacheKey(playerId: string) {
  return `courtmate:social-recommendations:${playerId}`;
}

type SessionActivityPlayer = {
  id: string;
  display_name: string;
  profile_image_url?: string | null;
  cmr_rating?: number | null;
};

type SessionLeaderboardEntry = SessionActivityPlayer & {
  rank: number;
  player_id: string;
  wins: number;
  losses: number;
  table_points: number;
  cmr_delta?: number | null;
};

type SocialComment = {
  id: string;
  post_id: string;
  player_id: string;
  player_display_name: string;
  profile_image_url?: string | null;
  message: string;
  created_at: string;
};

type RecommendedPlayer = {
  id: string;
  display_name: string;
  profile_image_url?: string | null;
  area: string;
  cmr_ratings: Record<string, number>;
  followers_count: number;
  is_following: boolean;
};

type SocialFeedProps = {
  apiUrl: string;
  currentUserId: string;
  currentUserName: string;
  currentProfileImage?: string | null;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onToast: (message: string) => void;
  onViewProfile: (playerId: string) => void;
};

const sports: { value: Sport; label: string }[] = [
  { value: "pickleball", label: "Pickleball" },
  { value: "badminton", label: "Badminton" },
  { value: "tennis", label: "Tennis" },
  { value: "padel", label: "Padel" },
  { value: "squash", label: "Squash" },
  { value: "table_tennis", label: "Table tennis" },
];

const sportLabel = (sport: Sport) => sports.find((item) => item.value === sport)?.label ?? sport;

function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "C";
}

function relativeTime(value: string) {
  const difference = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(difference / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Avatar({ name, imageUrl, large = false }: { name: string; imageUrl?: string | null; large?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  return <span className={`social-avatar ${large ? "large" : ""}`}>{imageUrl && !imageFailed ? <img src={imageUrl} alt="" onError={() => setImageFailed(true)} /> : initials(name)}</span>;
}

function FireIcon() {
  return <svg className="social-fire-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.4 2.5c.4 3.5-1.8 4.8-3.1 6.7-.8 1.1-.9 2.2-.5 3.2.4-1 1.2-1.8 2.3-2.4-.2 2.3.8 3.1 1.9 4.1.8.7 1.3 1.5 1.3 2.5 0 .5-.1.9-.3 1.3 1.9-.8 3.2-2.6 3.2-4.8 0-1.3-.5-2.7-1.6-4.2 3.1 1.9 4.8 4.5 4.8 7.4 0 4.3-3.5 7.5-8 7.5s-8-3.1-8-7.5c0-3.8 2.4-6.8 6.6-9.2-.1 1.4.2 2.4.8 3.1.7-2.1 1.3-4.4.6-7.7Z" fill="currentColor" /></svg>;
}

function CommentIcon() {
  return <svg className="social-comment-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4v-14Z" /></svg>;
}

function ShareIcon() {
  return <svg className="social-share-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M5 13v7h14v-7" /></svg>;
}

function SocialPostEngagement({ post, currentUserName, currentProfileImage, comments, commentDraft, fireBusy, commentsBusy, commentBusy, shareBusy, shareLabel = "Share", onFire, onShare, onFocusComments, onLoadComments, onCommentDraftChange, onAddComment, onViewProfile }: {
  post: SocialPost;
  currentUserName: string;
  currentProfileImage?: string | null;
  comments?: SocialComment[];
  commentDraft: string;
  fireBusy: boolean;
  commentsBusy: boolean;
  commentBusy: boolean;
  shareBusy: boolean;
  shareLabel?: string;
  onFire: (post: SocialPost) => void;
  onShare: (post: SocialPost) => void;
  onFocusComments: (postId: string) => void;
  onLoadComments: (postId: string) => void;
  onCommentDraftChange: (postId: string, value: string) => void;
  onAddComment: (event: FormEvent, postId: string) => void;
  onViewProfile: (playerId: string) => void;
}) {
  return <>
    <div className="social-post-actions">
      <button type="button" className={post.liked_by_me ? "fire-active" : ""} onClick={() => onFire(post)} disabled={fireBusy} aria-pressed={post.liked_by_me} aria-label={post.liked_by_me ? "Remove fire" : "Fire this post"} title={post.liked_by_me ? "Remove fire" : "Fire this post"}><FireIcon />{post.like_count > 0 && <b>{post.like_count}</b>}</button>
      <button type="button" onClick={() => onFocusComments(post.id)} aria-label={`${post.comment_count} comments`} title="Comments"><CommentIcon />{post.comment_count > 0 && <b>{post.comment_count}</b>}</button>
      <button type="button" onClick={() => onShare(post)} disabled={shareBusy} aria-label={shareLabel} title={shareLabel}><ShareIcon />{post.share_count > 0 && <b>{post.share_count}</b>}</button>
    </div>
    {post.liked_by_me && <div className="social-post-liked-by"><Avatar name={currentUserName} imageUrl={currentProfileImage} /><span>Liked by <strong>{currentUserName}</strong>{post.like_count > 1 && <> and {post.like_count - 1} other{post.like_count === 2 ? "" : "s"}</>}</span></div>}
    <div className="social-comments">
      <div className="social-comments-heading"><strong>Comments</strong><span>{post.comment_count}</span></div>
      <div className="social-comments-list">
        {commentsBusy ? <small>Loading comments...</small> : comments ? comments.length ? comments.map((comment) => <div className="social-comment" key={comment.id}><button type="button" className="social-comment-profile" onClick={() => onViewProfile(comment.player_id)} aria-label={`View ${comment.player_display_name}'s profile`}><Avatar name={comment.player_display_name} imageUrl={comment.profile_image_url} /></button><div><button type="button" className="social-comment-name" onClick={() => onViewProfile(comment.player_id)}>{comment.player_display_name}</button><p>{comment.message}</p></div></div>) : <small>No comments yet. Start the conversation.</small> : <button type="button" className="social-comments-load" onClick={() => onLoadComments(post.id)}>{post.comment_count > 0 ? `View ${post.comment_count} comment${post.comment_count === 1 ? "" : "s"}` : "View comments"}</button>}
      </div>
      <form className="social-comment-form" onSubmit={(event) => onAddComment(event, post.id)}>
        <Avatar name={currentUserName} imageUrl={currentProfileImage} />
        <input id={`social-comment-input-${post.id}`} value={commentDraft} onChange={(event) => onCommentDraftChange(post.id, event.target.value)} placeholder="Add a comment..." maxLength={300} aria-label="Add a comment" />
        <button type="submit" disabled={!commentDraft.trim() || commentBusy}>↗</button>
      </form>
    </div>
  </>;
}

function SessionActivityCard({ post, currentUserId, currentUserName, currentProfileImage, comments, commentDraft, fireBusy, commentsBusy, commentBusy, shareBusy, onFire, onViewProfile, onShare, onLoadComments, onFocusComments, onCommentDraftChange, onAddComment, onAddPhoto, photoBusy }: { post: SocialPost; currentUserId: string; currentUserName: string; currentProfileImage?: string | null; comments?: SocialComment[]; commentDraft: string; fireBusy: boolean; commentsBusy: boolean; commentBusy: boolean; shareBusy: boolean; onFire: (post: SocialPost) => void; onViewProfile: (playerId: string) => void; onShare: (post: SocialPost) => void; onLoadComments: (postId: string) => void; onFocusComments: (postId: string) => void; onCommentDraftChange: (postId: string, value: string) => void; onAddComment: (event: FormEvent, postId: string) => void; onAddPhoto: (post: SocialPost, file: File) => void; photoBusy: boolean }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const mediaUrls = post.media_urls ?? [];
  const status = post.session_status === "in_progress" ? "Playing now" : post.session_status === "completed" ? "Final leaderboard" : "Upcoming game";
  const players = post.session_players ?? [];
  const leaderboard = post.session_leaderboard ?? [];
  const canAddPhoto = players.some((player) => player.id === currentUserId);
  return <article className="social-post-card social-session-activity-card" id={`social-session-${post.session_id}`}>
    <header className="social-post-header"><button type="button" className="social-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><Avatar name={post.player_display_name} imageUrl={post.profile_image_url} large /><span><strong>{post.player_display_name}</strong><small>{post.session_status === "completed" ? "Completed rally" : status} · {sportLabel(post.sport)}</small></span></button><span className="social-post-sport">{sportLabel(post.sport)}</span></header>
    <div className="social-session-activity-intro"><strong>{post.caption}</strong><span>{post.session_name} · {post.session_date} · {post.session_area}</span></div>
    <div className="social-session-leaderboard"><div className="social-session-leaderboard-heading"><strong>Session leaderboard</strong><span>{post.session_status === "completed" ? "Based on this game" : "Current CMR order"}</span></div>{leaderboard.length ? leaderboard.map((entry) => { const delta = entry.cmr_delta ?? 0; return <button type="button" className={`social-session-rank-row rank-${entry.rank <= 3 ? entry.rank : "other"}`} key={entry.player_id} onClick={() => onViewProfile(entry.player_id)} aria-label={`View ${entry.display_name}'s profile to follow`} title={`View ${entry.display_name}'s profile`}><b className="social-session-rank-badge">{entry.rank}</b><Avatar name={entry.display_name} imageUrl={entry.profile_image_url} /><span><strong>{entry.display_name}</strong><small>{entry.cmr_rating != null ? `${entry.cmr_rating.toFixed(1)} CMR` : "CMR building"}</small></span><em>{entry.cmr_rating != null ? entry.cmr_rating.toFixed(1) : "--"}<small className={`social-session-trend ${delta > 0 ? "up" : delta < 0 ? "down" : "steady"}`}>{entry.cmr_delta == null ? "·" : `${delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} ${Math.abs(delta).toFixed(1)}`}</small></em></button>; }) : <span className="social-session-empty">CMR rankings appear after players complete feedback.</span>}</div>
    {post.media_url && <div className="social-post-media social-session-media"><img src={(mediaUrls.length ? mediaUrls[photoIndex % mediaUrls.length] : post.media_url)} alt={`Court moment ${photoIndex + 1} from ${post.session_name ?? "this game"}`} />{mediaUrls.length > 1 && <div className="social-session-carousel-controls"><button type="button" onClick={() => setPhotoIndex((index) => (index - 1 + mediaUrls.length) % mediaUrls.length)} aria-label="Previous game photo">←</button><span>{(photoIndex % mediaUrls.length) + 1} / {mediaUrls.length}</span><button type="button" onClick={() => setPhotoIndex((index) => (index + 1) % mediaUrls.length)} aria-label="Next game photo">→</button></div>}</div>}
    <SocialPostEngagement post={post} currentUserName={currentUserName} currentProfileImage={currentProfileImage} comments={comments} commentDraft={commentDraft} fireBusy={fireBusy} commentsBusy={commentsBusy} commentBusy={commentBusy} shareBusy={shareBusy} shareLabel="Share leaderboard" onFire={onFire} onShare={onShare} onFocusComments={onFocusComments} onLoadComments={onLoadComments} onCommentDraftChange={onCommentDraftChange} onAddComment={onAddComment} onViewProfile={onViewProfile} />
    <div className="social-session-actions">{canAddPhoto && <label className={`social-session-photo-button ${photoBusy ? "busy" : ""}`}><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) onAddPhoto(post, file); }} disabled={photoBusy} />{photoBusy ? "Adding photo..." : "+ Add photo"}</label>}</div>
  </article>;
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, maxLines);
  if (lines.length > maxLines) visibleLines[maxLines - 1] = `${visibleLines[maxLines - 1].slice(0, -3)}...`;
  visibleLines.forEach((item, index) => context.fillText(item, x, y + index * lineHeight));
}

function loadShareLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = "/courtmate-header-logo-light.png";
  });
}

async function createShareCard(post: SocialPost): Promise<File | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const background = context.createLinearGradient(0, 0, 1080, 1350);
  background.addColorStop(0, "#fbfff0");
  background.addColorStop(1, "#dceea0");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#192321";
  context.globalAlpha = .08;
  context.beginPath();
  context.arc(945, 150, 220, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  const logo = await loadShareLogo();
  context.fillStyle = "#192321";
  context.font = "800 34px Manrope, sans-serif";
  if (logo) {
    const logoWidth = 330;
    const logoHeight = logoWidth * (logo.naturalHeight / logo.naturalWidth);
    context.drawImage(logo, (canvas.width - logoWidth) / 2, 48, logoWidth, logoHeight);
  } else {
    context.textAlign = "center";
    context.fillText("COURTMATE", canvas.width / 2, 94);
    context.textAlign = "left";
  }
  context.fillStyle = "#718f12";
  context.fillRect(80, 184, 70, 10);
  context.fillStyle = "#192321";
  context.font = "700 23px 'DM Mono', monospace";
  const hasLeaderboard = Boolean(post.session_leaderboard?.length);
  const isLeaderboard = post.activity_type === "session" || hasLeaderboard;
  context.fillText(isLeaderboard ? "SESSION LEADERBOARD" : "COURT MOMENT", 80, 245);
  context.font = "800 54px Manrope, sans-serif";
  wrapCanvasText(context, post.session_name ?? `${sportLabel(post.sport)} session`, 80, 325, 900, 66, 2);
  context.fillStyle = "#65736e";
  context.font = "500 25px Manrope, sans-serif";
  wrapCanvasText(context, isLeaderboard ? `${sportLabel(post.sport)} · ${post.session_date ?? "Today"} · ${post.session_area ?? "CourtMate"}` : post.caption, 80, isLeaderboard ? 465 : 445, 900, 38, 4);

  if (isLeaderboard) {
    const entries = (post.session_leaderboard ?? []).slice(0, 5);
    const leader = entries[0];
    context.fillStyle = "#192321";
    context.globalAlpha = .8;
    context.beginPath();
    context.arc(910, 570, 100, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.fillStyle = "#718f12";
    context.font = "700 19px 'DM Mono', monospace";
    context.fillText("TODAY'S COURT ORDER", 80, 555);
    if (leader) {
      context.fillStyle = "#c9e86b";
      context.beginPath();
      context.roundRect(70, 585, 940, 120, 28);
      context.fill();
      context.fillStyle = "#192321";
      context.font = "800 23px 'DM Mono', monospace";
      context.fillText("01  MVP OF THE MATCH", 105, 625);
      context.font = "800 43px Manrope, sans-serif";
      context.fillText(leader.display_name, 105, 675);
      context.textAlign = "right";
      context.font = "800 36px 'DM Mono', monospace";
      context.fillText(leader.cmr_rating != null ? leader.cmr_rating.toFixed(1) : "--", 970, 650);
      context.font = "700 17px 'DM Mono', monospace";
      context.fillText(leader.cmr_delta == null ? "CMR BUILDING" : `${leader.cmr_delta >= 0 ? "↑" : "↓"} ${Math.abs(leader.cmr_delta).toFixed(1)} CMR`, 970, 681);
      context.textAlign = "left";
    }
    entries.slice(1).forEach((entry, index) => {
      const top = 735 + index * 105;
      const isThird = entry.rank === 3;
      context.fillStyle = isThird ? "#fff3c7" : "rgba(255,255,250,.86)";
      context.beginPath();
      context.roundRect(70, top, 940, 82, 18);
      context.fill();
      context.fillStyle = entry.rank === 2 ? "#9a6b3a" : "#718f12";
      context.beginPath();
      context.arc(120, top + 41, 22, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#fffdf2";
      context.font = "800 19px 'DM Mono', monospace";
      context.textAlign = "center";
      context.fillText(String(entry.rank).padStart(2, "0"), 120, top + 48);
      context.textAlign = "left";
      context.fillStyle = "#192321";
      context.font = "800 27px Manrope, sans-serif";
      context.fillText(entry.display_name, 170, top + 38);
      context.fillStyle = "#65736e";
      context.font = "500 17px 'DM Mono', monospace";
      context.fillText(entry.cmr_rating != null ? `${entry.cmr_rating.toFixed(1)} CMR` : "CMR BUILDING", 170, top + 63);
      context.textAlign = "right";
      context.fillStyle = entry.cmr_delta == null ? "#718f12" : entry.cmr_delta >= 0 ? "#4e8a45" : "#c65e51";
      context.font = "800 19px 'DM Mono', monospace";
      context.fillText(entry.cmr_delta == null ? "·" : `${entry.cmr_delta >= 0 ? "↑" : "↓"} ${Math.abs(entry.cmr_delta).toFixed(1)}`, 970, top + 49);
      context.textAlign = "left";
    });
  } else {
    context.fillStyle = "#c9e86b";
    context.beginPath();
    context.roundRect(70, 720, 940, 265, 28);
    context.fill();
    context.fillStyle = "#192321";
    context.font = "800 28px Manrope, sans-serif";
    context.fillText(post.player_display_name, 106, 780);
    context.fillStyle = "#718f12";
    context.font = "700 22px 'DM Mono', monospace";
    context.fillText(sportLabel(post.sport).toUpperCase(), 106, 824);
    context.fillStyle = "#192321";
    context.font = "500 25px Manrope, sans-serif";
    wrapCanvasText(context, post.caption, 106, 890, 850, 35, 3);
  }

  context.fillStyle = "#192321";
  context.font = "700 22px 'DM Mono', monospace";
  context.fillText(`@${post.player_display_name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`, 80, 1270);
  context.textAlign = "right";
  context.fillText("COURTMATE", 1000, 1270);
  context.textAlign = "left";
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? new File([blob], "courtmate-share.png", { type: "image/png" }) : null), "image/png"));
}

export function SocialFeed({ apiUrl, currentUserId, currentUserName, currentProfileImage, authorizedFetch, onToast, onViewProfile, initialFilter = "all" }: SocialFeedProps & { initialFilter?: FeedFilter }) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>(initialFilter);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [comments, setComments] = useState<Record<string, SocialComment[]>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState("");
  const [recommendedPlayers, setRecommendedPlayers] = useState<RecommendedPlayer[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(true);

  function clearFeedCache() {
    try {
      window.sessionStorage.removeItem(socialFeedCacheKey(currentUserId, "all"));
      window.sessionStorage.removeItem(socialFeedCacheKey(currentUserId, "following"));
      window.sessionStorage.removeItem(socialFeedCacheKey(currentUserId, "personal"));
    } catch {
      // A disabled session storage should not affect feed interactions.
    }
  }

  async function loadFeed(nextFilter = feedFilter, force = false) {
    const key = socialFeedCacheKey(currentUserId, nextFilter);
    if (!force) {
      try {
        const raw = window.sessionStorage.getItem(key);
        const cached = raw ? JSON.parse(raw) as { cachedAt?: number; posts?: SocialPost[] } : null;
        if (cached?.cachedAt && Date.now() - cached.cachedAt < SOCIAL_FEED_CACHE_TTL_MS && Array.isArray(cached.posts)) {
          setPosts(cached.posts);
          setLoadError("");
          setLoading(false);
          return;
        }
        if (raw) window.sessionStorage.removeItem(key);
      } catch {
        // A disabled or full session storage should never block the feed.
      }
    }
    try {
      setLoading(true);
      setLoadError("");
      let request = socialFeedRequests.get(key);
      if (!request) {
        request = authorizedFetch(`${apiUrl}/v1/social/feed?feed=${nextFilter}`)
          .then(async (response) => {
            if (!response.ok) throw new Error("Social feed unavailable");
            const payload = await response.json() as { posts: SocialPost[] };
            if (!Array.isArray(payload.posts)) throw new Error("Social feed payload is invalid");
            return payload.posts;
          })
          .finally(() => socialFeedRequests.delete(key));
        socialFeedRequests.set(key, request);
      }
      const nextPosts = await request;
      setPosts(nextPosts);
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), posts: nextPosts }));
      } catch {
        // A disabled or full session storage should never block the feed.
      }
    } catch (error) {
      setPosts([]);
      setLoadError(error instanceof Error ? error.message : "Could not load the social feed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFeed();
    const timer = window.setTimeout(() => void loadRecommendedPlayers(), 250);
    return () => window.clearTimeout(timer);
  }, [currentUserId]);

  async function loadRecommendedPlayers(force = false) {
    const key = socialRecommendationsCacheKey(currentUserId);
    if (!force) {
      try {
        const raw = window.sessionStorage.getItem(key);
        const cached = raw ? JSON.parse(raw) as { cachedAt?: number; profiles?: RecommendedPlayer[] } : null;
        if (cached?.cachedAt && Date.now() - cached.cachedAt < SOCIAL_RECOMMENDATIONS_CACHE_TTL_MS && Array.isArray(cached.profiles)) {
          setRecommendedPlayers(cached.profiles.filter((profile) => !profile.is_following));
          setRecommendationsLoading(false);
          return;
        }
      } catch {
        // Recommendations are optional, so storage failures stay silent.
      }
    }
    try {
      setRecommendationsLoading(true);
      let request = socialRecommendationRequests.get(key);
      if (!request) {
        request = authorizedFetch(`${apiUrl}/v1/players/recommended`)
          .then(async (response) => {
            if (!response.ok) throw new Error("Recommendations unavailable");
            const payload = await response.json() as { profiles: RecommendedPlayer[] };
            return payload.profiles;
          })
          .finally(() => socialRecommendationRequests.delete(key));
        socialRecommendationRequests.set(key, request);
      }
      const profiles = await request;
      setRecommendedPlayers(profiles.filter((profile) => !profile.is_following));
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), profiles }));
      } catch {
        // Recommendations are optional, so storage failures stay silent.
      }
    } catch {
      setRecommendedPlayers([]);
    } finally {
      setRecommendationsLoading(false);
    }
  }

  async function followRecommendedPlayer(player: RecommendedPlayer) {
    try {
      setBusyAction(`follow-${player.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/players/${player.id}/follow`, { method: "POST" });
      if (!response.ok) throw new Error("Follow failed");
      setRecommendedPlayers((current) => current.filter((item) => item.id !== player.id));
      clearFeedCache();
      try {
        window.sessionStorage.removeItem(socialRecommendationsCacheKey(currentUserId));
      } catch {
        // The visible recommendation list is already updated optimistically.
      }
      onToast("Follow request sent");
    } catch {
      onToast("Could not follow this player");
    } finally {
      setBusyAction("");
    }
  }

  async function toggleFire(post: SocialPost) {
    const optimisticPost = {
      ...post,
      liked_by_me: !post.liked_by_me,
      like_count: post.liked_by_me ? Math.max(0, post.like_count - 1) : post.like_count + 1,
    };
    setPosts((current) => current.map((item) => item.id === post.id ? optimisticPost : item));
    try {
      setBusyAction(`fire-${post.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${post.id}/like`, { method: "POST" });
      if (!response.ok) throw new Error("Fire reaction failed");
      const updated = await response.json() as SocialPost;
      setPosts((current) => current.map((item) => item.id === updated.id ? updated : item));
      clearFeedCache();
    } catch {
      setPosts((current) => current.map((item) => item.id === post.id ? post : item));
      onToast("Could not update the fire reaction");
    } finally {
      setBusyAction("");
    }
  }

  async function loadComments(postId: string) {
    if (comments[postId]) return;
    try {
      setBusyAction(`comments-${postId}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${postId}/comments`);
      if (!response.ok) throw new Error("Comments unavailable");
      const payload = await response.json() as { comments: SocialComment[] };
      setComments((current) => ({ ...current, [postId]: payload.comments }));
    } catch {
      onToast("Could not load comments");
    } finally {
      setBusyAction("");
    }
  }

  function focusComments(postId: string) {
    void loadComments(postId);
    window.requestAnimationFrame(() => document.getElementById(`social-comment-input-${postId}`)?.focus());
  }

  async function addComment(event: FormEvent, postId: string) {
    event.preventDefault();
    const message = commentDrafts[postId]?.trim();
    if (!message) return;
    try {
      setBusyAction(`comment-${postId}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${postId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error("Comment failed");
      const comment = await response.json() as SocialComment;
      setComments((current) => ({ ...current, [postId]: [...(current[postId] ?? []), comment] }));
      setPosts((current) => current.map((post) => post.id === postId ? { ...post, comment_count: post.comment_count + 1 } : post));
      setCommentDrafts((current) => ({ ...current, [postId]: "" }));
      clearFeedCache();
    } catch {
      onToast("Could not add your comment");
    } finally {
      setBusyAction("");
    }
  }

  async function sharePost(post: SocialPost) {
    const shareUrl = `${window.location.origin}/#social-post-${post.id}`;
    try {
      setBusyAction(`share-${post.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${post.id}/share`, { method: "POST" });
      if (!response.ok) throw new Error("Share failed");
      const updated = await response.json() as SocialPost;
      setPosts((current) => current.map((item) => item.id === updated.id ? updated : item));
      clearFeedCache();
      const image = await createShareCard(post);
      if (navigator.share && image && (!navigator.canShare || navigator.canShare({ files: [image] }))) {
        await navigator.share({ title: `${post.player_display_name} on CourtMate`, text: post.caption, url: shareUrl, files: [image] });
      } else if (navigator.share) {
        await navigator.share({ title: `${post.player_display_name} on CourtMate`, text: post.caption, url: shareUrl });
      } else {
        await navigator.clipboard?.writeText(shareUrl);
        if (image) {
          const downloadUrl = URL.createObjectURL(image);
          const link = document.createElement("a");
          link.href = downloadUrl;
          link.download = "courtmate-share.png";
          link.click();
          URL.revokeObjectURL(downloadUrl);
        }
        onToast("Share card downloaded and link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast("Could not share this post");
    } finally {
      setBusyAction("");
    }
  }

  async function shareSessionLeaderboard(post: SocialPost) {
    const shareUrl = `${window.location.origin}/#social-session-${post.session_id}`;
    const leaderboardText = (post.session_leaderboard ?? []).slice(0, 5).map((entry) => `${entry.rank}. ${entry.display_name}${entry.cmr_rating != null ? ` (${entry.cmr_rating.toFixed(1)} CMR)` : ""}`).join("\n");
    const text = `${post.session_name ?? "CourtMate game"} leaderboard\n${leaderboardText}`;
    try {
      setBusyAction(`share-${post.id}`);
      const image = await createShareCard(post);
      if (navigator.share && image && (!navigator.canShare || navigator.canShare({ files: [image] }))) {
        await navigator.share({ title: `${post.session_name ?? "CourtMate game"} leaderboard`, text, url: shareUrl, files: [image] });
      } else if (navigator.share) {
        await navigator.share({ title: `${post.session_name ?? "CourtMate game"} leaderboard`, text, url: shareUrl });
      } else {
        await navigator.clipboard?.writeText(`${text}\n${shareUrl}`);
        if (image) {
          const downloadUrl = URL.createObjectURL(image);
          const link = document.createElement("a");
          link.href = downloadUrl;
          link.download = "courtmate-leaderboard.png";
          link.click();
          URL.revokeObjectURL(downloadUrl);
        }
        onToast("Leaderboard card downloaded and link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast("Could not share this leaderboard");
    } finally {
      setBusyAction("");
    }
  }

  async function addSessionPhoto(post: SocialPost, file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      onToast("Choose a JPG, PNG, or WebP image for this game post");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      onToast("Photo must be smaller than 8 MB");
      return;
    }
    try {
      setBusyAction(`photo-${post.id}`);
      if (!storage) throw new Error("Firebase Storage is not configured");
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const mediaRef = ref(storage, `social-posts/${currentUserId}/${crypto.randomUUID()}.${extension}`);
      const upload = await uploadBytes(mediaRef, file, { contentType: file.type });
      const mediaUrl = await getDownloadURL(upload.ref);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caption: `A moment from ${post.session_name ?? "our CourtMate game"}.`, sport: post.sport, session_id: post.session_id, media_url: mediaUrl, media_type: "image" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Photo could not be posted");
      }
      const createdPost = await response.json() as SocialPost;
      setPosts((current) => current.map((item) => item.session_id === post.session_id ? { ...item, media_url: createdPost.media_url, media_type: createdPost.media_type } : item));
      clearFeedCache();
      onToast("Photo added to this completed game");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not add the photo");
    } finally {
      setBusyAction("");
    }
  }

  function changeFilter(nextFilter: FeedFilter) {
    setFeedFilter(nextFilter);
    void loadFeed(nextFilter);
  }

  return <section className="social-page" aria-label="Rally Circles">
    <div className="social-page-heading">
      <div className="rally-circles-intro"><h1>Rally Circles</h1><p>Your people, your sport, your next game. Completed games become shared CMR stories, so every rally leaves your circle stronger.</p></div>
      <div className="social-feed-tabs" role="tablist" aria-label="Rally feed"><button className={feedFilter === "all" ? "active" : ""} type="button" onClick={() => changeFilter("all")} role="tab" aria-selected={feedFilter === "all"}>Discover</button><button className={feedFilter === "following" ? "active" : ""} type="button" onClick={() => changeFilter("following")} role="tab" aria-selected={feedFilter === "following"}>Following</button><button className={feedFilter === "personal" ? "active" : ""} type="button" onClick={() => changeFilter("personal")} role="tab" aria-selected={feedFilter === "personal"}>My rallies</button></div>
    </div>

    {feedFilter === "all" && !recommendationsLoading && recommendedPlayers.length > 0 && <section className="social-recommendations" aria-labelledby="social-recommendations-title">
      <div className="social-recommendations-heading"><div><h2 id="social-recommendations-title">People worth playing with</h2></div><span>Nearby and active</span></div>
      <div className="social-recommendations-list">{recommendedPlayers.map((player) => { const ratedSports = Object.keys(player.cmr_ratings); const ratingLabel = ratedSports.length ? `${sportLabel(ratedSports[0] as Sport)} ${Math.round(player.cmr_ratings[ratedSports[0]])}` : "New to CMR"; return <article className="social-recommendation-card" key={player.id}><button type="button" className="social-recommendation-profile" onClick={() => onViewProfile(player.id)}><Avatar name={player.display_name} imageUrl={player.profile_image_url} large /><span><strong>{player.display_name}</strong><small>{player.area} · {ratingLabel}</small></span></button><button type="button" className="social-follow-button" onClick={() => void followRecommendedPlayer(player)} disabled={busyAction === `follow-${player.id}`}>{busyAction === `follow-${player.id}` ? "..." : "+ Follow"}</button></article>; })}</div>
    </section>}

    <div className="social-feed-list" aria-busy={loading}>
      {loading && <div className="social-feed-loader"><TennisBallLoader label="Rallying..." /></div>}
      {!loading && loadError && <div className="social-feed-error" role="alert"><strong>Social is taking a breather.</strong><p>We couldn&apos;t load the latest court activity.</p><button type="button" onClick={() => void loadFeed(feedFilter, true)}>Try again <span>↗</span></button></div>}
      {!loading && !loadError && posts.length === 0 && <div className="social-empty"><strong>{feedFilter === "personal" ? "Your rallies start with a completed game." : feedFilter === "following" ? "Follow players to build your Rally Circle." : "Completed rallies from your circle will appear here."}</strong><p>Each update includes the people, the game, and the CMR movement it created.</p></div>}
      {!loading && posts.map((post) => <SessionActivityCard key={post.id} post={post} currentUserId={currentUserId} currentUserName={currentUserName} currentProfileImage={currentProfileImage} comments={comments[post.id]} commentDraft={commentDrafts[post.id] ?? ""} fireBusy={busyAction === `fire-${post.id}`} commentsBusy={busyAction === `comments-${post.id}`} commentBusy={busyAction === `comment-${post.id}`} shareBusy={busyAction === `share-${post.id}`} onFire={(socialPost) => void toggleFire(socialPost)} onViewProfile={onViewProfile} onShare={(sessionPost) => void shareSessionLeaderboard(sessionPost)} onLoadComments={(postId) => void loadComments(postId)} onFocusComments={focusComments} onCommentDraftChange={(postId, value) => setCommentDrafts((current) => ({ ...current, [postId]: value }))} onAddComment={(event, postId) => void addComment(event, postId)} onAddPhoto={(sessionPost, file) => void addSessionPhoto(sessionPost, file)} photoBusy={busyAction === `photo-${post.id}`} />)}
    </div>
  </section>;
}
