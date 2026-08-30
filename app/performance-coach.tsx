"use client";

import { FormEvent, useState } from "react";
import { TennisBallLoader } from "./tennis-ball-loader";

type ActivityProof = {
  id: string;
  sport: string;
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
  created_at: string;
};

type PerformanceCoachProps = {
  sport: string;
  sportLabel: string;
  proofs: ActivityProof[];
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onUpload: (file: File, sport: string) => Promise<ActivityProof | null>;
  onToast: (message: string) => void;
};

type CoachMessage = { id: string; role: "user" | "assistant"; text: string };

function metricLine(proof: ActivityProof) {
  const metrics = [
    proof.analysis.calories_burned != null ? `${Math.round(proof.analysis.calories_burned)} kcal` : null,
    proof.analysis.duration_minutes != null ? `${Math.round(proof.analysis.duration_minutes)} min` : null,
    proof.analysis.distance_km != null ? `${proof.analysis.distance_km.toFixed(1)} km` : null,
    proof.analysis.average_heart_rate != null ? `${proof.analysis.average_heart_rate} bpm` : null,
  ].filter(Boolean);
  return metrics.join(" · ") || "Metrics extracted from screenshot";
}

export function PerformanceCoach({ sport, sportLabel, proofs, apiUrl, authorizedFetch, onUpload, onToast }: PerformanceCoachProps) {
  const [messages, setMessages] = useState<CoachMessage[]>([
    { id: "performance-welcome", role: "assistant", text: "Ask me about your CMR trend, recent games, consistency, or wearable stats." },
  ]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const query = draft.trim();
    if (!query || loading) return;
    setDraft("");
    setMessages((current) => [...current, { id: `${Date.now()}-user`, role: "user", text: query }]);
    try {
      setLoading(true);
      const response = await authorizedFetch(`${apiUrl}/v1/me/performance-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const payload = await response.json().catch(() => ({})) as { answer?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Performance coach is unavailable");
      setMessages((current) => [...current, { id: `${Date.now()}-assistant`, role: "assistant", text: payload.answer ?? "I could not read that performance question." }]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Performance coach is unavailable");
    } finally {
      setLoading(false);
    }
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      setUploading(true);
      await onUpload(file, sport);
    } finally {
      setUploading(false);
    }
  }

  async function share(proof: ActivityProof) {
    try {
      setSharingId(proof.id);
      const response = await authorizedFetch(`${apiUrl}/v1/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caption: `${sportLabel} check-in: ${metricLine(proof)}. ${proof.analysis.summary}`,
          sport: proof.sport,
          media_url: proof.image_url,
          media_type: "image",
        }),
      });
      if (!response.ok) throw new Error("Could not share this check-in");
      onToast("Wearable check-in shared to Social");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not share this check-in");
    } finally {
      setSharingId(null);
    }
  }

  return <section className="performance-coach" aria-label="Performance coach">
    <div className="performance-coach-heading"><div><span className="kicker">YOUR PERFORMANCE</span><h2>Talk through your game</h2><p>Your CMR history and wearable check-ins, in one place.</p></div><span className="performance-sport-chip">{sportLabel}</span></div>
    <div className="performance-coach-grid">
      <div className="performance-chat-card"><div className="performance-chat-feed" aria-live="polite">{messages.map((message) => <div className={`performance-message ${message.role}`} key={message.id}><span>{message.role === "assistant" ? "CM" : "You"}</span><p>{message.text}</p></div>)}{loading && <div className="performance-message assistant"><span>CM</span><TennisBallLoader compact label="Reading your history" /></div>}</div><form className="performance-chat-form" onSubmit={ask}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="How is my form trending?" aria-label="Ask about performance" /><button type="submit" disabled={!draft.trim() || loading} aria-label="Ask performance coach">↗</button></form></div>
      <div className="performance-proof-card"><div className="performance-proof-heading"><div><strong>Wearable check-in</strong><small>Gemini reads visible stats only.</small></div><label className="performance-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void upload(event)} disabled={uploading} />{uploading ? <TennisBallLoader compact label="Reading screenshot" /> : "+ Add screenshot"}</label></div>{proofs.length ? <div className="performance-proof-list">{proofs.slice(0, 3).map((proof) => <article className="performance-proof-row" key={proof.id}><img src={proof.image_url} alt="Wearable check-in" /><div><strong>{proof.sport.replaceAll("_", " ")}</strong><p>{metricLine(proof)}</p><small>{proof.analysis.summary}</small><button type="button" onClick={() => void share(proof)} disabled={sharingId === proof.id}>{sharingId === proof.id ? "Sharing..." : "Share to Social"}</button></div></article>)}</div> : <p className="performance-proof-empty">Add a watch screenshot after a game to keep an evidence-backed activity log.</p>}</div>
    </div>
  </section>;
}
