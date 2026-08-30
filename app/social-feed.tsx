"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { storage } from "../firebase";

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
  return <span className={`social-avatar ${large ? "large" : ""}`}>{imageUrl ? <img src={imageUrl} alt="" /> : initials(name)}</span>;
}

export function SocialFeed({ apiUrl, currentUserId, currentUserName, currentProfileImage, authorizedFetch, onToast, onViewProfile }: SocialFeedProps) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [feedFilter, setFeedFilter] = useState<"all" | "following">("all");
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
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

  async function loadFeed(nextFilter = feedFilter) {
    try {
      setLoading(true);
      const response = await authorizedFetch(`${apiUrl}/v1/social/feed?feed=${nextFilter}`);
      if (!response.ok) throw new Error("Social feed unavailable");
      const payload = await response.json() as { posts: SocialPost[] };
      setPosts(payload.posts);
    } catch {
      onToast("Could not load the social feed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFeed();
    void loadSessions();
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
      if (navigator.share) {
        await navigator.share({ title: `${post.player_display_name} on CourtMate`, text: post.caption, url: shareUrl });
      } else {
        await navigator.clipboard?.writeText(shareUrl);
        onToast("Post link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast("Could not share this post");
    } finally {
      setBusyAction("");
    }
  }

  function changeFilter(nextFilter: "all" | "following") {
    setFeedFilter(nextFilter);
    void loadFeed(nextFilter);
  }

  return <section className="social-page" aria-label="CourtMate social feed">
    <div className="social-page-heading">
      <div><span className="eyebrow">COURT COMMUNITY</span><h1>Play. Share. Repeat.</h1></div>
      <div className="social-feed-tabs"><button className={feedFilter === "all" ? "active" : ""} type="button" onClick={() => changeFilter("all")}>Discover</button><button className={feedFilter === "following" ? "active" : ""} type="button" onClick={() => changeFilter("following")}>Following</button></div>
    </div>

    <form className="social-composer" onSubmit={createPost}>
      <div className="social-composer-top"><Avatar name={currentUserName} imageUrl={currentProfileImage} /><textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={500} placeholder="Share a rally, result, or court moment..." aria-label="Write a social post" /></div>
      {previewUrl && <div className="social-media-preview">{mediaFile?.type.startsWith("video/") ? <video src={previewUrl} controls /> : <img src={previewUrl} alt="Selected upload preview" />}<button type="button" onClick={clearMedia} aria-label="Remove attachment">×</button></div>}
      <div className="social-composer-actions"><label className="media-picker"><input type="file" accept="image/*,video/*" onChange={selectMedia} /> <span>＋ Media</span></label><select value={sport} onChange={(event) => setSport(event.target.value as Sport)} aria-label="Sport"><option value="pickleball">Pickleball</option>{sports.filter((item) => item.value !== "pickleball").map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select>{sessions.length > 0 && <select value={taggedSessionId} onChange={(event) => setTaggedSessionId(event.target.value)} aria-label="Tag a game"><option value="">Tag a game</option>{sessions.filter((session) => session.sport === sport).map((session) => <option value={session.id} key={session.id}>{session.group_name}</option>)}</select>}<button className="social-post-button" type="submit" disabled={!caption.trim() || posting}>{posting ? "Posting..." : "Post"}</button></div>
    </form>

    <div className="social-feed-list">
      {loading && <p className="social-empty">Loading your court community...</p>}
      {!loading && posts.length === 0 && <div className="social-empty"><strong>{feedFilter === "following" ? "Follow players to build your feed." : "Your court community starts here."}</strong><p>Share a game moment, a match result, or a photo from the court.</p></div>}
      {!loading && posts.map((post) => <article className="social-post-card" id={`social-post-${post.id}`} key={post.id}>
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
