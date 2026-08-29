"use client";

import { FormEvent, useEffect, useState } from "react";

type TeamId = "one" | "two" | "";

type MatchMember = {
  id: string;
  display_name: string;
};

type MatchResultComposerProps = {
  sessionId: string;
  members: MatchMember[];
  apiUrl: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onSaved: () => void;
  onToast: (message: string) => void;
};

export function MatchResultComposer({ sessionId, members, apiUrl, authorizedFetch, onSaved, onToast }: MatchResultComposerProps) {
  const [assignments, setAssignments] = useState<Record<string, TeamId>>({});
  const [scoreOne, setScoreOne] = useState("");
  const [scoreTwo, setScoreTwo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAssignments(Object.fromEntries(members.map((member, index) => [member.id, index < 2 ? "one" : index < 4 ? "two" : ""])) as Record<string, TeamId>);
    setScoreOne("");
    setScoreTwo("");
  }, [sessionId, members]);

  async function saveResult(event: FormEvent) {
    event.preventDefault();
    const teams = [
      { name: "Pair A", player_ids: members.filter((member) => assignments[member.id] === "one").map((member) => member.id), score: Number(scoreOne) },
      { name: "Pair B", player_ids: members.filter((member) => assignments[member.id] === "two").map((member) => member.id), score: Number(scoreTwo) },
    ];
    if (!teams[0].player_ids.length || !teams[1].player_ids.length || teams[0].player_ids.length > 2 || teams[1].player_ids.length > 2) {
      onToast("Choose one or two players for each pair");
      return;
    }
    if (scoreOne === "" || scoreTwo === "") {
      onToast("Enter both scores to log the result");
      return;
    }
    try {
      setSaving(true);
      const response = await authorizedFetch(`${apiUrl}/v1/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ post_type: "match_result", teams }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Match result could not be saved");
      }
      onToast("Result posted. CMR will use this relative score.");
      onSaved();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not save the match result");
    } finally {
      setSaving(false);
    }
  }

  return <form className="match-result-composer" onSubmit={saveResult}>
    <div className="match-result-heading"><div><strong>Log a match</strong><small>Post the pairs and score into group chat.</small></div><span>CMR</span></div>
    <div className="match-player-grid">{members.map((member) => <label key={member.id}><span>{member.display_name}</span><select value={assignments[member.id] ?? ""} onChange={(event) => setAssignments({ ...assignments, [member.id]: event.target.value as TeamId })}><option value="">Not playing</option><option value="one">Pair A</option><option value="two">Pair B</option></select></label>)}</div>
    <div className="match-score-row"><label><span>Pair A</span><input type="number" min="0" max="999" value={scoreOne} onChange={(event) => setScoreOne(event.target.value)} placeholder="11" /></label><b>–</b><label><span>Pair B</span><input type="number" min="0" max="999" value={scoreTwo} onChange={(event) => setScoreTwo(event.target.value)} placeholder="8" /></label><button className="match-result-submit" type="submit" disabled={saving}>{saving ? "..." : "Post result"}</button></div>
  </form>;
}
