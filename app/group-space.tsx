"use client";

import { FormEvent, useRef, useState } from "react";
import { PostGameFeedbackPanel } from "./post-game-feedback";

type GroupSpaceSession = {
  id: string;
  organizer_id: string;
  group_name: string;
  sport: string;
  area: string;
  session_date: string;
  start_time: string;
  end_time: string;
  time_window_start?: string | null;
  time_window_end?: string | null;
  duration_minutes?: number;
  time_finalized?: boolean;
  rating_mode?: "casual" | "competitive";
  status: string;
};

type GroupSpaceMember = {
  id: string;
  display_name: string;
  profile_image_url?: string | null;
  area: string;
  style: string;
  cmr_ratings?: Record<string, number>;
  sport_ratings?: Record<string, number>;
  dupr_rating?: number | null;
};

type GroupSpacePost = {
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

type GroupSpaceProps = {
  group: GroupSpaceSession;
  members: GroupSpaceMember[];
  waitlist: GroupSpaceMember[];
  posts: GroupSpacePost[];
  currentUserId?: string;
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  initialFeedbackRequired?: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onMarkDone: () => Promise<boolean>;
  onOpenPersonalRally: () => void;
  onChatPosted: (post: GroupSpacePost) => void;
  onToast: (message: string) => void;
  onViewProfile: (playerId: string) => void;
};

interface SpeechRecognitionEvent extends Event {
  results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } };
}

interface SpeechRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: () => void;
  onend: () => void;
  onresult: (event: SpeechRecognitionEvent) => void;
  start: () => void;
}

function initials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "CM";
}

function memberNames(ids: string[], members: GroupSpaceMember[]) {
  return ids.map((id) => members.find((member) => member.id === id)?.display_name ?? "Player").join(" + ");
}

function clock(time: string) {
  return time.slice(0, 5);
}

const SOCIAL_PHOTO_TARGET_BYTES = 72 * 1024;

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

async function compactSocialPhoto(file: File): Promise<File> {
  // Keep inline-storage fallbacks safely below Firestore's document limit.
  if (file.size <= SOCIAL_PHOTO_TARGET_BYTES) return file;
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Could not read this photo"));
      nextImage.src = sourceUrl;
    });
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    let largestDimension = Math.min(1280, longestSide);
    let quality = 0.82;
    let smallest: Blob | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = largestDimension / longestSide;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      const compressed = await canvasToWebp(canvas, quality);
      if (!compressed) break;
      if (!smallest || compressed.size < smallest.size) smallest = compressed;
      if (compressed.size <= SOCIAL_PHOTO_TARGET_BYTES) break;
      largestDimension = Math.max(320, Math.round(largestDimension * 0.75));
      quality = Math.max(0.45, quality - 0.08);
    }
    if (!smallest) throw new Error("Could not prepare this photo");
    return new File([smallest], `${file.name.replace(/\.[^.]+$/, "") || "game-photo"}.webp`, { type: "image/webp" });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

export function GroupSpace({ group: inputGroup, members, waitlist, posts, currentUserId, apiUrl, authorizedFetch, initialFeedbackRequired = false, onClose, onRefresh, onMarkDone, onOpenPersonalRally, onChatPosted, onToast, onViewProfile }: GroupSpaceProps) {
  const feedbackPhase = inputGroup.status === "awaiting_feedback";
  // Reuse the compact completed-state feedback UI while keeping the phase
  // visually distinct and withholding the Home activity card until final save.
  const group = feedbackPhase ? { ...inputGroup, status: "completed" } : inputGroup;
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [posting, setPosting] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [timePolling, setTimePolling] = useState(false);
  const [decidingResultId, setDecidingResultId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(initialFeedbackRequired);
  const [feedbackRequired, setFeedbackRequired] = useState(initialFeedbackRequired);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCaption, setShareCaption] = useState("");
  const [sharePhotoUrls, setSharePhotoUrls] = useState<string[]>([]);
  const [sharePhotoUploading, setSharePhotoUploading] = useState(false);
  const [sharePublishing, setSharePublishing] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);
  const currentPlayerIsConfirmed = Boolean(currentUserId && members.some((member) => member.id === currentUserId));
  const flexibleTime = group.time_finalized === false && Boolean(group.time_window_start && group.time_window_end);
  const openTimePoll = posts.find((post) => post.post_type === "time_poll" && post.poll_status === "open");
  const canStartTimePoll = currentPlayerIsConfirmed && flexibleTime && !openTimePoll && members.length >= 2 && inputGroup.status !== "cancelled" && inputGroup.status !== "awaiting_feedback" && inputGroup.status !== "completed";
  const canMarkGameDone = currentPlayerIsConfirmed && group.time_finalized !== false && inputGroup.status !== "cancelled" && inputGroup.status !== "awaiting_feedback" && inputGroup.status !== "completed";
  const canRatePlayers = currentPlayerIsConfirmed && ["awaiting_feedback", "completed"].includes(inputGroup.status);
  const canPostGame = currentPlayerIsConfirmed && inputGroup.status !== "cancelled";
  const timeDescription = flexibleTime
    ? `${clock(group.time_window_start ?? group.start_time)}–${clock(group.time_window_end ?? group.end_time)} window · ${group.duration_minutes ?? 60}-minute game`
    : `${clock(group.start_time)}–${clock(group.end_time)}`;

  function startVoice() {
    const SpeechRecognition = (window as Window & { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition
      ?? (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      onToast("Voice mode needs Chrome or Safari speech recognition");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = Array.from({ length: event.results.length }, (_, index) => event.results[index][0].transcript).join(" ").trim();
      if (transcript) setDraft(transcript);
    };
    recognition.start();
  }

  async function postChat(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || posting) return;
    setPosting(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = await response.json().catch(() => ({})) as GroupSpacePost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not post to group chat");
      setDraft("");
      onChatPosted(payload);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not post to group chat");
    } finally {
      setPosting(false);
    }
  }

  async function markDone() {
    if (markingDone) return;
    setMarkingDone(true);
    try {
      const markedDone = await onMarkDone();
      if (markedDone) {
        setFeedbackRequired(true);
        setFeedbackOpen(true);
      }
    } finally {
      setMarkingDone(false);
    }
  }

  async function startTimePoll() {
    if (timePolling) return;
    setTimePolling(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/time-poll`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as GroupSpacePost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not start the time poll");
      onChatPosted(payload);
      onToast("Time poll started. The game locks when everyone votes.");
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not start the time poll");
    } finally {
      setTimePolling(false);
    }
  }

  async function voteOnTimePoll(postId: string, optionId: string) {
    if (timePolling) return;
    setTimePolling(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/chat/${postId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ option_id: optionId }),
      });
      const payload = await response.json().catch(() => ({})) as GroupSpacePost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not record your vote");
      onChatPosted(payload);
      onToast(payload.poll_status === "resolved" ? "Time confirmed. Please book the court!" : "Vote recorded");
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not record your vote");
    } finally {
      setTimePolling(false);
    }
  }

  async function decideMatchResult(postId: string, agree: boolean) {
    if (decidingResultId) return;
    setDecidingResultId(postId);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/chat/${postId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agree }),
      });
      const payload = await response.json().catch(() => ({})) as GroupSpacePost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not update the match result");
      onChatPosted(payload);
      onToast(payload.result_status === "confirmed" ? "Score confirmed. CMR has been updated." : agree ? "Your score confirmation was recorded" : "Score marked for review");
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not update the match result");
    } finally {
      setDecidingResultId(null);
    }
  }

  async function addSharePhoto(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      onToast("Choose a JPG, PNG, or WebP photo");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      onToast("Each photo must be smaller than 8 MB");
      return;
    }
    if (sharePhotoUrls.length >= 6) {
      onToast("You can attach up to 6 photos");
      return;
    }
    try {
      setSharePhotoUploading(true);
      const compactedPhoto = await compactSocialPhoto(file);
      const response = await authorizedFetch(`${apiUrl}/v1/social/media/upload`, {
        method: "POST",
        headers: { "content-type": compactedPhoto.type },
        body: compactedPhoto,
      });
      const payload = await response.json().catch(() => ({})) as { media_url?: string; detail?: string };
      if (!response.ok || !payload.media_url) throw new Error(payload.detail ?? "Could not upload photo");
      setSharePhotoUrls((current) => [...current, payload.media_url!]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not upload photo");
    } finally {
      setSharePhotoUploading(false);
    }
  }

  async function publishPersonalPost(event: FormEvent) {
    event.preventDefault();
    const caption = shareCaption.trim();
    if (!caption || sharePublishing) return;
    try {
      setSharePublishing(true);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caption,
          sport: group.sport,
          session_id: group.id,
          media_urls: sharePhotoUrls,
          media_type: sharePhotoUrls.length ? "image" : undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not publish your post");
      try {
        for (const feed of ["all", "following", "personal"]) {
          window.sessionStorage.removeItem(`courtmate:social-feed:${currentUserId}:${feed}`);
        }
      } catch {
        // A disabled session storage must not block publishing a post.
      }
      setShareCaption("");
      setSharePhotoUrls([]);
      setShareOpen(false);
      onToast("Posted to your feed");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not publish your post");
    } finally {
      setSharePublishing(false);
    }
  }

  function openFeedback() {
    setFeedbackRequired(false);
    setFeedbackOpen(true);
  }

  function closeFeedback() {
    if (feedbackRequired) return;
    setFeedbackOpen(false);
  }

  return <section className={`group-space-page group-space-v2 ${feedbackPhase ? "group-feedback-phase" : ""}`} aria-label={`${group.group_name} Rally Circle`}>
      <header className="group-space-v2-header">
        <button className="group-space-back-button" type="button" onClick={onClose} aria-label="Back to games">← <span>Games</span></button>
        <div className="group-space-title"><span className="kicker">RALLY CIRCLE · {group.sport.replaceAll("_", " ").toUpperCase()}</span><h1>{group.group_name}</h1><p>{group.session_date} · {timeDescription} · {group.area} · {group.rating_mode === "competitive" ? "CMR-rated" : "Casual - no CMR"}</p></div>
        <div className="group-space-header-actions"><span className={`status-badge ${feedbackPhase ? "awaiting_feedback" : group.status}`}>{feedbackPhase ? "Awaiting feedback" : group.status === "completed" ? "Game done" : group.status === "in_progress" ? "Playing now" : flexibleTime ? "Time to confirm" : "Upcoming"}</span>{canStartTimePoll && <button className="group-space-time-poll-button" type="button" onClick={() => void startTimePoll()} disabled={timePolling}>{timePolling ? "Starting..." : "Start time poll"}</button>}{canMarkGameDone && <button className="group-space-mark-done-button" type="button" onClick={() => void markDone()} disabled={markingDone}>{markingDone ? "Saving..." : "Game done"}</button>}</div>
      </header>
      <div className="group-space-v2-grid">
        <section className="group-space-v2-chat">
          <div className="group-space-v2-heading"><div><span className="kicker">PRIVATE CHAT</span><h3>Plan it together</h3><p className="group-space-v2-subtitle">Coordinate venue, arrival, payments, warm-up, and the post-game wrap-up.</p><p className="group-space-social-hint">Mark the game done to open private ratings. Each player rates every other confirmed player, and only they can see what they submit.</p></div><div className="group-space-v2-heading-actions"><button className="workspace-refresh" type="button" onClick={onRefresh}>Refresh</button>{canRatePlayers && <button className="group-space-feedback-button" type="button" onClick={openFeedback}>Rate players</button>}</div></div>
          <div className="group-space-v2-feed">
            {posts.length ? posts.map((post) => {
              if (post.post_type === "time_poll") {
                const voterId = currentUserId ?? "";
                const selectedOptionId = post.poll_options?.find((option) => option.voter_ids.includes(voterId))?.id;
                const voterCount = new Set(post.poll_options?.flatMap((option) => option.voter_ids) ?? []).size;
                const requiredVotes = post.poll_participant_ids?.length ?? members.length;
                const winningOption = post.poll_options?.find((option) => option.id === post.poll_winner_id);
                const canVote = Boolean(voterId && post.poll_participant_ids?.includes(voterId) && post.poll_status === "open");
                return <article className="chat-post time-poll-card" key={post.id}><div className="group-space-v2-post-copy"><span className="kicker">TIME POLL</span><strong>{post.poll_status === "resolved" ? `Time locked: ${winningOption?.label ?? "slot confirmed"}` : "Choose a time that works"}</strong><p>{post.message}</p><div className="time-poll-options">{post.poll_options?.map((option) => <button type="button" className={`time-poll-option ${selectedOptionId === option.id ? "selected" : ""}`} key={option.id} onClick={() => void voteOnTimePoll(post.id, option.id)} disabled={!canVote || timePolling}>{option.label}<small>{option.voter_ids.length} vote{option.voter_ids.length === 1 ? "" : "s"}</small></button>)}</div><small>{post.poll_status === "resolved" ? "All original confirmed players voted. The final time is ready for booking." : `${voterCount}/${requiredVotes} players voted. Everyone in this poll needs to vote.`}</small></div></article>;
              }
              if (post.post_type === "match_result") {
                const resultPlayerIds = post.teams?.flatMap((team) => team.player_ids) ?? [];
                const currentPlayerInResult = Boolean(currentUserId && resultPlayerIds.includes(currentUserId));
                const currentPlayerConfirmed = Boolean(currentUserId && post.confirmation_ids?.includes(currentUserId));
                const awaitingCount = Math.max(resultPlayerIds.length - (post.confirmation_ids?.length ?? 0), 0);
                const firstTeam = post.teams?.[0];
                const secondTeam = post.teams?.[1];
                const scoreLabel = firstTeam && secondTeam
                  ? `${memberNames(firstTeam.player_ids, members)} ${firstTeam.score ?? "-"} - ${secondTeam.score ?? "-"} ${memberNames(secondTeam.player_ids, members)}`
                  : post.message;
                const ratingCopy = group.rating_mode === "competitive"
                  ? "A confirmed valid score updates CMR using the two teams and score margin."
                  : "Casual score recorded. This game will not change CMR.";
                return <article className={`chat-post chat-result-card ${post.result_status ?? ""}`} key={post.id}><div><span className="kicker">FINAL SCORE</span><span>{post.result_status === "confirmed" ? "Confirmed" : post.result_status === "disputed" ? "Needs review" : "Awaiting confirmation"}</span></div><strong>{scoreLabel}</strong><small>{ratingCopy}</small>{post.result_status === "pending_confirmation" && <span>{awaitingCount ? `${awaitingCount} player${awaitingCount === 1 ? "" : "s"} still need to confirm` : "Finalizing score"}</span>}{post.result_status === "confirmed" && <span>{group.rating_mode === "competitive" ? "CMR result recorded" : "Saved to the rally record"}</span>}{post.result_status === "pending_confirmation" && currentPlayerInResult && !currentPlayerConfirmed && <div className="chat-result-actions"><button type="button" onClick={() => void decideMatchResult(post.id, true)} disabled={decidingResultId === post.id}>{decidingResultId === post.id ? "Saving..." : "Confirm score"}</button><button className="chat-result-dispute" type="button" onClick={() => void decideMatchResult(post.id, false)} disabled={decidingResultId === post.id}>Dispute</button></div>}{post.result_status === "pending_confirmation" && currentPlayerConfirmed && <span>You confirmed this score.</span>}</article>;
              }
              if (post.post_type === "system") {
                return <article className="chat-post system-chat-post" key={post.id}><div className="group-space-v2-post-copy"><span className="kicker">COURTMATE</span><p>{post.message}</p><small>{new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div></article>;
              }
              return <article className={`chat-post ${post.player_id === currentUserId ? "mine" : ""}`} key={post.id}>
                <button type="button" className="group-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><span className="chat-avatar">{initials(post.player_display_name)}</span></button>
                <div className="group-space-v2-post-copy"><button type="button" className="group-profile-name" onClick={() => onViewProfile(post.player_id)}>{post.player_display_name}</button><p>{post.message}</p><small>{new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div>
              </article>;
            }) : <p className="activity-empty">No posts yet. Coordinate the session here.</p>}
          </div>
          <form className="chat-composer group-space-v2-composer" onSubmit={postChat}>
            <input ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500} placeholder="Message the group" aria-label="Private group chat message" />
            <button className={`chat-voice-button ${listening ? "listening" : ""}`} type="button" onClick={startVoice} aria-label={listening ? "Listening" : "Use voice to message the group"} title={listening ? "Listening" : "Use voice to message the group"}><MicrophoneIcon /></button>
            <button className="dark-button" type="submit" disabled={!draft.trim() || posting}>{posting ? "..." : "Post"}</button>
          </form>
          <p className="group-space-v2-hint">{group.rating_mode === "competitive" ? "After the game is done, post the final score here. Every player in the result must confirm it before CMR changes." : "Share practical details here. This casual game does not need a score and will not change CMR."}</p>
        </section>
        <section className="workspace-panel group-waitlist-panel group-lineup-panel"><div className="workspace-panel-heading"><div><span className="kicker">THE LINE-UP</span><h3>Players</h3></div>{canRatePlayers ? <button className="group-lineup-rate-button" type="button" onClick={openFeedback}>Rate players</button> : <span>{members.length} confirmed</span>}</div><p className="group-lineup-hint">Current CMR for this sport. Ratings open after someone marks the game done.</p><div className="group-roster-list">{members.map((member) => { const cmr = member.cmr_ratings?.[group.sport]; return <button type="button" className="group-roster-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span className="chat-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</span><span><strong>{member.display_name}{member.id === currentUserId ? " (You)" : ""}</strong><small>{cmr != null ? "Current CMR" : "CMR building"}</small></span><b>{cmr != null ? `${cmr.toFixed(1)} CMR` : "-"}</b></button>; })}</div><div className="group-waitlist-heading"><span className="kicker">NEXT UP</span><strong>Waitlist · {waitlist.length}</strong></div>{waitlist.length ? <div className="group-waitlist-list">{waitlist.map((member, index) => <button type="button" className="group-waitlist-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span>#{index + 1}</span><div><strong>{member.display_name}</strong><small>{member.area} · {member.style}</small></div><b>{member.cmr_ratings?.[group.sport]?.toFixed(1) ?? "-"}</b></button>)}</div> : <p className="activity-empty">No one is waiting. A player who backs out will release the next spot here.</p>}</section>
      </div>
      {canPostGame && <section className="group-space-share-card" aria-label="Share game to your feed">
        <div className="group-space-activity-mark" aria-hidden="true">↗</div>
        <div><span className="kicker">YOUR POST</span><h2>Post this game your way.</h2><p>Add your own message and photos whenever you choose. Posting is optional and appears only on your personal feed.</p><div className="group-space-activity-meta"><span>{group.sport.replaceAll("_", " ")}</span><span>{members.length} players</span><span>Only you publish</span></div>
        </div>
        <div className="group-space-share-actions"><button type="button" className="group-space-activity-open" onClick={() => setShareOpen((open) => !open)}>{shareOpen ? "Close composer" : "Post game"} <span>→</span></button><button type="button" className="group-space-share-link" onClick={onOpenPersonalRally}>View My rallies</button></div>
        {shareOpen && <form className="group-space-share-composer" onSubmit={publishPersonalPost}>
          <label><span>YOUR MESSAGE</span><textarea value={shareCaption} onChange={(event) => setShareCaption(event.target.value)} maxLength={500} placeholder={`What made ${group.group_name} memorable?`} aria-label="Message for your personal feed" autoFocus /></label>
          <div className="group-space-share-composer-actions"><label className="group-space-share-photo-button"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void addSharePhoto(file); }} disabled={sharePhotoUploading || sharePhotoUrls.length >= 6} />{sharePhotoUploading ? "Uploading..." : `Add photos${sharePhotoUrls.length ? ` (${sharePhotoUrls.length}/6)` : ""}`}</label><button type="submit" className="dark-button" disabled={!shareCaption.trim() || sharePhotoUploading || sharePublishing}>{sharePublishing ? "Publishing..." : "Post to my feed"} <span>→</span></button></div>
          {sharePhotoUrls.length > 0 && (
            <div className="group-space-share-previews">
              {sharePhotoUrls.map((url, index) => (
                <button type="button" key={url} onClick={() => setSharePhotoUrls((current) => current.filter((_, photoIndex) => photoIndex !== index))} aria-label={`Remove photo ${index + 1}`}>
                  {/* Uploaded previews can be Firebase URLs or local data URLs. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Post photo ${index + 1}`} />
                  <span>×</span>
                </button>
              ))}
            </div>
          )}
        </form>}
      </section>}
      {canRatePlayers && feedbackOpen && <div id="post-game-feedback" className="post-game-feedback-backdrop" role="presentation" onMouseDown={closeFeedback}><section className="post-game-feedback-modal" role="dialog" aria-modal="true" aria-labelledby="post-game-feedback-title" onMouseDown={(event) => event.stopPropagation()}>{!feedbackRequired && <button className="post-game-feedback-close" type="button" onClick={closeFeedback} aria-label="Close player feedback">×</button>}<PostGameFeedbackPanel key={group.id} mandatory={feedbackRequired} sessionId={group.id} sport={group.sport} ratingMode={group.rating_mode} members={members} currentUserId={currentUserId} apiUrl={apiUrl} authorizedFetch={authorizedFetch} onSaved={() => { setFeedbackOpen(false); setFeedbackRequired(false); onRefresh(); }} onToast={onToast} /></section></div>}
    </section>;
}
