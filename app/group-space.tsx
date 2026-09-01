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
  checked_in_player_ids?: string[];
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
  onClose: () => void;
  onRefresh: () => void;
  onMarkDone: () => Promise<void>;
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

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

export function GroupSpace({ group: inputGroup, members, waitlist, posts, currentUserId, apiUrl, authorizedFetch, onClose, onRefresh, onMarkDone, onOpenPersonalRally, onChatPosted, onToast, onViewProfile }: GroupSpaceProps) {
  const feedbackPhase = inputGroup.status === "awaiting_feedback";
  // Reuse the compact completed-state feedback UI while keeping the phase
  // visually distinct and withholding the Home activity card until final save.
  const group = feedbackPhase ? { ...inputGroup, status: "completed" } : inputGroup;
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [posting, setPosting] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [timePolling, setTimePolling] = useState(false);
  const [decidingResultId, setDecidingResultId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);
  const currentPlayerIsConfirmed = Boolean(currentUserId && members.some((member) => member.id === currentUserId));
  const currentPlayerCheckedIn = Boolean(currentUserId && group.checked_in_player_ids?.includes(currentUserId));
  const flexibleTime = group.time_finalized === false && Boolean(group.time_window_start && group.time_window_end);
  const openTimePoll = posts.find((post) => post.post_type === "time_poll" && post.poll_status === "open");
  const canStartTimePoll = currentUserId === group.organizer_id && flexibleTime && !openTimePoll && members.length >= 2 && group.status !== "cancelled" && group.status !== "completed";
  const canComplete = currentPlayerIsConfirmed && group.time_finalized !== false && group.status !== "cancelled" && (group.status !== "completed" || feedbackPhase);
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
      await onMarkDone();
    } finally {
      setMarkingDone(false);
    }
  }

  async function checkIn() {
    if (checkingIn || currentPlayerCheckedIn) return;
    setCheckingIn(true);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/check-in`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not check in");
      onToast("Check-in recorded");
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not check in");
    } finally {
      setCheckingIn(false);
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

  return <section className={`group-space-page group-space-v2 ${feedbackPhase ? "group-feedback-phase" : ""}`} aria-label={`${group.group_name} Rally Circle`}>
      <header className="group-space-v2-header">
        <button className="group-space-back-button" type="button" onClick={onClose} aria-label="Back to games">← <span>Games</span></button>
        <div className="group-space-title"><span className="kicker">RALLY CIRCLE · {group.sport.replaceAll("_", " ").toUpperCase()}</span><h1>{group.group_name}</h1><p>{group.session_date} · {timeDescription} · {group.area} · {group.rating_mode === "competitive" ? "CMR-rated" : "Casual - no CMR"}</p></div>
        <div className="group-space-header-actions"><span className={`status-badge ${feedbackPhase ? "awaiting_feedback" : group.status}`}>{feedbackPhase ? "Awaiting feedback" : group.status === "completed" ? "Game done" : group.status === "in_progress" ? "Playing now" : flexibleTime ? "Time to confirm" : "Upcoming"}</span>{canStartTimePoll && <button className="group-space-time-poll-button" type="button" onClick={() => void startTimePoll()} disabled={timePolling}>{timePolling ? "Starting..." : "Start time poll"}</button>}{currentPlayerIsConfirmed && !feedbackPhase && group.status !== "completed" && group.time_finalized !== false && <button className="group-space-check-in-button" type="button" onClick={() => void checkIn()} disabled={checkingIn || currentPlayerCheckedIn}>{currentPlayerCheckedIn ? "Checked in" : checkingIn ? "Checking in..." : "Check in"}</button>}{canComplete && <button className="group-space-mark-done-button" type="button" onClick={() => void markDone()} disabled={markingDone}>{markingDone ? "Completing..." : feedbackPhase ? "Finish & publish" : "Complete game"}</button>}</div>
      </header>
      <div className="group-space-v2-grid">
        <section className="group-space-v2-chat">
          <div className="group-space-v2-heading"><div><span className="kicker">PRIVATE CHAT</span><h3>Plan it together</h3><p className="group-space-v2-subtitle">Coordinate venue, arrival, payments, warm-up, and the post-game wrap-up.</p><p className="group-space-social-hint">This is the home for the group before and after the match. Any confirmed player can complete the game, which posts the activity to Home and prompts the lineup for ratings.</p></div><div className="group-space-v2-heading-actions"><button className="workspace-refresh" type="button" onClick={onRefresh}>Refresh</button>{group.status === "completed" && <button className="group-space-feedback-button" type="button" onClick={() => setFeedbackOpen(true)}>Rate players</button>}</div></div>
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
          <p className="group-space-v2-hint">{group.rating_mode === "competitive" ? "After completion, post the final score here. Every player in the result must confirm it before CMR changes." : "Share practical details here. This casual game does not need a score and will not change CMR."}</p>
        </section>
        <section className="workspace-panel group-waitlist-panel group-lineup-panel"><div className="workspace-panel-heading"><div><span className="kicker">THE LINE-UP</span><h3>Players</h3></div>{group.status === "completed" ? <button className="group-lineup-rate-button" type="button" onClick={() => setFeedbackOpen(true)}>Rate players</button> : <span>{members.length} confirmed</span>}</div><p className="group-lineup-hint">Current CMR for this sport. Ratings open when the game is complete.</p><div className="group-roster-list">{members.map((member) => { const cmr = member.cmr_ratings?.[group.sport]; return <button type="button" className="group-roster-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span className="chat-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</span><span><strong>{member.display_name}{member.id === currentUserId ? " (You)" : ""}</strong><small>{cmr != null ? "Current CMR" : "CMR building"}</small></span><b>{cmr != null ? `${cmr.toFixed(1)} CMR` : "-"}</b></button>; })}</div><div className="group-waitlist-heading"><span className="kicker">NEXT UP</span><strong>Waitlist · {waitlist.length}</strong></div>{waitlist.length ? <div className="group-waitlist-list">{waitlist.map((member, index) => <button type="button" className="group-waitlist-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span>#{index + 1}</span><div><strong>{member.display_name}</strong><small>{member.area} · {member.style}</small></div><b>{member.cmr_ratings?.[group.sport]?.toFixed(1) ?? "-"}</b></button>)}</div> : <p className="activity-empty">No one is waiting. A player who backs out will release the next spot here.</p>}</section>
      </div>
      {group.status === "completed" && <section className="group-space-activity-card" aria-label="Post-game activity">
        <div className="group-space-activity-mark" aria-hidden="true">↗</div>
        <div><span className="kicker">POST-GAME ACTIVITY</span><h2>Rally saved to your circle.</h2><p>{group.group_name} is now a completed-game update with the final line-up and each player&apos;s CMR movement.</p><div className="group-space-activity-meta"><span>{group.sport.replaceAll("_", " ")}</span><span>{members.length} players</span><span>CMR movement</span></div>
        </div>
        <button type="button" className="group-space-activity-open" onClick={onOpenPersonalRally}>Open My rallies <span>→</span></button>
      </section>}
      {group.status === "completed" && feedbackOpen && <div id="post-game-feedback"><PostGameFeedbackPanel sessionId={group.id} sport={group.sport} ratingMode={group.rating_mode} members={members} currentUserId={currentUserId} apiUrl={apiUrl} authorizedFetch={authorizedFetch} onSaved={() => { setFeedbackOpen(false); onRefresh(); }} onToast={onToast} /></div>}
    </section>;
}
