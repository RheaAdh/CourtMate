"use client";

import { FormEvent, useEffect, useState } from "react";

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
  members: FeedbackMember[];
  currentUserId?: string;
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onSaved: () => void;
  onToast: (message: string) => void;
};

export function PostGameFeedbackPanel({ sessionId, sport, members, currentUserId, apiUrl, authorizedFetch, onSaved, onToast }: PostGameFeedbackProps) {
  const [playerRatings, setPlayerRatings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPlayerRatings(Object.fromEntries(members.filter((member) => member.id !== currentUserId).map((member) => [member.id, ""])));
  }, [sessionId, members, currentUserId, sport]);

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
          // CMR is driven by private player ratings; retain neutral session metadata for the API.
          fun: 5,
          fairness: 5,
          would_return: true,
          ratings: otherPlayers.map((member) => ({ player_id: member.id, rating_10: Number(playerRatings[member.id]) })),
        }),
      });
      if (!response.ok) throw new Error("Feedback failed");
      onToast("Private ratings saved. CMR is updating.");
      onSaved();
    } catch {
      onToast("Could not save your post-game feedback");
    } finally {
      setSaving(false);
    }
  }

  return <form className="workspace-panel feedback-panel feedback-panel-new" onSubmit={submitFeedback}>
    <div className="workspace-panel-heading"><div><span className="kicker">POST-MATCH</span><h3>Rate players</h3><p className="feedback-intro">Private 1-10 ratings help calibrate CMR.</p></div></div>
    <fieldset className="player-rating-fields"><legend>Your private ratings</legend><div className="player-rating-list">{members.filter((member) => member.id !== currentUserId).map((member) => <label className="player-rating-row" key={member.id}><span><strong>{member.display_name}</strong><small>{member.cmr_ratings?.[sport] != null ? `${member.cmr_ratings[sport].toFixed(1)} CMR` : "CMR building"}</small></span><select required aria-label={`Rate ${member.display_name} out of 10`} value={playerRatings[member.id] ?? ""} onChange={(event) => setPlayerRatings((ratings) => ({ ...ratings, [member.id]: event.target.value }))}><option value="" disabled>Rate /10</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} / 10</option>)}</select></label>)}</div></fieldset>
    <button className="dark-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save ratings"} <span>→</span></button>
  </form>;
}
