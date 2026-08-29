"use client";

import { FormEvent, useState } from "react";
import { PostGameFeedbackPanel } from "./post-game-feedback";

type GroupSpaceSession = {
  id: string;
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

type ActivityProof = {
  id: string;
  player_id: string;
  image_url: string;
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
};

type LeaderboardEntry = {
  rank: number;
  player: { id: string; display_name: string };
  score: number;
  ratings_count: number;
};

type GroupSpaceProps = {
  group: GroupSpaceSession;
  members: GroupSpaceMember[];
  waitlist: GroupSpaceMember[];
  posts: GroupSpacePost[];
  leaderboard: LeaderboardEntry[];
  localLeaderboard: LeaderboardEntry[];
  currentUserId?: string;
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onRefresh: () => void;
  onToast: (message: string) => void;
  activityProofs?: ActivityProof[];
  onAnalyzeActivityProof: (file: File) => Promise<ActivityProof | null>;
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

export function GroupSpace({ group, members, waitlist, posts, leaderboard, localLeaderboard, currentUserId, apiUrl, authorizedFetch, onClose, onRefresh, onToast, activityProofs = [], onAnalyzeActivityProof }: GroupSpaceProps) {
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [posting, setPosting] = useState(false);
  const [decisionId, setDecisionId] = useState<string | null>(null);

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
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not post to group chat");
      setDraft("");
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not post to group chat");
    } finally {
      setPosting(false);
    }
  }

  async function decideResult(post: GroupSpacePost, agree: boolean) {
    if (!post.post_type || post.post_type !== "match_result" || decisionId) return;
    setDecisionId(post.id);
    try {
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${group.id}/chat/${post.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agree }),
      });
      const payload = await response.json().catch(() => ({})) as GroupSpacePost & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Could not update this result");
      onToast(agree ? (payload.result_status === "confirmed" ? "Result confirmed. CMR has been updated." : "Your confirmation was added.") : "Result marked for review. CMR will not use it.");
      onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not update this result");
    } finally {
      setDecisionId(null);
    }
  }

  return <div className="group-space-v2-backdrop" onClick={onClose}>
    <section className="group-space-v2" onClick={(event) => event.stopPropagation()} aria-label={`${group.group_name} group space`}>
      <header className="group-space-v2-header">
        <div><span className="kicker">{group.sport.replaceAll("_", " ").toUpperCase()} GROUP SPACE</span><h2>{group.group_name}</h2><p>{group.session_date} · {group.start_time}–{group.end_time} · {group.area}</p></div>
        <button className="close-button" type="button" onClick={onClose} aria-label="Close group space">×</button>
      </header>
      <div className="group-space-v2-grid">
        <section className="group-space-v2-chat">
          <div className="group-space-v2-heading"><div><span className="kicker">LIVE CHAT</span><h3>Coordinate the game</h3></div><button className="workspace-refresh" type="button" onClick={onRefresh}>Refresh</button></div>
          <div className="group-space-v2-feed">
            {posts.length ? posts.map((post) => {
              const resultPlayers = post.teams?.flatMap((team) => team.player_ids) ?? [];
              const confirmations = post.confirmation_ids ?? [];
              const pending = post.post_type === "match_result" && (post.result_status ?? "confirmed") === "pending_confirmation";
              const canConfirm = pending && Boolean(currentUserId) && resultPlayers.includes(currentUserId ?? "") && !confirmations.includes(currentUserId ?? "");
              return <article className={`chat-post ${post.player_id === currentUserId ? "mine" : ""}`} key={post.id}>
                <div className="chat-avatar">{initials(post.player_display_name)}</div>
                <div className="group-space-v2-post-copy"><strong>{post.player_display_name}</strong><p>{post.message}</p><small>{new Date(post.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small>
                  {post.post_type === "match_result" && post.teams?.length === 2 && <div className={`chat-result-card ${post.result_status ?? "confirmed"}`}><div><strong>{post.result_status === "disputed" ? "Result needs review" : post.result_status === "confirmed" || !post.result_status ? "Result confirmed" : "Confirm this result"}</strong><small>{memberNames(post.teams[0].player_ids, members)} {post.teams[0].score ?? "-"} – {post.teams[1].score ?? "-"} {memberNames(post.teams[1].player_ids, members)}</small></div>{pending && <span>{confirmations.length}/{resultPlayers.length} agreed</span>}{canConfirm && <div className="chat-result-actions"><button type="button" onClick={() => void decideResult(post, true)} disabled={decisionId === post.id}>Agree</button><button type="button" className="chat-result-dispute" onClick={() => void decideResult(post, false)} disabled={decisionId === post.id}>Dispute</button></div>}</div>}
                </div>
              </article>;
            }) : <p className="activity-empty">No posts yet. Coordinate the session here.</p>}
          </div>
          <form className="chat-composer group-space-v2-composer" onSubmit={postChat}>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500} placeholder="Post an update or match score" aria-label="Group chat message" />
            <button className={`chat-voice-button ${listening ? "listening" : ""}`} type="button" onClick={startVoice} aria-label={listening ? "Listening" : "Dictate a group update"} title="Dictate a group update"><span>◉</span></button>
            <button className="dark-button" type="submit" disabled={!draft.trim() || posting}>{posting ? "..." : "Post"}</button>
          </form>
          <p className="group-space-v2-hint">Try: “Rhea and Ananya beat Kavya and Meera 11-8”. Everyone in the result can agree before CMR updates.</p>
        </section>
        <section className="workspace-panel group-waitlist-panel"><div className="workspace-panel-heading"><div><span className="kicker">THE LINE-UP</span><h3>Playing now</h3></div><span>{members.length} confirmed</span></div><div className="group-roster-list">{members.map((member) => <div className="group-roster-row" key={member.id}><span className="chat-avatar">{initials(member.display_name)}</span><strong>{member.display_name}</strong><b>{member.cmr_ratings?.[group.sport]?.toFixed(1) ?? "-"}</b></div>)}</div><div className="group-waitlist-heading"><span className="kicker">NEXT UP</span><strong>Waitlist · {waitlist.length}</strong></div>{waitlist.length ? <div className="group-waitlist-list">{waitlist.map((member, index) => <div className="group-waitlist-row" key={member.id}><span>#{index + 1}</span><div><strong>{member.display_name}</strong><small>{member.area} · {member.style}</small></div><b>{member.cmr_ratings?.[group.sport]?.toFixed(1) ?? "-"}</b></div>)}</div> : <p className="activity-empty">No one is waiting. A player who backs out will release the next spot here.</p>}</section>
        <section className="workspace-panel leaderboard-panel"><div className="workspace-panel-heading"><div><span className="kicker">{group.sport.replaceAll("_", " ").toUpperCase()} LEADERBOARD</span><h3>Group rankings</h3></div></div>{leaderboard.length ? <div className="leaderboard-list">{leaderboard.map((entry) => <div className="leaderboard-row" key={entry.player.id}><span className="rank">{entry.rank}</span><div><strong>{entry.player.display_name}</strong><small>{entry.ratings_count} rated game{entry.ratings_count === 1 ? "" : "s"}</small></div><b>{entry.score.toFixed(1)}</b></div>)}</div> : <p className="activity-empty">Confirmed results will build this leaderboard.</p>}<div className="local-leaderboard"><span className="kicker">{group.area.toUpperCase()} · LOCAL</span>{localLeaderboard.slice(0, 5).map((entry) => <div className="local-row" key={entry.player.id}><span>#{entry.rank}</span><strong>{entry.player.display_name}</strong><b>{entry.score.toFixed(1)}</b></div>)}</div></section>
      </div>
      {group.status === "completed" && <PostGameFeedbackPanel sessionId={group.id} members={members} currentUserId={currentUserId} apiUrl={apiUrl} authorizedFetch={authorizedFetch} activityProofs={activityProofs} onAnalyzeActivityProof={onAnalyzeActivityProof} onSaved={onRefresh} onToast={onToast} />}
    </section>
  </div>;
}
