"use client";

import { FormEvent, useEffect, useState } from "react";
import { TennisBallLoader } from "./tennis-ball-loader";

type SkillLevel = "beginner" | "intermediate" | "advanced";

type FeedbackMember = {
  id: string;
  display_name: string;
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

type PostGameFeedbackProps = {
  sessionId: string;
  members: FeedbackMember[];
  currentUserId?: string;
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  activityProofs?: ActivityProof[];
  onAnalyzeActivityProof: (file: File) => Promise<ActivityProof | null>;
  onSaved: () => void;
  onToast: (message: string) => void;
};

const levelOptions: { value: SkillLevel; label: string }[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

export function PostGameFeedbackPanel({ sessionId, members, currentUserId, apiUrl, authorizedFetch, activityProofs = [], onAnalyzeActivityProof, onSaved, onToast }: PostGameFeedbackProps) {
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerLevels, setPlayerLevels] = useState<Record<string, SkillLevel | "">>({});
  const [proofLoading, setProofLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPlayerLevels({});
  }, [sessionId, members]);

  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    const ratings = Object.entries(playerLevels)
      .filter(([playerId, level]) => playerId !== currentUserId && level)
      .map(([player_id, skill_level]) => ({ player_id, skill_level }));
    try {
      setSaving(true);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fun: Number(feedbackFun), fairness: Number(feedbackFairness), would_return: feedbackWouldReturn, ratings }),
      });
      if (!response.ok) throw new Error("Feedback failed");
      onToast("Feedback saved and CMR updated");
      onSaved();
    } catch {
      onToast("Could not save your post-game feedback");
    } finally {
      setSaving(false);
    }
  }

  async function attachActivityProof(file: File) {
    try {
      setProofLoading(true);
      await onAnalyzeActivityProof(file);
    } finally {
      setProofLoading(false);
    }
  }

  return <form className="workspace-panel feedback-panel feedback-panel-new" onSubmit={submitFeedback}>
    <div className="workspace-panel-heading"><div><h3>Game feedback</h3></div></div>
    <div className="feedback-fields"><label><span>Fun</span><select value={feedbackFun} onChange={(event) => setFeedbackFun(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label><label><span>Fairness</span><select value={feedbackFairness} onChange={(event) => setFeedbackFairness(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label></div>
    <label className="return-check"><input type="checkbox" checked={feedbackWouldReturn} onChange={(event) => setFeedbackWouldReturn(event.target.checked)} /><span>Would you play with this group again?</span></label>
    <fieldset className="player-rating-fields"><legend>Player levels</legend>{members.filter((member) => member.id !== currentUserId).map((member) => <label key={member.id}><span>{member.display_name}</span><select value={playerLevels[member.id] ?? ""} onChange={(event) => setPlayerLevels({ ...playerLevels, [member.id]: event.target.value as SkillLevel | "" })}><option value="">Skip</option>{levelOptions.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}</select></label>)}</fieldset>
    <div className="activity-proof-upload"><div><strong>Activity</strong></div><label className="proof-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp" disabled={proofLoading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachActivityProof(file); event.currentTarget.value = ""; }} />{proofLoading ? <TennisBallLoader compact label="Reading stats" /> : "+ Add stats"}</label></div>
    {activityProofs.length > 0 && <div className="activity-proof-list">{activityProofs.map((proof) => <article className="activity-proof-card" key={proof.id}><img src={proof.image_url} alt="Uploaded activity tracker" /><div><strong>{members.find((member) => member.id === proof.player_id)?.display_name ?? "Player"}</strong><p>{proof.analysis.summary}</p><div className="activity-proof-stats">{proof.analysis.calories_burned != null && <b>{Math.round(proof.analysis.calories_burned)} <small>kcal</small></b>}{proof.analysis.duration_minutes != null && <b>{Math.round(proof.analysis.duration_minutes)} <small>min</small></b>}{proof.analysis.distance_km != null && <b>{proof.analysis.distance_km.toFixed(1)} <small>km</small></b>}{proof.analysis.steps != null && <b>{proof.analysis.steps.toLocaleString()} <small>steps</small></b>}</div></div></article>)}</div>}
    <button className="dark-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save check-in"} <span>→</span></button>
  </form>;
}
