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

export function PostGameFeedbackPanel({ sessionId, sport, ratingMode = "casual", members, currentUserId, apiUrl, authorizedFetch, mandatory = false, onSaved, onToast }: PostGameFeedbackProps) {
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>(() => Object.fromEntries(
    members.filter((member) => member.id !== currentUserId).map((member) => [member.id, ""]),
  ));
  const [matchQuality, setMatchQuality] = useState("5");
  const [saving, setSaving] = useState(false);

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
          ratings: otherPlayers.map((member) => ({ player_id: member.id, rating_10: Number(playerRatings[member.id]) })),
        }),
      });
      if (!response.ok) throw new Error("Feedback failed");
      onToast(ratingMode === "competitive" ? "Private feedback saved. The confirmed score decides CMR." : "Private feedback saved. This casual game did not change CMR.");
      onSaved();
    } catch {
      onToast("Could not save your post-game feedback");
    } finally {
      setSaving(false);
    }
  }

  return <form className="workspace-panel feedback-panel feedback-panel-new" onSubmit={submitFeedback}>
    <div className="workspace-panel-heading"><div><span className="kicker">YOUR PRIVATE FEEDBACK</span><h3 id="post-game-feedback-title">Rate every player</h3><p className="feedback-intro">Only you can see the ratings you submit. Rate every other confirmed player to help keep future games fair and trusted. {ratingMode === "competitive" ? "CMR only changes from a confirmed final score." : "This casual game does not change CMR."}</p>{mandatory && <p className="feedback-required-note">Required to finish your post-game feedback.</p>}</div></div>
    <div className="feedback-fields feedback-quality-field"><label><span>Game match quality</span><select aria-label="Rate game match quality" value={matchQuality} onChange={(event) => setMatchQuality(event.target.value)}>{Array.from({ length: 5 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} / 5{value === 5 ? " · Excellent" : value === 1 ? " · Poor" : ""}</option>)}</select></label></div>
    <fieldset className="player-rating-fields"><legend>Rate every other player</legend><div className="player-rating-list">{members.filter((member) => member.id !== currentUserId).map((member) => <label className="player-rating-row" key={member.id}><span><strong>{member.display_name}</strong><small>{member.cmr_ratings?.[sport] != null ? `${member.cmr_ratings[sport].toFixed(1)} CMR` : "CMR building"}</small></span><select required aria-label={`Rate playing with ${member.display_name} out of 10`} value={playerRatings[member.id] ?? ""} onChange={(event) => setPlayerRatings((ratings) => ({ ...ratings, [member.id]: event.target.value }))}><option value="" disabled>Experience /10</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} / 10</option>)}</select></label>)}</div></fieldset>
    <button className="dark-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save feedback"} <span>→</span></button>
  </form>;
}
