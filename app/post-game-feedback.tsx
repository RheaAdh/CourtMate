"use client";

import { FormEvent, useEffect, useState } from "react";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { storage } from "../firebase";

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
  const [matchQuality, setMatchQuality] = useState("5");
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPlayerRatings(Object.fromEntries(members.filter((member) => member.id !== currentUserId).map((member) => [member.id, ""])));
  }, [sessionId, members, currentUserId, sport]);

  async function addPhoto(file: File) {
    if (!storage) {
      onToast("Photo uploads need Firebase Storage to be configured");
      return;
    }
    if (!file.type.startsWith("image/") || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      onToast("Choose a JPG, PNG, or WebP photo");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      onToast("Each photo must be smaller than 8 MB");
      return;
    }
    if (photoUrls.length >= 6) {
      onToast("You can add up to 6 photos to this game");
      return;
    }
    try {
      setPhotoUploading(true);
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const imageRef = ref(storage, `session-photos/${currentUserId}/${sessionId}/${crypto.randomUUID()}.${extension}`);
      const upload = await uploadBytes(imageRef, file, { contentType: file.type });
      const photoUrl = await getDownloadURL(upload.ref);
      setPhotoUrls((urls) => [...urls, photoUrl]);
    } catch {
      onToast("Could not upload that photo");
    } finally {
      setPhotoUploading(false);
    }
  }

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
          photo_urls: photoUrls,
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
    <div className="workspace-panel-heading"><div><span className="kicker">POST-MATCH</span><h3>How was the game?</h3><p className="feedback-intro">Your private ratings help calibrate CMR.</p></div></div>
    <div className="feedback-fields feedback-quality-field"><label><span>Game match quality</span><select aria-label="Rate game match quality" value={matchQuality} onChange={(event) => setMatchQuality(event.target.value)}>{Array.from({ length: 5 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} / 5{value === 5 ? " · Excellent" : value === 1 ? " · Poor" : ""}</option>)}</select></label></div>
    <fieldset className="player-rating-fields"><legend>Your private ratings</legend><div className="player-rating-list">{members.filter((member) => member.id !== currentUserId).map((member) => <label className="player-rating-row" key={member.id}><span><strong>{member.display_name}</strong><small>{member.cmr_ratings?.[sport] != null ? `${member.cmr_ratings[sport].toFixed(1)} CMR` : "CMR building"}</small></span><select required aria-label={`Rate ${member.display_name} out of 10`} value={playerRatings[member.id] ?? ""} onChange={(event) => setPlayerRatings((ratings) => ({ ...ratings, [member.id]: event.target.value }))}><option value="" disabled>Rate /10</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} / 10</option>)}</select></label>)}</div></fieldset>
    <button className="dark-button" type="submit" disabled={saving || photoUploading}>{saving ? "Saving..." : "Save feedback"} <span>→</span></button>
    <div className="feedback-photo-row">
      <div><strong>Add game photos</strong><small>They appear with the final leaderboard on Home.</small></div>
      <label className="feedback-photo-button"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void addPhoto(file); }} disabled={photoUploading || photoUrls.length >= 6} />{photoUploading ? "Uploading..." : `+ Add photo${photoUrls.length ? ` (${photoUrls.length}/6)` : ""}`}</label>
      {photoUrls.length > 0 && <div className="feedback-photo-previews">{photoUrls.map((url, index) => <button type="button" key={url} onClick={() => setPhotoUrls((urls) => urls.filter((_, photoIndex) => photoIndex !== index))} aria-label={`Remove photo ${index + 1}`}><img src={url} alt={`Game photo ${index + 1}`} /><span>×</span></button>)}</div>}
    </div>
  </form>;
}
