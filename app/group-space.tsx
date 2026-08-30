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
  post_type?: "message" | "match_result";
  teams?: { name: string; player_ids: string[]; score?: number | null }[];
  result_status?: "pending_confirmation" | "confirmed" | "disputed" | null;
  confirmation_ids?: string[];
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

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

export function GroupSpace({ group, members, waitlist, posts, currentUserId, apiUrl, authorizedFetch, onClose, onRefresh, onMarkDone, onChatPosted, onToast, onViewProfile }: GroupSpaceProps) {
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [posting, setPosting] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);
  const currentPlayerIsConfirmed = Boolean(currentUserId && members.some((member) => member.id === currentUserId));

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

  return <section className="group-space-page group-space-v2" aria-label={`${group.group_name} group space`}>
      <header className="group-space-v2-header">
        <button className="group-space-back-button" type="button" onClick={onClose} aria-label="Back to games">← <span>Games</span></button>
        <div className="group-space-title"><span className="kicker">GROUP SPACE · {group.sport.replaceAll("_", " ").toUpperCase()}</span><h1>{group.group_name}</h1><p>{group.session_date} · {group.start_time}–{group.end_time} · {group.area}</p></div>
        <div className="group-space-header-actions"><span className={`status-badge ${group.status}`}>{group.status === "completed" ? "Game done" : group.status === "in_progress" ? "Playing now" : "Upcoming"}</span>{currentPlayerIsConfirmed && group.status !== "completed" && group.status !== "cancelled" && <button className="group-space-mark-done-button" type="button" onClick={() => void markDone()} disabled={markingDone}>{markingDone ? "Completing..." : "Complete game"}</button>}</div>
      </header>
      <div className="group-space-v2-grid">
        <section className="group-space-v2-chat">
          <div className="group-space-v2-heading"><div><span className="kicker">PRIVATE CHAT</span><h3>Plan it together</h3><p className="group-space-v2-subtitle">Coordinate venue, arrival, payments, warm-up, and the post-game wrap-up.</p><p className="group-space-social-hint">This is the home for the group before and after the match. Any confirmed player can complete the game, which posts the activity to Home and prompts the lineup for ratings.</p></div><div className="group-space-v2-heading-actions"><button className="workspace-refresh" type="button" onClick={onRefresh}>Refresh</button>{group.status === "completed" && <button className="group-space-feedback-button" type="button" onClick={() => setFeedbackOpen(true)}>Rate players</button>}</div></div>
          <div className="group-space-v2-feed">
            {posts.length ? posts.map((post) => {
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
          <p className="group-space-v2-hint">Share practical details here. No score entry needed.</p>
        </section>
        <section className="workspace-panel group-waitlist-panel group-lineup-panel"><div className="workspace-panel-heading"><div><span className="kicker">THE LINE-UP</span><h3>Players</h3></div>{group.status === "completed" ? <button className="group-lineup-rate-button" type="button" onClick={() => setFeedbackOpen(true)}>Rate players</button> : <span>{members.length} confirmed</span>}</div><p className="group-lineup-hint">Current CMR for this sport. Ratings open when the game is complete.</p><div className="group-roster-list">{members.map((member) => { const cmr = member.cmr_ratings?.[group.sport]; return <button type="button" className="group-roster-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span className="chat-avatar">{member.profile_image_url ? <img src={member.profile_image_url} alt="" /> : initials(member.display_name)}</span><span><strong>{member.display_name}{member.id === currentUserId ? " (You)" : ""}</strong><small>{cmr != null ? "Current CMR" : "CMR building"}</small></span><b>{cmr != null ? `${cmr.toFixed(1)} CMR` : "-"}</b></button>; })}</div><div className="group-waitlist-heading"><span className="kicker">NEXT UP</span><strong>Waitlist · {waitlist.length}</strong></div>{waitlist.length ? <div className="group-waitlist-list">{waitlist.map((member, index) => <button type="button" className="group-waitlist-row group-profile-row" key={member.id} onClick={() => onViewProfile(member.id)} aria-label={`View ${member.display_name}'s profile`}><span>#{index + 1}</span><div><strong>{member.display_name}</strong><small>{member.area} · {member.style}</small></div><b>{member.cmr_ratings?.[group.sport]?.toFixed(1) ?? "-"}</b></button>)}</div> : <p className="activity-empty">No one is waiting. A player who backs out will release the next spot here.</p>}</section>
      </div>
      {group.status === "completed" && feedbackOpen && <div id="post-game-feedback"><PostGameFeedbackPanel sessionId={group.id} sport={group.sport} members={members} currentUserId={currentUserId} apiUrl={apiUrl} authorizedFetch={authorizedFetch} onSaved={() => { setFeedbackOpen(false); onRefresh(); }} onToast={onToast} /></div>}
    </section>;
}
