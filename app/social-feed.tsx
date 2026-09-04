"use client";

import { FormEvent, useEffect, useState } from "react";
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
  player_cmr?: number | null;
  player_cmr_delta?: number | null;
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

function newestFirst(posts: SocialPost[]) {
  return [...posts].sort((left, right) => {
    const rightTime = Date.parse(right.created_at);
    const leftTime = Date.parse(left.created_at);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function hasFeedStateChanged<T>(current: T, next: T) {
  return JSON.stringify(current) !== JSON.stringify(next);
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
  mutual_connections?: string[];
};

type SocialFeedProps = {
  apiUrl: string;
  currentUserId: string;
  currentUserName: string;
  currentProfileImage?: string | null;
  weeklyStreak?: number;
  weeklyStreakActive?: boolean;
  activityByDate?: Record<string, number>;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onToast: (message: string) => void;
  onViewProfile: (playerId: string) => void;
  onInvalidate?: (keys: string[]) => void;
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

function StreakIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.4 2.5c.4 3.5-1.8 4.8-3.1 6.7-.8 1.1-.9 2.2-.5 3.2.4-1 1.2-1.8 2.3-2.4-.2 2.3.8 3.1 1.9 4.1.8.7 1.3 1.5 1.3 2.5 0 .5-.1.9-.3 1.3 1.9-.8 3.2-2.6 3.2-4.8 0-1.3-.5-2.7-1.6-4.2 3.1 1.9 4.8 4.5 4.8 7.4 0 4.3-3.5 7.5-8 7.5s-8-3.1-8-7.5c0-3.8 2.4-6.8 6.6-9.2-.1 1.4.2 2.4.8 3.1.7-2.1 1.3-4.4.6-7.7Z" fill="currentColor" /></svg>;
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

function postDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return relativeTime(value);
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", month: "short", day: "numeric", year: "numeric" }).format(date);
}

function Avatar({ name, imageUrl, large = false }: { name: string; imageUrl?: string | null; large?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  return <span className={`social-avatar ${large ? "large" : ""}`}>{imageUrl && !imageFailed ? <img src={imageUrl} alt="" onError={() => setImageFailed(true)} /> : initials(name)}</span>;
}

function LikeIcon() {
  return <svg className="social-like-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.6 10.2H4.2v9.3h3.4M7.6 19.5h8.7a2.1 2.1 0 0 0 2-1.5l1.5-5.4a2.1 2.1 0 0 0-2-2.7h-4l.5-3.3a2.4 2.4 0 0 0-2.4-2.8L7.6 10.2v9.3Z" /></svg>;
}

function MoreIcon() {
  return <svg className="social-post-more-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>;
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
      <button type="button" className={post.liked_by_me ? "fire-active" : ""} onClick={() => onFire(post)} disabled={fireBusy} aria-pressed={post.liked_by_me} aria-label={post.liked_by_me ? "Unlike this post" : "Like this post"} title={post.liked_by_me ? "Unlike" : "Like"}><LikeIcon />{post.like_count > 0 && <b>{post.like_count}</b>}</button>
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
        <button type="submit" className="social-comment-submit" disabled={!commentDraft.trim() || commentBusy}>{commentBusy ? "Posting..." : "Post"}</button>
      </form>
    </div>
  </>;
}

function SessionActivityCard({ post, currentUserName, currentProfileImage, comments, commentDraft, fireBusy, commentsBusy, commentBusy, shareBusy, onFire, onViewProfile, onShare, onLoadComments, onFocusComments, onCommentDraftChange, onAddComment }: { post: SocialPost; currentUserName: string; currentProfileImage?: string | null; comments?: SocialComment[]; commentDraft: string; fireBusy: boolean; commentsBusy: boolean; commentBusy: boolean; shareBusy: boolean; onFire: (post: SocialPost) => void; onViewProfile: (playerId: string) => void; onShare: (post: SocialPost) => void; onLoadComments: (postId: string) => void; onFocusComments: (postId: string) => void; onCommentDraftChange: (postId: string, value: string) => void; onAddComment: (event: FormEvent, postId: string) => void }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const mediaUrls = post.media_urls ?? [];
  const status = post.session_status === "in_progress" ? "Playing now" : post.session_status === "completed" ? "Final leaderboard" : "Upcoming game";
  const players = post.session_players ?? [];
  const leaderboard = post.session_leaderboard ?? [];
  return <article className="social-post-card social-session-activity-card" id={`social-session-${post.session_id}`}>
    <header className="social-post-header"><button type="button" className="social-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><Avatar name={post.player_display_name} imageUrl={post.profile_image_url} large /><span><strong>{post.player_display_name}</strong><small>{post.session_status === "completed" ? "Completed rally" : status} · {sportLabel(post.sport)}</small></span></button><span className="social-post-sport">{sportLabel(post.sport)}</span></header>
    <div className="social-session-activity-intro"><strong>{post.caption}</strong><span>{post.session_name} · {post.session_date} · {post.session_area}</span></div>
    <div className="social-session-leaderboard"><div className="social-session-leaderboard-heading"><strong>Session leaderboard</strong><span>{post.session_status === "completed" ? "Based on this game" : "Current CMR order"}</span></div>{leaderboard.length ? leaderboard.map((entry) => { const delta = entry.cmr_delta ?? 0; return <button type="button" className={`social-session-rank-row rank-${entry.rank <= 3 ? entry.rank : "other"}`} key={entry.player_id} onClick={() => onViewProfile(entry.player_id)} aria-label={`View ${entry.display_name}'s profile to follow`} title={`View ${entry.display_name}'s profile`}><b className="social-session-rank-badge">{entry.rank}</b><Avatar name={entry.display_name} imageUrl={entry.profile_image_url} /><span><strong>{entry.display_name}</strong><small>{entry.cmr_rating != null ? `${entry.cmr_rating.toFixed(1)} CMR` : "CMR building"}</small></span><em>{entry.cmr_rating != null ? entry.cmr_rating.toFixed(1) : "--"}<small className={`social-session-trend ${delta > 0 ? "up" : delta < 0 ? "down" : "steady"}`}>{entry.cmr_delta == null ? "·" : `${delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} ${Math.abs(delta).toFixed(1)}`}</small></em></button>; }) : <span className="social-session-empty">CMR rankings appear after players complete feedback.</span>}</div>
    {post.media_url && <div className="social-post-media social-session-media"><img src={(mediaUrls.length ? mediaUrls[photoIndex % mediaUrls.length] : post.media_url)} alt={`Court moment ${photoIndex + 1} from ${post.session_name ?? "this game"}`} />{mediaUrls.length > 1 && <div className="social-session-carousel-controls"><button type="button" onClick={() => setPhotoIndex((index) => (index - 1 + mediaUrls.length) % mediaUrls.length)} aria-label="Previous game photo">←</button><span>{(photoIndex % mediaUrls.length) + 1} / {mediaUrls.length}</span><button type="button" onClick={() => setPhotoIndex((index) => (index + 1) % mediaUrls.length)} aria-label="Next game photo">→</button></div>}</div>}
    <SocialPostEngagement post={post} currentUserName={currentUserName} currentProfileImage={currentProfileImage} comments={comments} commentDraft={commentDraft} fireBusy={fireBusy} commentsBusy={commentsBusy} commentBusy={commentBusy} shareBusy={shareBusy} shareLabel="Share post" onFire={onFire} onShare={(socialPost) => { const selectedPhoto = mediaUrls[photoIndex % Math.max(mediaUrls.length, 1)]; onShare(selectedPhoto ? { ...socialPost, media_url: selectedPhoto, media_urls: [selectedPhoto] } : socialPost); }} onFocusComments={onFocusComments} onLoadComments={onLoadComments} onCommentDraftChange={onCommentDraftChange} onAddComment={onAddComment} onViewProfile={onViewProfile} />
  </article>;
}

function PlayerPostCard({ post, currentUserName, currentProfileImage, comments, commentDraft, fireBusy, commentsBusy, commentBusy, shareBusy, canDelete, onDelete, onFire, onViewProfile, onShare, onLoadComments, onFocusComments, onCommentDraftChange, onAddComment }: { post: SocialPost; currentUserName: string; currentProfileImage?: string | null; comments?: SocialComment[]; commentDraft: string; fireBusy: boolean; commentsBusy: boolean; commentBusy: boolean; shareBusy: boolean; canDelete: boolean; onDelete: (post: SocialPost) => void; onFire: (post: SocialPost) => void; onViewProfile: (playerId: string) => void; onShare: (post: SocialPost) => void; onLoadComments: (postId: string) => void; onFocusComments: (postId: string) => void; onCommentDraftChange: (postId: string, value: string) => void; onAddComment: (event: FormEvent, postId: string) => void }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const mediaUrls = post.media_urls?.filter(Boolean).length ? post.media_urls.filter(Boolean) : post.media_url ? [post.media_url] : [];

  return <article className="social-post-card social-player-post-card" id={`social-post-${post.id}`}>
    <header className="social-post-header"><button type="button" className="social-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><Avatar name={post.player_display_name} imageUrl={post.profile_image_url} large /><span><strong>{post.player_display_name}{post.player_cmr != null && <em className={`social-player-post-cmr ${post.player_cmr_delta != null && post.player_cmr_delta < 0 ? "negative" : ""}`}>{post.player_cmr.toFixed(1)} CMR{post.player_cmr_delta != null && ` ${post.player_cmr_delta >= 0 ? "+" : ""}${post.player_cmr_delta.toFixed(1)}`}</em>}</strong><small>{postDate(post.created_at)}</small></span></button>{canDelete && <><button type="button" className="social-post-more" onClick={() => setMenuOpen((open) => !open)} aria-label="Post options" aria-expanded={menuOpen}><MoreIcon /></button>{menuOpen && <div className="social-post-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(post); }}>Delete post</button></div>}</>}</header>
    <div className="social-player-post-content">
      <h2 className="social-player-post-caption">{post.caption}</h2>
      <dl className="social-player-post-stats"><div><dt>Sport</dt><dd>{sportLabel(post.sport)}</dd></div>{post.session_name && <div><dt>Game</dt><dd>{post.session_name}</dd></div>}</dl>
    </div>
    {mediaUrls.length > 0 && <div className="social-post-media social-player-post-media">
      {/* Post media can be Firebase URLs or local data URLs. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={mediaUrls[photoIndex % mediaUrls.length]} alt={`Photo ${photoIndex + 1} from ${post.player_display_name}'s game`} />
      {mediaUrls.length > 1 && <div className="social-post-pagination" aria-label="Post photos">{mediaUrls.map((_, index) => <button className={index === photoIndex % mediaUrls.length ? "active" : ""} type="button" key={index} onClick={() => setPhotoIndex(index)} aria-label={`Show photo ${index + 1}`} aria-pressed={index === photoIndex % mediaUrls.length} />)}</div>}
    </div>}
    <SocialPostEngagement post={post} currentUserName={currentUserName} currentProfileImage={currentProfileImage} comments={comments} commentDraft={commentDraft} fireBusy={fireBusy} commentsBusy={commentsBusy} commentBusy={commentBusy} shareBusy={shareBusy} shareLabel="Share post" onFire={onFire} onShare={(socialPost) => { const selectedPhoto = mediaUrls[photoIndex % Math.max(mediaUrls.length, 1)]; onShare(selectedPhoto ? { ...socialPost, media_url: selectedPhoto, media_urls: [selectedPhoto] } : socialPost); }} onFocusComments={onFocusComments} onLoadComments={onLoadComments} onCommentDraftChange={onCommentDraftChange} onAddComment={onAddComment} onViewProfile={onViewProfile} />
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

function loadCanvasImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

function drawCoverImage(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, radius: number) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.save();
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.clip();
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
  context.restore();
}

function canvasFile(canvas: HTMLCanvasElement, filename: string): Promise<File | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? new File([blob], filename, { type: "image/png" }) : null), "image/png"));
}

function downloadShareFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isDesktopShareView() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const phoneUserAgent = /iPhone|iPod|Windows Phone|Android.+Mobile|Mobile.+Android/i.test(navigator.userAgent);
  return !phoneUserAgent;
}

export async function copyShareText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some desktop browsers expose Clipboard API but deny writes; use the
      // synchronous selection fallback while the share click still has focus.
    }
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

export async function shareImageFile(file: File, title: string, text: string, url?: string) {
  if (isDesktopShareView()) {
    await copyShareText(url ?? text);
    return "copied" as const;
  }
  const shareData: ShareData = { title, text, files: [file] };
  if (url) shareData.url = url;
  if (navigator.share && navigator.canShare?.(shareData)) {
    await navigator.share(shareData);
    return "shared" as const;
  }
  downloadShareFile(file);
  return "downloaded" as const;
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
  const isLeaderboard = false;
  context.fillText("COURT MOMENT", 80, 245);
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
    const mediaUrl = post.media_urls?.find(Boolean) ?? post.media_url;
    const media = mediaUrl ? await loadCanvasImage(mediaUrl) : null;
    if (media) {
      drawCoverImage(context, media, 70, 520, 940, 610, 28);
      const shade = context.createLinearGradient(0, 920, 0, 1130);
      shade.addColorStop(0, "rgba(15, 27, 24, 0)");
      shade.addColorStop(1, "rgba(15, 27, 24, .78)");
      context.fillStyle = shade;
      context.beginPath();
      context.roundRect(70, 520, 940, 610, 28);
      context.fill();
      context.fillStyle = "#d8f53f";
      context.font = "800 23px 'DM Mono', monospace";
      context.textAlign = "right";
      context.fillText("COURTMATE", 965, 1080);
      context.textAlign = "left";
    } else {
      context.fillStyle = "#c9e86b";
      context.beginPath();
      context.roundRect(70, 650, 940, 350, 28);
      context.fill();
      context.fillStyle = "#192321";
      context.font = "800 28px Manrope, sans-serif";
      context.fillText(post.player_display_name, 106, 720);
      context.fillStyle = "#718f12";
      context.font = "700 22px 'DM Mono', monospace";
      context.fillText(sportLabel(post.sport).toUpperCase(), 106, 766);
      context.fillStyle = "#192321";
      context.font = "500 31px Manrope, sans-serif";
      wrapCanvasText(context, post.caption, 106, 835, 850, 43, 4);
    }
  }

  context.fillStyle = "#192321";
  context.font = "700 22px 'DM Mono', monospace";
  context.fillText(`@${post.player_display_name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`, 80, 1270);
  context.textAlign = "right";
  context.fillText("COURTMATE", 1000, 1270);
  context.textAlign = "left";
  return canvasFile(canvas, "courtmate-post.png");
}

function recentStreakDays(activityByDate: Record<string, number> = {}) {
  const today = new Date();
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { key, label: date.toLocaleDateString("en-IN", { weekday: "short" }).slice(0, 1), day: date.getDate(), active: (activityByDate[key] ?? 0) > 0 };
  });
}

export async function createStreakShareCard(playerName: string, weeklyStreak: number, activityByDate: Record<string, number>): Promise<File | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = "#10231d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#d8f53f";
  context.beginPath();
  context.arc(980, 145, 260, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#1c352c";
  context.beginPath();
  context.arc(70, 1240, 300, 0, Math.PI * 2);
  context.fill();

  const logo = await loadShareLogo();
  if (logo) {
    const logoWidth = 330;
    const logoHeight = logoWidth * (logo.naturalHeight / logo.naturalWidth);
    context.drawImage(logo, 70, 58, logoWidth, logoHeight);
  } else {
    context.fillStyle = "#ffffff";
    context.font = "800 34px Manrope, sans-serif";
    context.fillText("COURTMATE", 70, 100);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const activeDays = Object.entries(activityByDate).filter(([key, count]) => key.startsWith(monthPrefix) && count > 0).length;

  context.fillStyle = "#fbfff0";
  context.beginPath();
  context.roundRect(90, 245, 900, 820, 36);
  context.fill();
  context.fillStyle = "#718f12";
  context.font = "700 21px 'DM Mono', monospace";
  context.fillText("YOUR RACKET-SPORT STREAK", 145, 320);
  context.fillStyle = "#192321";
  context.font = "800 51px Manrope, sans-serif";
  context.fillText(now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }), 145, 390);
  context.fillStyle = "#5f7068";
  context.font = "500 24px Manrope, sans-serif";
  context.fillText(playerName, 145, 435);

  const metrics = [
    { value: String(weeklyStreak), label: `WEEK${weeklyStreak === 1 ? "" : "S"}` },
    { value: String(activeDays), label: "ACTIVE DAYS" },
  ];
  metrics.forEach((metric, index) => {
    const x = 145 + index * 250;
    context.fillStyle = "#192321";
    context.font = "800 43px Manrope, sans-serif";
    context.fillText(metric.value, x, 520);
    context.fillStyle = "#718f12";
    context.font = "700 17px 'DM Mono', monospace";
    context.fillText(metric.label, x, 555);
  });

  const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
  const cellGap = 96;
  weekdays.forEach((label, index) => {
    context.fillStyle = "#7b8780";
    context.font = "700 18px 'DM Mono', monospace";
    context.textAlign = "center";
    context.fillText(label, 174 + index * cellGap, 630);
  });
  for (let slot = 0; slot < 42; slot += 1) {
    const day = slot - firstWeekday + 1;
    if (day < 1 || day > daysInMonth) continue;
    const row = Math.floor(slot / 7);
    const column = slot % 7;
    const key = `${monthPrefix}${String(day).padStart(2, "0")}`;
    const active = (activityByDate[key] ?? 0) > 0;
    const x = 174 + column * cellGap;
    const y = 690 + row * 62;
    context.fillStyle = active ? "#192321" : "#edf1e7";
    context.beginPath();
    context.arc(x, y, 22, 0, Math.PI * 2);
    context.fill();
    if (active) {
      context.strokeStyle = "#d8f53f";
      context.lineWidth = 4;
      context.stroke();
    }
    context.fillStyle = active ? "#d8f53f" : "#758079";
    context.font = "700 16px 'DM Mono', monospace";
    context.textAlign = "center";
    context.fillText(String(day), x, y + 6);
  }
  context.textAlign = "left";
  context.fillStyle = "#596a63";
  context.font = "500 23px Manrope, sans-serif";
  context.fillText("Every game adds to your CourtMate story.", 145, 1010);

  context.fillStyle = "#ffffff";
  context.font = "800 48px Manrope, sans-serif";
  context.textAlign = "center";
  context.fillText("COURTMATE", canvas.width / 2, 1195);
  context.fillStyle = "#d8f53f";
  context.font = "700 20px 'DM Mono', monospace";
  context.fillText("FIND YOUR GAME · BUILD YOUR CIRCLE", canvas.width / 2, 1240);
  context.textAlign = "left";
  return canvasFile(canvas, "courtmate-streak.png");
}

export function SocialFeed({ apiUrl, currentUserId, currentUserName, currentProfileImage, weeklyStreak = 0, weeklyStreakActive = false, activityByDate = {}, authorizedFetch, onToast, onViewProfile, onInvalidate, initialFilter = "all" }: SocialFeedProps & { initialFilter?: FeedFilter }) {
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

  async function loadFeed(nextFilter = feedFilter, force = false, silent = false) {
    const key = socialFeedCacheKey(currentUserId, nextFilter);
    if (!force) {
      try {
        const raw = window.sessionStorage.getItem(key);
        const cached = raw ? JSON.parse(raw) as { cachedAt?: number; posts?: SocialPost[] } : null;
        if (cached?.cachedAt && Date.now() - cached.cachedAt < SOCIAL_FEED_CACHE_TTL_MS && Array.isArray(cached.posts)) {
          setPosts(newestFirst(cached.posts));
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
      if (!silent) {
        setLoading(true);
        setLoadError("");
      }
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
      const orderedPosts = newestFirst(nextPosts);
      setPosts((current) => hasFeedStateChanged(current, orderedPosts) ? orderedPosts : current);
      if (silent) setLoadError("");
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), posts: orderedPosts }));
      } catch {
        // A disabled or full session storage should never block the feed.
      }
    } catch (error) {
      if (!silent) {
        setPosts([]);
        setLoadError(error instanceof Error ? error.message : "Could not load the social feed");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadFeed();
    const timer = window.setTimeout(() => void loadRecommendedPlayers(), 250);
    return () => window.clearTimeout(timer);
  }, [currentUserId]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void loadFeed(feedFilter, true, true);
      if (feedFilter === "all") void loadRecommendedPlayers(true, true);
    };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [currentUserId, feedFilter]);

  useEffect(() => {
    if (loading || !window.location.hash.startsWith("#social-post-")) return;
    const timer = window.setTimeout(() => {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [loading, posts]);

  async function loadRecommendedPlayers(force = false, silent = false) {
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
      if (!silent) setRecommendationsLoading(true);
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
      const nextPlayers = profiles.filter((profile) => !profile.is_following);
      setRecommendedPlayers((current) => hasFeedStateChanged(current, nextPlayers) ? nextPlayers : current);
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), profiles }));
      } catch {
        // Recommendations are optional, so storage failures stay silent.
      }
    } catch {
      if (!silent) setRecommendedPlayers([]);
    } finally {
      if (!silent) setRecommendationsLoading(false);
    }
  }

  async function followRecommendedPlayer(player: RecommendedPlayer) {
    try {
      setBusyAction(`follow-${player.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/players/${player.id}/follow`, { method: "POST" });
      if (!response.ok) throw new Error("Follow failed");
      setRecommendedPlayers((current) => current.filter((item) => item.id !== player.id));
      clearFeedCache();
      onInvalidate?.(["connections", "social-profile", "feed", "recommendations"]);
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
      onInvalidate?.(["feed"]);
    } catch {
      setPosts((current) => current.map((item) => item.id === post.id ? post : item));
      onToast("Could not update the fire reaction");
    } finally {
      setBusyAction("");
    }
  }

  async function deletePost(post: SocialPost) {
    if (!window.confirm("Delete this post? This cannot be undone.")) return;
    try {
      setBusyAction(`delete-${post.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${post.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      setPosts((current) => current.filter((item) => item.id !== post.id));
      setComments((current) => {
        const next = { ...current };
        delete next[post.id];
        return next;
      });
      clearFeedCache();
      onInvalidate?.(["feed"]);
      onToast("Post deleted");
    } catch {
      onToast("Could not delete this post");
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
      onInvalidate?.(["feed"]);
    } catch {
      onToast("Could not add your comment");
    } finally {
      setBusyAction("");
    }
  }

  async function sharePost(post: SocialPost) {
    const shareUrl = `${window.location.origin}/home#social-post-${post.id}`;
    if (isDesktopShareView()) {
      setBusyAction(`share-${post.id}`);
      try {
        await copyShareText(shareUrl);
        onToast("Copied link to clipboard");
        void authorizedFetch(`${apiUrl}/v1/social/posts/${post.id}/share`, { method: "POST" })
          .then(async (response) => {
            if (!response.ok) return;
            const updated = await response.json() as SocialPost;
            setPosts((current) => current.map((item) => item.id === updated.id ? updated : item));
            clearFeedCache();
            onInvalidate?.(["feed"]);
          })
          .catch(() => {
            // Copying is the desktop action; analytics must never replace its success state.
          });
      } catch {
        onToast("Could not copy this post link");
      } finally {
        setBusyAction("");
      }
      return;
    }
    try {
      setBusyAction(`share-${post.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${post.id}/share`, { method: "POST" });
      if (!response.ok) throw new Error("Share failed");
      const updated = await response.json() as SocialPost;
      setPosts((current) => current.map((item) => item.id === updated.id ? updated : item));
      clearFeedCache();
      onInvalidate?.(["feed"]);
      const file = await createShareCard(post);
      if (!file) throw new Error("Could not create the CourtMate share image");
      const outcome = await shareImageFile(file, `${post.player_display_name} on CourtMate`, post.caption, shareUrl);
      if (outcome === "copied") onToast("Copied link to clipboard");
      if (outcome === "downloaded") {
        await navigator.clipboard?.writeText(shareUrl);
        onToast("Branded post image downloaded and link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast("Could not share this post");
    } finally {
      setBusyAction("");
    }
  }

  async function shareStreak() {
    try {
      setBusyAction("share-streak");
      if (isDesktopShareView()) {
        await copyShareText(`${window.location.origin}/home`);
        onToast("Copied link to clipboard");
        return;
      }
      const file = await createStreakShareCard(currentUserName, weeklyStreak, activityByDate);
      if (!file) throw new Error("Could not create the streak image");
      const text = `${weeklyStreak}-week CourtMate streak. Keep showing up.`;
      const outcome = await shareImageFile(file, "My CourtMate streak", text, `${window.location.origin}/home`);
      if (outcome === "copied") onToast("Copied link to clipboard");
      if (outcome === "downloaded") onToast("CourtMate streak image downloaded");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast(error instanceof Error ? error.message : "Could not share your streak");
    } finally {
      setBusyAction("");
    }
  }

  function changeFilter(nextFilter: FeedFilter) {
    setFeedFilter(nextFilter);
    void loadFeed(nextFilter);
  }

  const streakDays = recentStreakDays(activityByDate);

  return <section className="social-page" aria-label="Rally Circles">
    <div className="social-feed-tabs" role="tablist" aria-label="Rally feed"><button className={feedFilter === "all" ? "active" : ""} type="button" onClick={() => changeFilter("all")} role="tab" aria-selected={feedFilter === "all"}>Discover</button><button className={feedFilter === "following" ? "active" : ""} type="button" onClick={() => changeFilter("following")} role="tab" aria-selected={feedFilter === "following"}>Following</button><button className={feedFilter === "personal" ? "active" : ""} type="button" onClick={() => changeFilter("personal")} role="tab" aria-selected={feedFilter === "personal"}>My rallies</button></div>

    {feedFilter === "personal" && <section className={`social-streak-card ${weeklyStreakActive ? "active" : ""}`} aria-label="Your streak"><div className="social-streak-heading"><div><span className="kicker">YOUR STREAK</span><h2>Keep showing up</h2></div><button type="button" className="social-streak-share" onClick={() => void shareStreak()} disabled={busyAction === "share-streak"} aria-label="Share your CourtMate streak as an image" title="Share streak">{busyAction === "share-streak" ? "…" : "↗"}</button></div><div className="social-streak-content"><div className="social-streak-total"><span className="social-streak-flame" aria-hidden="true"><StreakIcon /></span><strong>{weeklyStreak}</strong><small>WEEK{weeklyStreak === 1 ? "" : "S"}</small></div><div className="social-streak-days">{streakDays.map((day) => <span className={day.active ? "active" : ""} key={day.key}><b>{day.label}</b><i>{day.day}</i></span>)}</div></div><p>{weeklyStreakActive ? "You have played this week. Keep your rally going." : "Complete a game this week to start your streak."}</p></section>}

    {feedFilter === "all" && !recommendationsLoading && recommendedPlayers.length > 0 && <section className="social-recommendations" aria-labelledby="social-recommendations-title">
      <div className="social-recommendations-heading"><div><h2 id="social-recommendations-title">People worth playing with</h2></div><span>Nearby and active</span></div>
      <div className="social-recommendations-list">{recommendedPlayers.map((player) => { const ratings = Object.values(player.cmr_ratings).filter((rating) => typeof rating === "number" && Number.isFinite(rating)); const highestCmr = ratings.length ? Math.max(...ratings) : null; const mutuals = player.mutual_connections ?? []; const mutualLabel = mutuals.length === 1 ? `1 mutual · ${mutuals[0]}` : `${mutuals.length} mutuals · ${mutuals.slice(0, 2).join(", ")}`; return <article className="social-recommendation-card" key={player.id}><button type="button" className="social-recommendation-profile" onClick={() => onViewProfile(player.id)}><Avatar name={player.display_name} imageUrl={player.profile_image_url} large /><span><strong>{player.display_name}{highestCmr != null && <b className="social-recommendation-cmr">{highestCmr.toFixed(1)} CMR</b>}</strong><small>{player.area || "Nearby player"}</small>{mutuals.length > 0 && <em>{mutualLabel}</em>}</span></button><button type="button" className="social-follow-button" onClick={() => void followRecommendedPlayer(player)} disabled={busyAction === `follow-${player.id}`}>{busyAction === `follow-${player.id}` ? "..." : "+ Follow"}</button></article>; })}</div>
    </section>}

    <div className="social-feed-list" aria-busy={loading}>
      {loading && <div className="social-feed-loader"><TennisBallLoader label="Rallying..." /></div>}
      {!loading && loadError && <div className="social-feed-error" role="alert"><strong>Social is taking a breather.</strong><p>We couldn&apos;t load the latest court activity.</p><button type="button" onClick={() => void loadFeed(feedFilter, true)}>Try again <span>↗</span></button></div>}
      {!loading && !loadError && posts.length === 0 && <div className="social-empty"><strong>{feedFilter === "personal" ? "Share a completed game when you have a moment worth keeping." : feedFilter === "following" ? "Follow players to build your Rally Circle." : "Player stories from completed games will appear here."}</strong><p>Every post is written and shared by its player.</p></div>}
      {!loading && posts.map((post) => post.activity_type === "session" ? <SessionActivityCard key={post.id} post={post} currentUserName={currentUserName} currentProfileImage={currentProfileImage} comments={comments[post.id]} commentDraft={commentDrafts[post.id] ?? ""} fireBusy={busyAction === `fire-${post.id}`} commentsBusy={busyAction === `comments-${post.id}`} commentBusy={busyAction === `comment-${post.id}`} shareBusy={busyAction === `share-${post.id}`} onFire={(socialPost) => void toggleFire(socialPost)} onViewProfile={onViewProfile} onShare={(sessionPost) => void sharePost(sessionPost)} onLoadComments={(postId) => void loadComments(postId)} onFocusComments={focusComments} onCommentDraftChange={(postId, value) => setCommentDrafts((current) => ({ ...current, [postId]: value }))} onAddComment={(event, postId) => void addComment(event, postId)} /> : <PlayerPostCard key={post.id} post={post} currentUserName={currentUserName} currentProfileImage={currentProfileImage} comments={comments[post.id]} commentDraft={commentDrafts[post.id] ?? ""} fireBusy={busyAction === `fire-${post.id}`} commentsBusy={busyAction === `comments-${post.id}`} commentBusy={busyAction === `comment-${post.id}`} shareBusy={busyAction === `share-${post.id}`} canDelete={post.player_id === currentUserId} onDelete={(socialPost) => void deletePost(socialPost)} onFire={(socialPost) => void toggleFire(socialPost)} onViewProfile={onViewProfile} onShare={(socialPost) => void sharePost(socialPost)} onLoadComments={(postId) => void loadComments(postId)} onFocusComments={focusComments} onCommentDraftChange={(postId, value) => setCommentDrafts((current) => ({ ...current, [postId]: value }))} onAddComment={(event, postId) => void addComment(event, postId)} />)}
    </div>
  </section>;
}
