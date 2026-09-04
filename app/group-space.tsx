"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
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
  delivery_state?: "sending";
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
  initialShareOpen?: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onMarkDone: () => Promise<boolean>;
  onLeave: () => Promise<void>;
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

// Keep uploads light enough for mobile while avoiding visible JPEG-like artifacts.
const SOCIAL_PHOTO_TARGET_BYTES = 900 * 1024;

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
    let largestDimension = Math.min(1800, longestSide);
    let quality = 0.9;
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
      quality = Math.max(0.62, quality - 0.05);
    }
    if (!smallest) throw new Error("Could not prepare this photo");
    return new File([smallest], `${file.name.replace(/\.[^.]+$/, "") || "game-photo"}.webp`, { type: "image/webp" });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export function GroupSpace({ group: inputGroup, members, waitlist, posts, currentUserId, apiUrl, authorizedFetch, initialFeedbackRequired = false, initialShareOpen = false, onClose, onRefresh, onMarkDone, onLeave, onChatPosted, onToast, onViewProfile }: GroupSpaceProps) {
  const feedbackPhase = inputGroup.status === "awaiting_feedback" || initialFeedbackRequired;
  const completedPhase = feedbackPhase || inputGroup.status === "completed";
  // Reuse the compact completed-state feedback UI while keeping the phase
  // visually distinct and withholding the Home activity card until final save.
  const group = feedbackPhase ? { ...inputGroup, status: "completed" } : inputGroup;
  const [markingDone, setMarkingDone] = useState(false);
  const [timePolling, setTimePolling] = useState(false);
  const [decidingResultId, setDecidingResultId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(initialFeedbackRequired || inputGroup.status === "completed");
  const [feedbackRequired, setFeedbackRequired] = useState(initialFeedbackRequired);
  const [mobileSection, setMobileSection] = useState<"chat" | "players" | "feedback" | "post">(
    completedPhase ? (initialShareOpen ? "post" : "feedback") : "chat",
  );
  const [shareCaption, setShareCaption] = useState("");
  const [sharePhotoUrls, setSharePhotoUrls] = useState<string[]>([]);
  const [sharePhotoUploading, setSharePhotoUploading] = useState(false);
  const [sharePublishing, setSharePublishing] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatPosting, setChatPosting] = useState(false);
  const [optimisticChatPosts, setOptimisticChatPosts] = useState<GroupSpacePost[]>([]);
  const chatFeedRef = useRef<HTMLDivElement | null>(null);
  const refreshChatRef = useRef(onChatPosted);
  useEffect(() => { refreshChatRef.current = onChatPosted; }, [onChatPosted]);

  useEffect(() => {
    const refreshChat = () => {
      if (document.visibilityState !== "visible") return;
      void authorizedFetch(`${apiUrl}/v1/sessions/${inputGroup.id}/chat`).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { posts?: GroupSpacePost[] };
        payload.posts?.forEach((post) => refreshChatRef.current(post));
      }).catch(() => undefined);
    };
    const timer = window.setInterval(refreshChat, 5000);
    window.addEventListener("focus", refreshChat);
    document.addEventListener("visibilitychange", refreshChat);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshChat);
      document.removeEventListener("visibilitychange", refreshChat);
    };
  }, [apiUrl, authorizedFetch, inputGroup.id]);
  const currentPlayerIsConfirmed = Boolean(currentUserId && members.some((member) => member.id === currentUserId));
  const flexibleTime = group.time_finalized === false && Boolean(group.time_window_start && group.time_window_end);
  const openTimePoll = posts.find((post) => post.post_type === "time_poll" && post.poll_status === "open");
  const canStartTimePoll = currentPlayerIsConfirmed && flexibleTime && !openTimePoll && members.length >= 2 && inputGroup.status !== "cancelled" && inputGroup.status !== "awaiting_feedback" && inputGroup.status !== "completed";
  const canMarkGameDone = currentPlayerIsConfirmed && !feedbackPhase && group.time_finalized !== false && inputGroup.status !== "cancelled" && inputGroup.status !== "completed";
  const canRatePlayers = currentPlayerIsConfirmed && completedPhase;
  const canPostGame = currentPlayerIsConfirmed && completedPhase;
  const canLeaveGame = currentPlayerIsConfirmed && currentUserId !== group.organizer_id && !completedPhase && inputGroup.status !== "cancelled";
  const visiblePosts = [...posts, ...optimisticChatPosts.filter((pending) => !posts.some((post) => post.id === pending.id))];
  const timeDescription = flexibleTime
    ? `${clock(group.time_window_start ?? group.start_time)}–${clock(group.time_window_end ?? group.end_time)} window · ${group.duration_minutes ?? 60}-minute game`
    : `${clock(group.start_time)}–${clock(group.end_time)}`;

  useEffect(() => {
    chatFeedRef.current?.scrollTo({ top: chatFeedRef.current.scrollHeight, behavior: "smooth" });
  }, [visiblePosts.length, mobileSection]);

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

  async function postChat(event: FormEvent) {
    event.preventDefault();
    const message = chatDraft.trim();
    if (!message || chatPosting || !currentPlayerIsConfirmed) return;
    const clientMessageId = `client-${crypto.randomUUID()}`;
    const optimisticPost: GroupSpacePost = {
      id: clientMessageId,
      player_id: currentUserId ?? "",
      player_display_name: members.find((member) => member.id === currentUserId)?.display_name ?? "You",
      message,
      post_type: "message",
      created_at: new Date().toISOString(),
      delivery_state: "sending",
    };
    setChatDraft("");
    setOptimisticChatPosts((current) => [...current, optimisticPost]);
    setChatPosting(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, client_message_id: clientMessageId }),
      });
      const payload = await response.json().catch(() => ({})) as GroupSpacePost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not post to the common chat");
      onChatPosted(payload);
      setOptimisticChatPosts((current) => current.filter((post) => post.id !== clientMessageId));
    } catch (error) {
      setOptimisticChatPosts((current) => current.filter((post) => post.id !== clientMessageId));
      setChatDraft((current) => current || message);
      onToast(error instanceof Error ? error.message : "Could not post to the common chat");
    } finally {
      setChatPosting(false);
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
    const localPreviewUrl = URL.createObjectURL(file);
    setSharePhotoUrls((current) => [...current, localPreviewUrl]);
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
      setSharePhotoUrls((current) => current.map((url) => url === localPreviewUrl ? payload.media_url! : url));
    } catch (error) {
      setSharePhotoUrls((current) => current.filter((url) => url !== localPreviewUrl));
      onToast(error instanceof Error ? error.message : "Could not upload photo");
    } finally {
      URL.revokeObjectURL(localPreviewUrl);
      setSharePhotoUploading(false);
    }
  }

  async function publishPersonalPost(event: FormEvent) {
    event.preventDefault();
    const caption = shareCaption.trim();
    if ((!caption && !sharePhotoUrls.length) || sharePublishing) return;
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

  return <section className={`group-space-page group-space-v2 ${feedbackPhase ? "group-feedback-phase" : ""} ${completedPhase ? "completed-phase" : ""}`} aria-label={`${group.group_name} Rally Circle`}>
      <header className="group-space-v2-header">
        <button className="group-space-back-button" type="button" onClick={onClose} aria-label="Back to games">← <span>Games</span></button>
        <div className="group-space-title"><span className="kicker">RALLY CIRCLE · {group.sport.replaceAll("_", " ").toUpperCase()}</span><h1>{group.group_name}</h1><p>{group.session_date} · {timeDescription} · {group.area} · CMR session</p></div>
        <div className="group-space-header-actions"><span className={`status-badge ${feedbackPhase ? "awaiting_feedback" : group.status}`}>{feedbackPhase ? "Feedback due" : group.status === "completed" ? "Completed" : group.status === "in_progress" ? "Playing now" : flexibleTime ? "Time to confirm" : "Upcoming"}</span>{canStartTimePoll && <button className="group-space-time-poll-button" type="button" onClick={() => void startTimePoll()} disabled={timePolling}>{timePolling ? "Starting..." : "Start time poll"}</button>}{canLeaveGame && <button className="group-space-leave-button" type="button" onClick={() => void onLeave()}>Back out</button>}{canMarkGameDone && <button className="group-space-mark-done-button" type="button" onClick={() => void markDone()} disabled={markingDone}>{markingDone ? "Saving..." : "Mark game as completed"}</button>}</div>
      </header>
      <nav className="group-space-action-bar" aria-label="Rally Circle actions">
        {completedPhase ? <>
          <button className={mobileSection === "feedback" ? "active" : ""} type="button" aria-pressed={mobileSection === "feedback"} onClick={() => { openFeedback(); setMobileSection("feedback"); }}>1. Feedback &amp; rating</button>
          <button className={mobileSection === "post" ? "active" : ""} type="button" aria-pressed={mobileSection === "post"} onClick={() => setMobileSection("post")}>2. Post on feed</button>
          <button className={mobileSection === "chat" ? "active" : ""} type="button" aria-pressed={mobileSection === "chat"} aria-controls="rally-common-chat" onClick={() => setMobileSection("chat")}>3. Chat</button>
        </> : <>
          <button className={`group-space-section-jump ${mobileSection === "chat" ? "active" : ""}`} type="button" aria-pressed={mobileSection === "chat"} aria-controls="rally-common-chat" onClick={() => setMobileSection("chat")}>Chat</button>
          <button className={`group-space-section-jump ${mobileSection === "players" ? "active" : ""}`} type="button" aria-pressed={mobileSection === "players"} aria-controls="rally-lineup" onClick={() => setMobileSection("players")}>Players</button>
        </>}
      </nav>
      <div className="group-space-v2-grid">
        <section className={`group-space-v2-chat ${mobileSection !== "chat" ? "mobile-section-hidden" : ""}`} id="rally-common-chat">
          <div className="group-space-v2-heading"><div><span className="kicker">RALLY CIRCLE</span><h3>Common chat</h3><p className="group-space-v2-subtitle">Coordinate the game and keep the final result together.</p></div><div className="group-space-v2-heading-actions"><button className="workspace-refresh" type="button" onClick={onRefresh}>Refresh</button>{canRatePlayers && <button className="group-space-feedback-button" type="button" onClick={openFeedback}>{feedbackOpen ? "Ratings open" : "Rate players"}</button>}</div></div>
          <div className="group-space-v2-feed" ref={chatFeedRef} aria-live="polite">
            {visiblePosts.length ? visiblePosts.map((post) => {
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
                return <article className={`chat-post chat-result-card ${post.result_status ?? ""}`} key={post.id}><div><span className="kicker">FINAL SCORE</span><span>{post.result_status === "confirmed" ? "Confirmed" : post.result_status === "disputed" ? "Needs review" : "Awaiting confirmation"}</span></div><strong>{scoreLabel}</strong><small>The score is kept with the session. Player feedback builds CMR.</small>{post.result_status === "pending_confirmation" && <span>{awaitingCount ? `${awaitingCount} player${awaitingCount === 1 ? "" : "s"} still need to confirm` : "Finalizing score"}</span>}{post.result_status === "confirmed" && <span>Saved to the rally record</span>}{post.result_status === "pending_confirmation" && currentPlayerInResult && !currentPlayerConfirmed && <div className="chat-result-actions"><button type="button" onClick={() => void decideMatchResult(post.id, true)} disabled={decidingResultId === post.id}>{decidingResultId === post.id ? "Saving..." : "Confirm score"}</button><button className="chat-result-dispute" type="button" onClick={() => void decideMatchResult(post.id, false)} disabled={decidingResultId === post.id}>Dispute</button></div>}{post.result_status === "pending_confirmation" && currentPlayerConfirmed && <span>You confirmed this score.</span>}</article>;
              }
              if (post.post_type === "system") {
                return <article className="chat-post system-chat-post" key={post.id}><div className="group-space-v2-post-copy"><span className="kicker">COURTMATE</span><p>{post.message}</p><small>{new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div></article>;
              }
              return <article className={`chat-post ${post.player_id === currentUserId ? "mine" : ""} ${post.delivery_state === "sending" ? "sending" : ""}`} key={post.id}>
                <button type="button" className="group-profile-trigger" onClick={() => onViewProfile(post.player_id)} aria-label={`View ${post.player_display_name}'s profile`}><span className="chat-avatar">{initials(post.player_display_name)}</span></button>
                <div className="group-space-v2-post-copy"><button type="button" className="group-profile-name" onClick={() => onViewProfile(post.player_id)}>{post.player_display_name}</button><p>{post.message}</p><small>{post.delivery_state === "sending" ? "Sending…" : new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div>
              </article>;
            }) : <div className="group-chat-empty"><span className="chat-avatar" aria-hidden="true">CM</span><div><strong>{completedPhase ? "Keep the circle going" : "Start the conversation"}</strong><p>{completedPhase ? "No messages yet. Share a highlight or plan the next game." : "No messages yet. Coordinate the session here."}</p></div></div>}
          </div>
          {currentPlayerIsConfirmed && <form className="chat-composer group-space-v2-composer" onSubmit={postChat}>
            <input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder="Message the group..." aria-label="Message the common chat" maxLength={500} />
            <button className="dark-button" type="submit" disabled={!chatDraft.trim() || chatPosting}>{chatPosting ? "Sending" : "Post"}</button>
          </form>}
          {!completedPhase && !currentPlayerIsConfirmed && <p className="group-space-v2-hint">Only confirmed players can post in the common chat.</p>}
        </section>
        {!completedPhase && <section className={`workspace-panel group-waitlist-panel group-lineup-panel ${mobileSection !== "players" ? "mobile-section-hidden" : ""}`} id="rally-lineup"><div className="workspace-panel-heading"><div><span className="kicker">THE LINE-UP</span><h3>Players</h3></div><span>{members.length} confirmed</span></div><p className="group-lineup-hint">Current CMR for this sport.</p><div className="group-roster-list">{members.map((member) => { const cmr = member.cmr_ratings?.[group.sport]; return <button type="button" className="group-roster-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span className="chat-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</span><span><strong>{member.display_name}{member.id === currentUserId ? " (You)" : ""}</strong><small>{cmr != null ? "Current CMR" : "CMR building"}</small></span><b>{cmr != null ? `${cmr.toFixed(1)} CMR` : "-"}</b></button>; })}</div><div className="group-waitlist-heading"><span className="kicker">NEXT UP</span><strong>Waitlist · {waitlist.length}</strong></div>{waitlist.length ? <div className="group-waitlist-list">{waitlist.map((member, index) => <button type="button" className="group-waitlist-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span>#{index + 1}</span><div><strong>{member.display_name}</strong><small>{member.area} · {member.style}</small></div><b>{member.cmr_ratings?.[group.sport]?.toFixed(1) ?? "-"}</b></button>)}</div> : <p className="activity-empty">No one is waiting. A player who backs out will release the next spot here.</p>}</section>}
        {completedPhase && canRatePlayers && feedbackOpen && <section className={`workspace-panel group-inline-feedback group-feedback-only-panel ${mobileSection !== "feedback" ? "mobile-section-hidden" : ""}`}><PostGameFeedbackPanel key={group.id} mandatory={feedbackRequired} sessionId={group.id} sport={group.sport} ratingMode={group.rating_mode} members={members} currentUserId={currentUserId} apiUrl={apiUrl} authorizedFetch={authorizedFetch} onSaved={() => { setFeedbackRequired(false); }} onToast={onToast} /></section>}
        {canPostGame && <section className={`group-space-share-card group-space-post-workspace ${mobileSection !== "post" ? "mobile-section-hidden" : ""}`} aria-label="Post game to your feed">
          <form className="group-space-share-composer" onSubmit={publishPersonalPost}>
            <div><span className="kicker">POST ON FEED</span><h2>Share your rally</h2><p>Add the moments you want your circle to remember.</p></div>
            <label><span>YOUR MESSAGE</span><textarea value={shareCaption} onChange={(event) => setShareCaption(event.target.value)} maxLength={500} placeholder={`What made ${group.group_name} memorable?`} aria-label="Message for your personal feed" /></label>
            <div className="group-space-share-composer-actions"><label className="group-space-share-photo-button"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void addSharePhoto(file); }} disabled={sharePhotoUploading || sharePhotoUrls.length >= 6} />{sharePhotoUploading ? "Uploading..." : `Add photos${sharePhotoUrls.length ? ` (${sharePhotoUrls.length}/6)` : ""}`}</label><button type="submit" className="dark-button" disabled={(!shareCaption.trim() && !sharePhotoUrls.length) || sharePhotoUploading || sharePublishing}>{sharePublishing ? "Publishing..." : "Post on feed"} <span>→</span></button></div>
            {sharePhotoUrls.length > 0 && <div className="group-space-share-previews">{sharePhotoUrls.map((url, index) => <button type="button" key={url} onClick={() => setSharePhotoUrls((current) => current.filter((_, photoIndex) => photoIndex !== index))} aria-label={`Remove photo ${index + 1}`}>
              {/* Uploaded previews can be Firebase URLs or local data URLs. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`Post photo ${index + 1}`} /><span>×</span></button>)}</div>}
          </form>
        </section>}
      </div>
    </section>;
}
