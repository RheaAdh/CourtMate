"use client";

import { FormEvent, useState } from "react";

type FeedbackMember = {
  id: string;
  display_name: string;
  cmr_ratings?: Record<string, number>;
  sport_ratings?: Record<string, number>;
  dupr_rating?: number | null;
};

type PostGameFeedbackProps = {
  sessionId: string;
  sport: string;
  ratingMode?: "casual" | "competitive";
  members: FeedbackMember[];
  currentUserId?: string;
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  mandatory?: boolean;
  onSaved: () => void;
  onToast: (message: string) => void;
};

export function PostGameFeedbackPanel({ sessionId, sport, members, currentUserId, apiUrl, authorizedFetch, mandatory = false, onSaved, onToast }: PostGameFeedbackProps) {
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>(() => Object.fromEntries(
    members.filter((member) => member.id !== currentUserId).map((member) => [member.id, ""]),
  ));
  const [matchQuality, setMatchQuality] = useState("5");
  const [sessionNote, setSessionNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    const otherPlayers = members.filter((member) => member.id !== currentUserId);
    if (otherPlayers.some((member) => !playerRatings[member.id])) {
      onToast("Please rate every other player from 1 to 10");
      return;
    }
    try {
      setSaving(true);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          match_quality: Number(matchQuality),
          fun: Number(matchQuality),
          fairness: 5,
          would_return: true,
          session_note: sessionNote.trim() || null,
          ratings: otherPlayers.map((member) => ({ player_id: member.id, rating_10: Number(playerRatings[member.id]) })),
        }),
      });
      if (!response.ok) throw new Error("Feedback failed");
      setSaved(true);
      onToast("Feedback saved. Your player ratings now contribute to CMR.");
      onSaved();
    } catch {
      onToast("Could not save your post-game feedback");
    } finally {
      setSaving(false);
    }
  }

  return <form className="workspace-panel feedback-panel feedback-panel-new" onSubmit={submitFeedback}>
    <div className="workspace-panel-heading"><div><span className="kicker">GAME FEEDBACK</span><h3 id="post-game-feedback-title">Rate your lineup</h3><p className="feedback-intro">Rate how each player performed. Combined feedback builds their sport-specific CMR.</p>{mandatory && <p className="feedback-required-note">Complete this to close your game.</p>}</div></div>
    <fieldset className="player-rating-fields"><legend>Players</legend><div className="player-rating-list">{members.filter((member) => member.id !== currentUserId).map((member) => <label className="player-rating-row" key={member.id}><span><strong>{member.display_name}</strong><small>{playerRatings[member.id] ? `Rating ${playerRatings[member.id]} / 10` : member.cmr_ratings?.[sport] != null ? `Current CMR ${member.cmr_ratings[sport].toFixed(1)}` : "CMR building"}</small></span><select required aria-label={`Rate playing with ${member.display_name} out of 10`} value={playerRatings[member.id] ?? ""} onChange={(event) => setPlayerRatings((ratings) => ({ ...ratings, [member.id]: event.target.value }))}><option value="" disabled>Rate /10</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} / 10</option>)}</select></label>)}</div></fieldset>
    <fieldset className="feedback-quality-field"><legend>How was the game?</legend><div className="feedback-quality-control"><div className="feedback-quality-rating" role="radiogroup" aria-label="Rate the game from 1 to 5">{Array.from({ length: 5 }, (_, index) => index + 1).map((value) => <button type="button" key={value} className={Number(matchQuality) >= value ? "selected" : ""} onClick={() => setMatchQuality(String(value))} role="radio" aria-checked={Number(matchQuality) === value} aria-label={`${value} out of 5`} aria-pressed={Number(matchQuality) === value} title={`${value} out of 5`}>★</button>)}</div><strong>{matchQuality} / 5</strong></div></fieldset>
    <label className="feedback-session-note">
      <span>How was the session?</span>
      <textarea value={sessionNote} onChange={(event) => setSessionNote(event.target.value)} maxLength={500} placeholder="Share a highlight, what worked, or what could be better." aria-label="Optional written feedback about the game session" />
      <small>Optional · {sessionNote.length}/500</small>
    </label>
    <button className="dark-button" type="submit" disabled={saving || saved}>{saving ? "Saving..." : saved ? "Feedback saved" : "Save feedback"} <span>{saved ? "✓" : "→"}</span></button>
  </form>;
}
