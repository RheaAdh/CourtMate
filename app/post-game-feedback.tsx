"use client";

import { FormEvent, useEffect, useState } from "react";

type SkillLevel = "beginner" | "intermediate" | "advanced";
type TeamId = "one" | "two" | "";

type FeedbackMember = {
  id: string;
  display_name: string;
};

type PostGameFeedbackProps = {
  sessionId: string;
  members: FeedbackMember[];
  currentUserId?: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onSaved: () => void;
  onToast: (message: string) => void;
};

const levelOptions: { value: SkillLevel; label: string }[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

export function PostGameFeedbackPanel({ sessionId, members, currentUserId, authorizedFetch, onSaved, onToast }: PostGameFeedbackProps) {
  const [feedbackFun, setFeedbackFun] = useState("5");
  const [feedbackFairness, setFeedbackFairness] = useState("5");
  const [feedbackWouldReturn, setFeedbackWouldReturn] = useState(true);
  const [playerLevels, setPlayerLevels] = useState<Record<string, SkillLevel | "">>({});
  const [teamAssignments, setTeamAssignments] = useState<Record<string, TeamId>>({});
  const [teamOneScore, setTeamOneScore] = useState("");
  const [teamTwoScore, setTeamTwoScore] = useState("");
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
      const response = await authorizedFetch(`/v1/sessions/${sessionId}/feedback`, {
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

  return <form className="workspace-panel feedback-panel feedback-panel-new" onSubmit={submitFeedback}>
    <div className="workspace-panel-heading"><div><span className="kicker">POST-GAME FEEDBACK</span><h3>Was this a fun, fair group?</h3></div></div>
    <div className="feedback-fields"><label><span>Fun</span><select value={feedbackFun} onChange={(event) => setFeedbackFun(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label><label><span>Fairness</span><select value={feedbackFairness} onChange={(event) => setFeedbackFairness(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></label></div>
    <label className="return-check"><input type="checkbox" checked={feedbackWouldReturn} onChange={(event) => setFeedbackWouldReturn(event.target.checked)} /><span>Would you play with this group again?</span></label>
    <fieldset className="player-rating-fields"><legend>How did the other players feel?</legend>{members.filter((member) => member.id !== currentUserId).map((member) => <label key={member.id}><span>{member.display_name}</span><select value={playerLevels[member.id] ?? ""} onChange={(event) => setPlayerLevels({ ...playerLevels, [member.id]: event.target.value as SkillLevel | "" })}><option value="">Skip</option>{levelOptions.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}</select></label>)}</fieldset>
    <fieldset className="match-result-fields"><legend>Optional match result</legend><p>Record who played together. This helps CourtMate understand the game context without asking for a personal number rating.</p>{members.map((member) => <label key={member.id}><span>{member.display_name}</span><select value={teamAssignments[member.id] ?? ""} onChange={(event) => setTeamAssignments({ ...teamAssignments, [member.id]: event.target.value as TeamId })}><option value="">Not assigned</option><option value="one">Team 1</option><option value="two">Team 2</option></select></label>)}<div className="team-score-fields"><label><span>Team 1 score</span><input type="number" min="0" max="999" value={teamOneScore} onChange={(event) => setTeamOneScore(event.target.value)} placeholder="0" /></label><label><span>Team 2 score</span><input type="number" min="0" max="999" value={teamTwoScore} onChange={(event) => setTeamTwoScore(event.target.value)} placeholder="0" /></label></div></fieldset>
    <button className="dark-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save feedback"} <span>→</span></button>
  </form>;
}
