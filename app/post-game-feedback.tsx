"use client";

import { FormEvent, useEffect, useState } from "react";

type SkillLevel = "beginner" | "intermediate" | "advanced";
type TeamId = "one" | "two" | "";

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
  const [teamAssignments, setTeamAssignments] = useState<Record<string, TeamId>>({});
  const [teamOneScore, setTeamOneScore] = useState("");
  const [teamTwoScore, setTeamTwoScore] = useState("");
  const [proofLoading, setProofLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPlayerLevels({});
    setTeamAssignments(Object.fromEntries(members.map((member, index) => [member.id, index % 2 === 0 ? "one" : "two"])) as Record<string, TeamId>);
    setTeamOneScore("");
    setTeamTwoScore("");
  }, [sessionId, members]);

  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    const ratings = Object.entries(playerLevels)
      .filter(([playerId, level]) => playerId !== currentUserId && level)
      .map(([player_id, skill_level]) => ({ player_id, skill_level }));
    const teams = ([
      { name: "Team 1", teamId: "one" as const, score: teamOneScore },
      { name: "Team 2", teamId: "two" as const, score: teamTwoScore },
    ]).map((team) => ({
      name: team.name,
      player_ids: members.filter((member) => teamAssignments[member.id] === team.teamId).map((member) => member.id),
      score: team.score === "" ? null : Number(team.score),
    })).filter((team) => team.player_ids.length);
    const scoreEntered = teamOneScore !== "" || teamTwoScore !== "";
    if (teams.length === 1 || (scoreEntered && (teams.length !== 2 || teamOneScore === "" || teamTwoScore === ""))) {
      onToast("Add players to both teams and enter both scores");
      return;
    }
    try {
      setSaving(true);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fun: Number(feedbackFun), fairness: Number(feedbackFairness), would_return: feedbackWouldReturn, ratings, teams }),
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
    <fieldset className="match-result-fields"><legend>Match result</legend>{members.map((member) => <label key={member.id}><span>{member.display_name}</span><select value={teamAssignments[member.id] ?? ""} onChange={(event) => setTeamAssignments({ ...teamAssignments, [member.id]: event.target.value as TeamId })}><option value="">Not assigned</option><option value="one">Team 1</option><option value="two">Team 2</option></select></label>)}<div className="team-score-fields"><label><span>Team 1 score</span><input type="number" min="0" max="999" value={teamOneScore} onChange={(event) => setTeamOneScore(event.target.value)} placeholder="0" /></label><label><span>Team 2 score</span><input type="number" min="0" max="999" value={teamTwoScore} onChange={(event) => setTeamTwoScore(event.target.value)} placeholder="0" /></label></div></fieldset>
    <div className="activity-proof-upload"><div><strong>Activity</strong></div><label className="proof-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp" disabled={proofLoading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachActivityProof(file); event.currentTarget.value = ""; }} />{proofLoading ? "Reading..." : "+ Add stats"}</label></div>
    {activityProofs.length > 0 && <div className="activity-proof-list">{activityProofs.map((proof) => <article className="activity-proof-card" key={proof.id}><img src={proof.image_url} alt="Uploaded activity tracker" /><div><strong>{members.find((member) => member.id === proof.player_id)?.display_name ?? "Player"}</strong><p>{proof.analysis.summary}</p><div className="activity-proof-stats">{proof.analysis.calories_burned != null && <b>{Math.round(proof.analysis.calories_burned)} <small>kcal</small></b>}{proof.analysis.duration_minutes != null && <b>{Math.round(proof.analysis.duration_minutes)} <small>min</small></b>}{proof.analysis.distance_km != null && <b>{proof.analysis.distance_km.toFixed(1)} <small>km</small></b>}{proof.analysis.steps != null && <b>{proof.analysis.steps.toLocaleString()} <small>steps</small></b>}</div></div></article>)}</div>}
    <button className="dark-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save check-in"} <span>→</span></button>
  </form>;
}
