"use client";

import { FormEvent, useEffect, useState } from "react";
import { TennisBallLoader } from "./tennis-ball-loader";

type FeedbackMember = {
  id: string;
  display_name: string;
  cmr_ratings?: Record<string, number>;
  sport_ratings?: Record<string, number>;
  dupr_rating?: number | null;
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
  sport: string;
  members: FeedbackMember[];
  currentUserId?: string;
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  activityProofs?: ActivityProof[];
  onAnalyzeActivityProof: (file: File) => Promise<ActivityProof | null>;
  onSaved: () => void;
  onToast: (message: string) => void;
};

function sportRating(member: FeedbackMember, sport: string) {
  const cmr = member.cmr_ratings?.[sport];
  if (cmr != null) return cmr;
  const rating = member.sport_ratings?.[sport] ?? (sport === "pickleball" ? member.dupr_rating : null);
  return rating == null ? -1 : rating * 12.5;
}

export function PostGameFeedbackPanel({ sessionId, sport, members, currentUserId, apiUrl, authorizedFetch, activityProofs = [], onAnalyzeActivityProof, onSaved, onToast }: PostGameFeedbackProps) {
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerOrder, setPlayerOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPlayerOrder(
      members
        .filter((member) => member.id !== currentUserId)
        .sort((a, b) => sportRating(b, sport) - sportRating(a, sport) || a.display_name.localeCompare(b.display_name))
        .map((member) => member.id),
    );
  }, [sessionId, members, currentUserId, sport]);

  function movePlayer(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setPlayerOrder((order) => {
      const next = [...order];
      const sourceIndex = next.indexOf(sourceId);
      const targetIndex = next.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return order;
      next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, sourceId);
      return next;
    });
  }

  function moveByKeyboard(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= playerOrder.length) return;
    setPlayerOrder((order) => {
      const next = [...order];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    try {
      setSaving(true);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fun: Number(feedbackFun), fairness: Number(feedbackFairness), would_return: feedbackWouldReturn, player_order: playerOrder }),
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
    <div className="workspace-panel-heading"><div><span className="kicker">AFTER THE GAME</span><h3>How did everyone play?</h3><p className="feedback-intro">Players start in sport CMR order. Drag them into the order that felt right today.</p></div></div>
    <div className="feedback-fields"><label><span>Fun</span><select value={feedbackFun} onChange={(event) => setFeedbackFun(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label><label><span>Fairness</span><select value={feedbackFairness} onChange={(event) => setFeedbackFairness(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label></div>
    <label className="return-check"><input type="checkbox" checked={feedbackWouldReturn} onChange={(event) => setFeedbackWouldReturn(event.target.checked)} /><span>Would you play with this group again?</span></label>
    <fieldset className="player-order-fields"><legend>Today&apos;s order</legend><p className="player-order-hint">1 is strongest today. This updates sport CMR without entering scores.</p><div className="player-order-list">{playerOrder.map((playerId, index) => { const member = members.find((candidate) => candidate.id === playerId); if (!member) return null; return <div className={`player-order-row ${draggingId === playerId ? "dragging" : ""}`} key={playerId} draggable onDragStart={() => setDraggingId(playerId)} onDragEnd={() => setDraggingId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggingId) movePlayer(draggingId, playerId); setDraggingId(null); }}><span className="player-order-rank">{index + 1}</span><span className="player-order-grip" aria-hidden="true">⋮⋮</span><div className="player-order-copy"><strong>{member.display_name}</strong><small>{member.cmr_ratings?.[sport] != null ? `${member.cmr_ratings[sport].toFixed(1)} CMR` : "CMR building"}</small></div><div className="player-order-actions"><button type="button" onClick={() => moveByKeyboard(index, -1)} disabled={index === 0} aria-label={`Move ${member.display_name} up`}>↑</button><button type="button" onClick={() => moveByKeyboard(index, 1)} disabled={index === playerOrder.length - 1} aria-label={`Move ${member.display_name} down`}>↓</button></div></div>; })}</div></fieldset>
    <div className="activity-proof-upload"><div><strong>Activity</strong></div><label className="proof-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp" disabled={proofLoading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachActivityProof(file); event.currentTarget.value = ""; }} />{proofLoading ? <TennisBallLoader compact label="Reading stats" /> : "+ Add stats"}</label></div>
    {activityProofs.length > 0 && <div className="activity-proof-list">{activityProofs.map((proof) => <article className="activity-proof-card" key={proof.id}><img src={proof.image_url} alt="Uploaded activity tracker" /><div><strong>{members.find((member) => member.id === proof.player_id)?.display_name ?? "Player"}</strong><p>{proof.analysis.summary}</p><div className="activity-proof-stats">{proof.analysis.calories_burned != null && <b>{Math.round(proof.analysis.calories_burned)} <small>kcal</small></b>}{proof.analysis.duration_minutes != null && <b>{Math.round(proof.analysis.duration_minutes)} <small>min</small></b>}{proof.analysis.distance_km != null && <b>{proof.analysis.distance_km.toFixed(1)} <small>km</small></b>}{proof.analysis.steps != null && <b>{proof.analysis.steps.toLocaleString()} <small>steps</small></b>}</div></div></article>)}</div>}
    <button className="dark-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save check-in"} <span>→</span></button>
  </form>;
}
