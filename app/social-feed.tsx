"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
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

type SessionOption = {
  id: string;
  group_name: string;
  sport: Sport;
  session_date: string;
  area: string;
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

function SessionActivityCard({ post, currentUserId, onViewProfile, onShare, onAddPhoto, photoBusy }: { post: SocialPost; currentUserId: string; onViewProfile: (playerId: string) => void; onShare: (post: SocialPost) => void; onAddPhoto: (post: SocialPost, file: File) => void; photoBusy: boolean }) {
  const status = post.session_status === "in_progress" ? "Playing now" : post.session_status === "completed" ? "Final leaderboard" : "Upcoming game";
  const players = post.session_players ?? [];
  const leaderboard = post.session_leaderboard ?? [];
  const canAddPhoto = players.some((player) => player.id === currentUserId);
  return <article className="social-post-card social-session-activity-card" id={`social-session-${post.session_id}`}>
    <header className="social-post-header"><button type="button" className="social-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><Avatar name={post.player_display_name} imageUrl={post.profile_image_url} large /><span><strong>{post.player_display_name}</strong><small>{status} · {sportLabel(post.sport)}</small></span></button><span className="social-post-sport">{sportLabel(post.sport)}</span></header>
    <div className="social-session-activity-intro"><strong>{post.caption}</strong><span>{post.session_name} · {post.session_date} · {post.session_area}</span></div>
    <div className="social-session-players" aria-label="Players in this session">{players.map((player) => <button type="button" className="social-session-player" key={player.id} onClick={() => onViewProfile(player.id)}><Avatar name={player.display_name} imageUrl={player.profile_image_url} /><span>{player.display_name}</span></button>)}</div>
    <div className="social-session-leaderboard"><div className="social-session-leaderboard-heading"><strong>Session leaderboard</strong><span>{post.session_status === "completed" ? "Based on this game" : "Current CMR order"}</span></div>{leaderboard.length ? leaderboard.map((entry) => <button type="button" className="social-session-rank-row" key={entry.player_id} onClick={() => onViewProfile(entry.player_id)} aria-label={`View ${entry.display_name}'s profile to follow`} title={`View ${entry.display_name}'s profile`}><b>{entry.rank}</b><Avatar name={entry.display_name} imageUrl={entry.profile_image_url} /><span><strong>{entry.display_name}</strong><small>{entry.cmr_rating != null ? `${entry.cmr_rating.toFixed(1)} CMR` : "CMR building"}</small></span><em>{entry.cmr_rating != null ? entry.cmr_rating.toFixed(1) : "--"}</em></button>) : <span className="social-session-empty">CMR rankings appear after players complete feedback.</span>}</div>
    <div className="social-session-actions"><button type="button" onClick={() => onShare(post)}>↗ Share leaderboard</button>{canAddPhoto && <label className={`social-session-photo-button ${photoBusy ? "busy" : ""}`}><input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) onAddPhoto(post, file); }} disabled={photoBusy} />{photoBusy ? "Adding photo..." : "+ Add photo"}</label>}</div>
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

  context.fillStyle = "#192321";
  context.font = "800 34px Manrope, sans-serif";
  context.fillText("COURTMATE", 78, 94);
  context.fillStyle = "#718f12";
  context.font = "700 22px 'DM Mono', monospace";
  context.fillText("PLAY. CONNECT. REPEAT.", 80, 137);
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
    entries.forEach((entry, index) => {
      const top = 650 + index * 105;
      context.fillStyle = index === 0 ? "#c9e86b" : "rgba(255,255,250,.82)";
      context.beginPath();
      context.roundRect(70, top, 940, 78, 18);
      context.fill();
      context.fillStyle = "#718f12";
      context.font = "800 25px 'DM Mono', monospace";
      context.fillText(String(entry.rank).padStart(2, "0"), 98, top + 49);
      context.fillStyle = "#192321";
      context.font = "800 28px Manrope, sans-serif";
      context.fillText(entry.display_name, 180, top + 48);
      context.fillStyle = "#718f12";
      context.font = "800 27px 'DM Mono', monospace";
      context.textAlign = "right";
      context.fillText(entry.cmr_rating != null ? `${entry.cmr_rating.toFixed(1)} CMR` : "BUILDING", 980, top + 48);
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

export function SocialFeed({ apiUrl, currentUserId, currentUserName, currentProfileImage, authorizedFetch, onToast, onViewProfile }: SocialFeedProps) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [feedFilter, setFeedFilter] = useState<"all" | "following">("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [posting, setPosting] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [caption, setCaption] = useState("");
  const [sport, setSport] = useState<Sport>("pickleball");
  const [taggedSessionId, setTaggedSessionId] = useState("");
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [comments, setComments] = useState<Record<string, SocialComment[]>>({});
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState("");
  const [recommendedPlayers, setRecommendedPlayers] = useState<RecommendedPlayer[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(true);

  async function loadFeed(nextFilter = feedFilter) {
    try {
      setLoading(true);
      setLoadError("");
      const response = await authorizedFetch(`${apiUrl}/v1/social/feed?feed=${nextFilter}`);
      if (!response.ok) throw new Error("Social feed unavailable");
      const payload = await response.json() as { posts: SocialPost[] };
      if (!Array.isArray(payload.posts)) throw new Error("Social feed payload is invalid");
      setPosts(payload.posts);
    } catch (error) {
      setPosts([]);
      setLoadError(error instanceof Error ? error.message : "Could not load the social feed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFeed();
    void loadSessions();
    void loadRecommendedPlayers();
  }, [currentUserId]);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function loadSessions() {
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/me/games`);
      if (!response.ok) return;
      const payload = await response.json() as { games?: SessionOption[]; past_games?: { session: SessionOption }[] };
      const options = [...(payload.games ?? []), ...(payload.past_games ?? []).map((item) => item.session)];
      setSessions(Array.from(new Map(options.map((session) => [session.id, session])).values()));
    } catch {
      setSessions([]);
    }
  }

  async function loadRecommendedPlayers() {
    try {
      setRecommendationsLoading(true);
      const response = await authorizedFetch(`${apiUrl}/v1/players/recommended`);
      if (!response.ok) throw new Error("Recommendations unavailable");
      const payload = await response.json() as { profiles: RecommendedPlayer[] };
      setRecommendedPlayers(payload.profiles.filter((profile) => !profile.is_following));
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
      onToast(`Following ${player.display_name}`);
    } catch {
      onToast("Could not follow this player");
    } finally {
      setBusyAction("");
    }
  }

  function selectMedia(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      onToast("Choose an image or video");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      onToast("Media must be smaller than 25 MB");
      return;
    }
    setMediaFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function clearMedia() {
    setMediaFile(null);
    setPreviewUrl("");
  }

  async function createPost(event: FormEvent) {
    event.preventDefault();
    if (!caption.trim()) return;
    if (mediaFile && !taggedSessionId) {
      onToast("Tag a game before adding a photo or video");
      return;
    }
    try {
      setPosting(true);
      let mediaUrl: string | null = null;
      let mediaType: "image" | "video" | null = null;
      if (mediaFile) {
        if (!storage) throw new Error("Firebase Storage is not configured");
        const extension = mediaFile.name.split(".").pop()?.toLowerCase() || "media";
        const mediaRef = ref(storage, `social-posts/${currentUserId}/${crypto.randomUUID()}.${extension}`);
        const upload = await uploadBytes(mediaRef, mediaFile, { contentType: mediaFile.type });
        mediaUrl = await getDownloadURL(upload.ref);
        mediaType = mediaFile.type.startsWith("video/") ? "video" : "image";
      }
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caption: caption.trim(), sport, session_id: taggedSessionId || null, media_url: mediaUrl, media_type: mediaType }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Post could not be published");
      }
      const post = await response.json() as SocialPost;
      setPosts((current) => [post, ...current]);
      setCaption("");
      setTaggedSessionId("");
      clearMedia();
      setShowComposer(false);
      onToast("Posted to your court community");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not publish your post");
    } finally {
      setPosting(false);
    }
  }

  async function toggleLike(post: SocialPost) {
    try {
      setBusyAction(`like-${post.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts/${post.id}/like`, { method: "POST" });
      if (!response.ok) throw new Error("Like failed");
      const updated = await response.json() as SocialPost;
      setPosts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch {
      onToast("Could not update the like");
    } finally {
      setBusyAction("");
    }
  }

  async function toggleComments(postId: string) {
    if (expandedPostId === postId) {
      setExpandedPostId(null);
      return;
    }
    setExpandedPostId(postId);
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
    if (!file.type.startsWith("image/")) {
      onToast("Choose an image for this game post");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      onToast("Photo must be smaller than 25 MB");
      return;
    }
    try {
      setBusyAction(`photo-${post.id}`);
      if (!storage) throw new Error("Firebase Storage is not configured");
      const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
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
      setPosts((current) => [createdPost, ...current]);
      onToast("Photo added to the game post");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not add the photo");
    } finally {
      setBusyAction("");
    }
  }

  function changeFilter(nextFilter: "all" | "following") {
    setFeedFilter(nextFilter);
    void loadFeed(nextFilter);
  }

  return <section className="social-page" aria-label="CourtMate social feed">
    <button type="button" className="section-fab social-fab" onClick={() => setShowComposer((open) => !open)} aria-label={showComposer ? "Close post composer" : "Create a social post"} title={showComposer ? "Close" : "Create a post"}>{showComposer ? "×" : "+"}</button>
    <div className="social-page-heading">
      <div className="social-feed-tabs"><button className={feedFilter === "all" ? "active" : ""} type="button" onClick={() => changeFilter("all")}>Discover</button><button className={feedFilter === "following" ? "active" : ""} type="button" onClick={() => changeFilter("following")}>Following</button></div>
    </div>

    {showComposer && <form className="social-composer" onSubmit={createPost}>
      <div className="social-composer-top"><Avatar name={currentUserName} imageUrl={currentProfileImage} /><textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={500} placeholder="Share a rally, result, or court moment..." aria-label="Write a social post" /></div>
      {previewUrl && <div className="social-media-preview">{mediaFile?.type.startsWith("video/") ? <video src={previewUrl} controls /> : <img src={previewUrl} alt="Selected upload preview" />}<button type="button" onClick={clearMedia} aria-label="Remove attachment">×</button></div>}
      <div className="social-composer-actions"><label className={`media-picker ${!taggedSessionId ? "disabled" : ""}`}><input type="file" accept="image/*,video/*" onChange={selectMedia} disabled={!taggedSessionId || posting} /> <span>＋ Media</span></label><select value={sport} onChange={(event) => { setSport(event.target.value as Sport); setTaggedSessionId(""); }} aria-label="Sport"><option value="pickleball">Pickleball</option>{sports.filter((item) => item.value !== "pickleball").map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select>{sessions.length > 0 && <select value={taggedSessionId} onChange={(event) => setTaggedSessionId(event.target.value)} aria-label="Tag a game"><option value="">Tag a game</option>{sessions.filter((session) => session.sport === sport).map((session) => <option value={session.id} key={session.id}>{session.group_name}</option>)}</select>}<button className="social-post-button" type="submit" disabled={!caption.trim() || posting}>{posting ? "Posting..." : "Post"}</button></div>
      {mediaFile && !taggedSessionId && <small className="social-media-hint">Tag one of your games to add media.</small>}
    </form>}

    {!recommendationsLoading && recommendedPlayers.length > 0 && <section className="social-recommendations" aria-labelledby="social-recommendations-title">
      <div className="social-recommendations-heading"><div><span className="eyebrow">YOUR NEXT RALLY</span><h2 id="social-recommendations-title">Players you may know</h2></div><span>Nearby and active</span></div>
      <div className="social-recommendations-list">{recommendedPlayers.map((player) => { const ratedSports = Object.keys(player.cmr_ratings); const ratingLabel = ratedSports.length ? `${sportLabel(ratedSports[0] as Sport)} ${Math.round(player.cmr_ratings[ratedSports[0]])}` : "New to CMR"; return <article className="social-recommendation-card" key={player.id}><button type="button" className="social-recommendation-profile" onClick={() => onViewProfile(player.id)}><Avatar name={player.display_name} imageUrl={player.profile_image_url} large /><span><strong>{player.display_name}</strong><small>{player.area} · {ratingLabel}</small></span></button><button type="button" className="social-follow-button" onClick={() => void followRecommendedPlayer(player)} disabled={busyAction === `follow-${player.id}`}>{busyAction === `follow-${player.id}` ? "..." : "+ Follow"}</button></article>; })}</div>
    </section>}

    <div className="social-feed-list" aria-busy={loading}>
      {loading && <div className="social-feed-loader"><TennisBallLoader label="Loading social feed" /></div>}
      {!loading && loadError && <div className="social-feed-error" role="alert"><strong>Social is taking a breather.</strong><p>We couldn&apos;t load the latest court activity.</p><button type="button" onClick={() => void loadFeed()}>Try again <span>↗</span></button></div>}
      {!loading && !loadError && posts.length === 0 && <div className="social-empty"><strong>{feedFilter === "following" ? "Follow players to build your feed." : "Your court community starts here."}</strong><p>Share a game moment, a match result, or a photo from the court.</p></div>}
      {!loading && posts.map((post) => post.activity_type === "session" ? <SessionActivityCard key={post.id} post={post} currentUserId={currentUserId} onViewProfile={onViewProfile} onShare={(sessionPost) => void shareSessionLeaderboard(sessionPost)} onAddPhoto={(sessionPost, file) => void addSessionPhoto(sessionPost, file)} photoBusy={busyAction === `photo-${post.id}`} /> : <article className="social-post-card" id={`social-post-${post.id}`} key={post.id}>
        <header className="social-post-header"><button type="button" className="social-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><Avatar name={post.player_display_name} imageUrl={post.profile_image_url} large /><span><strong>{post.player_display_name}</strong><small>{sportLabel(post.sport)} · {relativeTime(post.created_at)}</small></span></button><span className="social-post-sport">{sportLabel(post.sport)}</span></header>
        <p className="social-post-caption">{post.caption}</p>
        {post.session_name && <div className="social-session-chip"><span>●</span><div><strong>{post.session_name}</strong><small>{post.session_date} · {post.session_area}</small></div><span>Game</span></div>}
        {post.media_url && <div className="social-post-media">{post.media_type === "video" ? <video src={post.media_url} controls playsInline /> : <img src={post.media_url} alt="Shared court moment" />}</div>}
        <div className="social-post-actions"><button type="button" className={post.liked_by_me ? "liked" : ""} onClick={() => void toggleLike(post)} disabled={busyAction === `like-${post.id}`}><span>{post.liked_by_me ? "♥" : "♡"}</span> {post.like_count || "Like"}</button><button type="button" onClick={() => void toggleComments(post.id)}><span>◌</span> {post.comment_count || "Comment"}</button><button type="button" onClick={() => void sharePost(post)} disabled={busyAction === `share-${post.id}`}><span>↗</span> {post.share_count || "Share"}</button></div>
        {expandedPostId === post.id && <div className="social-comments"><div className="social-comments-list">{busyAction === `comments-${post.id}` ? <small>Loading comments...</small> : comments[post.id]?.length ? comments[post.id].map((comment) => <div className="social-comment" key={comment.id}><button type="button" className="social-comment-profile" onClick={() => onViewProfile(comment.player_id)} aria-label={`View ${comment.player_display_name}'s profile`}><Avatar name={comment.player_display_name} imageUrl={comment.profile_image_url} /></button><div><button type="button" className="social-comment-name" onClick={() => onViewProfile(comment.player_id)}>{comment.player_display_name}</button><p>{comment.message}</p></div></div>) : <small>No comments yet. Start the conversation.</small>}</div><form className="social-comment-form" onSubmit={(event) => void addComment(event, post.id)}><Avatar name={currentUserName} imageUrl={currentProfileImage} /><input value={commentDrafts[post.id] ?? ""} onChange={(event) => setCommentDrafts((current) => ({ ...current, [post.id]: event.target.value }))} placeholder="Add a comment..." maxLength={300} aria-label="Add a comment" /><button type="submit" disabled={!commentDrafts[post.id]?.trim() || busyAction === `comment-${post.id}`}>↗</button></form></div>}
      </article>)}
    </div>
  </section>;
}
