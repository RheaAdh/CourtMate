"use client";

import { FormEvent, useEffect, useState } from "react";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type TournamentStatus = "registration" | "in_progress" | "completed" | "cancelled";
type TournamentView = "upcoming" | "pending" | "history";

type Tournament = {
  id: string;
  name: string;
  sport: Sport;
  organizer_id: string;
  area: string;
  venue_name?: string | null;
  tournament_date: string;
  format: "round_robin";
  capacity: number;
  status: TournamentStatus;
  registration_ids: string[];
  my_registration_status?: TournamentRegistration["status"] | null;
  rules: { score_label: string; point_target: number; win_by: number; best_of: number };
  created_at: string;
};

type TournamentRegistration = {
  id: string;
  tournament_id: string;
  player_id: string;
  display_name: string;
  status: "pending" | "registered" | "waitlisted" | "declined" | "withdrawn";
  cmr_rating?: number | null;
  created_at: string;
};

type TournamentMatch = {
  id: string;
  tournament_id: string;
  round_number: number;
  match_number: number;
  player_a_id: string;
  player_b_id: string;
  status: "scheduled" | "pending_confirmation" | "completed";
  score_a?: number | null;
  score_b?: number | null;
  winner_id?: string | null;
  score_entered_by?: string | null;
  confirmed_by?: string | null;
};

type TournamentStanding = {
  rank: number;
  player_id: string;
  display_name: string;
  cmr_rating?: number | null;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points_for: number;
  points_against: number;
  table_points: number;
};

type TournamentDetails = {
  tournament: Tournament;
  registrations: TournamentRegistration[];
  matches: TournamentMatch[];
  standings: TournamentStanding[];
};

type FixtureEdit = {
  round: string;
  match: string;
  a: string;
  b: string;
};

type TournamentHubProps = {
  apiUrl: string;
  currentUserId?: string;
  authorizedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onToast: (message: string) => void;
  onSignIn: () => void;
};

const sports: { value: Sport; label: string }[] = [
  { value: "pickleball", label: "Pickleball" },
  { value: "badminton", label: "Badminton" },
  { value: "tennis", label: "Tennis" },
  { value: "padel", label: "Padel" },
  { value: "squash", label: "Squash" },
  { value: "table_tennis", label: "Table tennis" },
];

const today = () => new Date().toISOString().slice(0, 10);
const sportLabel = (sport: Sport) => sports.find((item) => item.value === sport)?.label ?? sport;

export function TournamentHub({ apiUrl, currentUserId, authorizedFetch, onToast, onSignIn }: TournamentHubProps) {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selected, setSelected] = useState<TournamentDetails | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [activeView, setActiveView] = useState<TournamentView>("upcoming");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [name, setName] = useState("");
  const [sport, setSport] = useState<Sport>("pickleball");
  const [area, setArea] = useState("Whitefield");
  const [venue, setVenue] = useState("");
  const [date, setDate] = useState(today());
  const [capacity, setCapacity] = useState("8");
  const [scores, setScores] = useState<Record<string, { a: string; b: string }>>({});
  const [fixtureEdits, setFixtureEdits] = useState<Record<string, FixtureEdit>>({});
  const [updatedMatchId, setUpdatedMatchId] = useState("");
  const [drawNotice, setDrawNotice] = useState("");

  async function loadTournaments() {
    if (!currentUserId) return;
    try {
      setLoading(true);
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments`);
      if (!response.ok) throw new Error("Tournaments unavailable");
      const payload = await response.json() as { tournaments: Tournament[] };
      setTournaments(payload.tournaments);
    } catch {
      onToast("Could not load tournaments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTournaments();
  }, [currentUserId]);

  useEffect(() => {
    const sharedTournamentId = new URLSearchParams(window.location.search).get("tournament");
    if (currentUserId && sharedTournamentId) void openTournament(sharedTournamentId);
  }, [currentUserId]);

  async function openTournament(tournamentId: string) {
    try {
      setBusyId(tournamentId);
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments/${tournamentId}`);
      if (!response.ok) throw new Error("Tournament unavailable");
      setSelected(await response.json() as TournamentDetails);
    } catch {
      onToast("Could not open this tournament");
    } finally {
      setBusyId("");
    }
  }

  async function createTournament(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      setBusyId("create");
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), sport, area: area.trim(), venue_name: venue.trim() || null, tournament_date: date, capacity: Number(capacity), format: "round_robin" }),
      });
      if (!response.ok) throw new Error("Tournament creation failed");
      setSelected(await response.json() as TournamentDetails);
      setShowCreate(false);
      setName("");
      await loadTournaments();
      onToast("Tournament created. You are registered as the first player.");
    } catch {
      onToast("Could not create this tournament");
    } finally {
      setBusyId("");
    }
  }

  async function register() {
    if (!selected) return;
    try {
      setBusyId("register");
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments/${selected.tournament.id}/register`, { method: "POST" });
      if (!response.ok) throw new Error("Registration failed");
      const registration = await response.json() as TournamentRegistration;
      await openTournament(selected.tournament.id);
      onToast(registration.status === "pending" ? "Request sent to the tournament organizer" : registration.status === "waitlisted" ? "You are on the tournament waitlist" : "You are registered for the tournament");
    } catch {
      onToast("Could not register for this tournament");
    } finally {
      setBusyId("");
    }
  }

  async function decideRegistration(registrationId: string, status: "approved" | "declined") {
    if (!selected) return;
    try {
      setBusyId(`registration-${registrationId}`);
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments/${selected.tournament.id}/registrations/${registrationId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Could not review this request");
      }
      await openTournament(selected.tournament.id);
      await loadTournaments();
      onToast(status === "approved" ? "Player approved" : "Request declined");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not review this request");
    } finally {
      setBusyId("");
    }
  }

  async function shareTournament() {
    if (!selected) return;
    const shareUrl = new URL(window.location.href);
    shareUrl.search = "";
    shareUrl.searchParams.set("tournament", selected.tournament.id);
    const shareData = {
      title: selected.tournament.name,
      text: `${selected.tournament.name} · ${sportLabel(selected.tournament.sport)} · ${selected.tournament.tournament_date}`,
      url: shareUrl.toString(),
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        onToast("Tournament link shared");
        return;
      }
      await navigator.clipboard.writeText(shareUrl.toString());
      onToast("Tournament link copied");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast("Could not share this tournament link");
    }
  }

  async function generateFixtures() {
    if (!selected) return;
    try {
      setBusyId("fixtures");
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments/${selected.tournament.id}/fixtures`, { method: "POST" });
      if (!response.ok) throw new Error("Fixture generation failed");
      setSelected(await response.json() as TournamentDetails);
      await loadTournaments();
      onToast("Fixtures generated from the registered players");
    } catch {
      onToast("Add at least two players before generating fixtures");
    } finally {
      setBusyId("");
    }
  }

  function startFixtureEdit(match: TournamentMatch) {
    setFixtureEdits((current) => ({
      ...current,
      [match.id]: {
        round: String(match.round_number),
        match: String(match.match_number),
        a: match.player_a_id,
        b: match.player_b_id,
      },
    }));
  }

  function cancelFixtureEdit(matchId: string) {
    const nextEdits = { ...fixtureEdits };
    delete nextEdits[matchId];
    setFixtureEdits(nextEdits);
  }

  async function saveFixture(match: TournamentMatch) {
    if (!selected) return;
    const edit = fixtureEdits[match.id];
    if (!edit) return;
    try {
      setBusyId(`fixture-${match.id}`);
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments/${selected.tournament.id}/matches/${match.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ round_number: Number(edit.round), match_number: Number(edit.match), player_a_id: edit.a, player_b_id: edit.b }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Fixture update failed");
      }
      await openTournament(selected.tournament.id);
      cancelFixtureEdit(match.id);
      setUpdatedMatchId(match.id);
      setDrawNotice("Fixture updated. The draw sheet is refreshed.");
      onToast("Fixture updated");
      window.setTimeout(() => setUpdatedMatchId(""), 2200);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not update this fixture");
    } finally {
      setBusyId("");
    }
  }

  async function submitScore(match: TournamentMatch, confirm = false) {
    if (!selected) return;
    const draft = scores[match.id] ?? { a: String(match.score_a ?? ""), b: String(match.score_b ?? "") };
    if (draft.a === "" || draft.b === "") {
      onToast("Enter both sides of the score");
      return;
    }
    try {
      setBusyId(match.id);
      const response = await authorizedFetch(`${apiUrl}/v1/tournaments/${selected.tournament.id}/matches/${match.id}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ score_a: Number(draft.a), score_b: Number(draft.b), confirm }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? "Score submission failed");
      }
      await openTournament(selected.tournament.id);
      setUpdatedMatchId(match.id);
      setDrawNotice(confirm ? "Result confirmed. Draw sheet and leaderboard updated." : "Score saved. Waiting for the opponent to confirm.");
      onToast(confirm ? "Result confirmed and leaderboard updated" : "Score submitted for confirmation");
      window.setTimeout(() => setUpdatedMatchId(""), 2200);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not save this score");
    } finally {
      setBusyId("");
    }
  }

  if (!currentUserId) {
    return (
      <section className="page-view tournament-page">
        <div className="tournament-hero">
          <h1>Tournaments</h1>
          <button className="dark-button" onClick={onSignIn}>Sign in to enter <span>-&gt;</span></button>
        </div>
      </section>
    );
  }

  const registration = selected?.registrations.find((item) => item.player_id === currentUserId);
  const isOrganizer = selected?.tournament.organizer_id === currentUserId;
  const names = new Map(selected?.registrations.map((item) => [item.player_id, item.display_name]));
  const playerName = (id: string) => names.get(id) ?? id.slice(0, 8);
  const registeredPlayers = selected?.registrations.filter((item) => item.status === "registered") ?? [];
  const rounds = Array.from(new Set(selected?.matches.map((match) => match.round_number) ?? [])).sort((a, b) => a - b);
  const matchStatusLabel = (status: TournamentMatch["status"]) => {
    if (status === "pending_confirmation") return "Awaiting confirmation";
    if (status === "completed") return "Final result";
    return "Score not entered";
  };
  const tournamentView = (tournament: Tournament): TournamentView => {
    if (tournament.status === "completed" || tournament.status === "cancelled" || (tournament.status === "registration" && tournament.tournament_date < today())) return "history";
    if (tournament.my_registration_status === "pending" || tournament.my_registration_status === "waitlisted") return "pending";
    return "upcoming";
  };
  const visibleTournaments = tournaments.filter((tournament) => tournamentView(tournament) === activeView);
  const tournamentTabs: { value: TournamentView; label: string }[] = [
    { value: "upcoming", label: "Upcoming" },
    { value: "pending", label: "Pending" },
    { value: "history", label: "History" },
  ];

  return (
    <section className="page-view tournament-page">
      <div className="tournament-hero">
        <div>
          <h1>Tournaments</h1>
        </div>
        <button className="create-game-action" onClick={() => setShowCreate((open) => !open)}>
          {showCreate ? "Close" : "Create tournament"} <span>+</span>
        </button>
      </div>

      {showCreate && (
        <form className="tournament-create-card" onSubmit={createTournament}>
          <div className="tournament-create-heading">
            <div><h2>New tournament</h2></div>
            <span>Round robin</span>
          </div>
          <div className="tournament-form-grid">
            <label><span>Tournament name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Whitefield Rally Cup" required /></label>
            <label><span>Sport</span><select value={sport} onChange={(event) => setSport(event.target.value as Sport)}>{sports.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
            <label><span>Date</span><input type="date" min={today()} value={date} onChange={(event) => setDate(event.target.value)} required /></label>
            <label><span>Players</span><select value={capacity} onChange={(event) => setCapacity(event.target.value)}>{[4, 6, 8, 10, 12, 16].map((value) => <option value={value} key={value}>{value} max</option>)}</select></label>
            <label><span>Locality</span><input value={area} onChange={(event) => setArea(event.target.value)} placeholder="Whitefield" required /></label>
            <label><span>Venue (optional)</span><input value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Community court" /></label>
          </div>
          <button className="dark-button" type="submit" disabled={busyId === "create"}>{busyId === "create" ? "Creating..." : "Create and register"} <span>-&gt;</span></button>
        </form>
      )}

      {selected ? (
        <div className="tournament-detail">
          <div className="tournament-detail-nav"><button className="back-link" onClick={() => setSelected(null)}>&lt;- All tournaments</button><button className="share-tournament-button" onClick={() => void shareTournament()}>Share tournament <span>↑</span></button></div>
          <div className="tournament-detail-header">
            <div>
              <span className="kicker">{sportLabel(selected.tournament.sport).toUpperCase()} · {selected.tournament.status.replace("_", " ").toUpperCase()}</span>
              <h2>{selected.tournament.name}</h2>
              <p>{selected.tournament.tournament_date} · {selected.tournament.area}{selected.tournament.venue_name ? ` · ${selected.tournament.venue_name}` : ""}</p>
            </div>
            <div className="tournament-rule-badge"><strong>{selected.tournament.rules.point_target}</strong><span>{selected.tournament.rules.score_label.toLowerCase()} to win</span></div>
          </div>
          <div className="tournament-stat-row">
            <span><strong>{selected.registrations.filter((item) => item.status === "registered").length}/{selected.tournament.capacity}</strong><small>REGISTERED</small></span>
            <span><strong>{selected.matches.length}</strong><small>MATCHES</small></span>
            <span><strong>{selected.standings.filter((item) => item.played > 0).length}</strong><small>PLAYERS ACTIVE</small></span>
          </div>

          {selected.tournament.status === "registration" && (
            <div className="tournament-action-row">
              {registration && registration.status !== "declined" && registration.status !== "withdrawn" ? <span className={`status-badge ${registration.status}`}>{registration.status === "pending" ? "Request pending" : registration.status}</span> : <button className="dark-button" onClick={() => void register()} disabled={busyId === "register"}>{busyId === "register" ? "Requesting..." : "Request to play"} <span>-&gt;</span></button>}
              {isOrganizer && <button className="manage-group-button" onClick={() => void generateFixtures()} disabled={busyId === "fixtures"}>{busyId === "fixtures" ? "Generating..." : "Generate fixtures"}</button>}
            </div>
          )}

          {isOrganizer && selected.tournament.status === "registration" && selected.registrations.some((item) => item.status === "pending") && (
            <section className="tournament-panel tournament-request-panel">
              <div className="tournament-panel-heading"><div><span className="kicker">ORGANIZER QUEUE</span><h3>Join requests</h3></div><span>{selected.registrations.filter((item) => item.status === "pending").length} waiting</span></div>
              <div className="tournament-request-list">
                {selected.registrations.filter((item) => item.status === "pending").map((item) => (
                  <div className="tournament-request-row" key={item.id}>
                    <div><strong>{item.display_name}</strong><small>{item.cmr_rating ? `${item.cmr_rating.toFixed(1)} CMR` : "CMR building"} · requested to join</small></div>
                    <div className="tournament-request-actions"><button type="button" className="approve-request-button" onClick={() => void decideRegistration(item.id, "approved")} disabled={busyId === `registration-${item.id}`}>{busyId === `registration-${item.id}` ? "..." : "Approve"}</button><button type="button" className="decline-request-button" onClick={() => void decideRegistration(item.id, "declined")} disabled={busyId === `registration-${item.id}`}>Decline</button></div>
                  </div>
                ))}
              </div>
              <p className="tournament-request-help">Approve players into the draw or decline requests before fixtures are generated.</p>
            </section>
          )}

          {selected.matches.length > 0 ? (
            <div className="tournament-layout">
              <section className="tournament-panel">
                <div className="tournament-panel-heading"><div><span className="kicker">THE DRAW</span><h3>Draw sheet</h3></div><span>{selected.tournament.rules.score_label} · win by {selected.tournament.rules.win_by}</span></div>
                <p className="draw-sheet-help">Enter scores directly on a match below. Players submit, then the opponent or organizer confirms.</p>
                {drawNotice && <div className="draw-sheet-notice" role="status">{drawNotice}</div>}
                <div className="fixture-rounds">
                  {rounds.map((round) => (
                    <div className="fixture-round" key={round}>
                      <strong>Round {round}</strong>
                      {selected.matches.filter((match) => match.round_number === round).map((match) => {
                        const canScore = Boolean(isOrganizer) || (match.status !== "completed" && (currentUserId === match.player_a_id || currentUserId === match.player_b_id));
                        const canConfirm = match.status === "pending_confirmation" && currentUserId !== match.score_entered_by && (Boolean(isOrganizer) || currentUserId === match.player_a_id || currentUserId === match.player_b_id);
                        const draft = scores[match.id] ?? { a: String(match.score_a ?? ""), b: String(match.score_b ?? "") };
                        const fixtureEdit = fixtureEdits[match.id];
                        return (
                          <article className={`fixture-card fixture-${match.status}${updatedMatchId === match.id ? " fixture-updated" : ""}`} key={match.id}>
                            <div className="fixture-top"><span>Match {match.match_number}</span><span className="fixture-card-actions"><small>{matchStatusLabel(match.status)}</small>{isOrganizer && !fixtureEdit && <button className="fixture-edit-button" type="button" onClick={() => startFixtureEdit(match)}>Edit fixture</button>}</span></div>
                            <div className="fixture-players"><strong className={match.winner_id === match.player_a_id ? "winner" : ""}>{playerName(match.player_a_id)}</strong><b>{match.score_a ?? "-"}</b><strong className={match.winner_id === match.player_b_id ? "winner" : ""}>{playerName(match.player_b_id)}</strong><b>{match.score_b ?? "-"}</b></div>
                            {fixtureEdit && <div className="fixture-edit-entry">
                              <div className="fixture-edit-fields">
                                <label><span>Round</span><input type="number" min="1" value={fixtureEdit.round} onChange={(event) => setFixtureEdits({ ...fixtureEdits, [match.id]: { ...fixtureEdit, round: event.target.value } })} /></label>
                                <label><span>Match</span><input type="number" min="1" value={fixtureEdit.match} onChange={(event) => setFixtureEdits({ ...fixtureEdits, [match.id]: { ...fixtureEdit, match: event.target.value } })} /></label>
                                <label><span>Player A</span><select value={fixtureEdit.a} onChange={(event) => setFixtureEdits({ ...fixtureEdits, [match.id]: { ...fixtureEdit, a: event.target.value } })}>{registeredPlayers.map((item) => <option value={item.player_id} key={item.player_id}>{item.display_name}</option>)}</select></label>
                                <label><span>Player B</span><select value={fixtureEdit.b} onChange={(event) => setFixtureEdits({ ...fixtureEdits, [match.id]: { ...fixtureEdit, b: event.target.value } })}>{registeredPlayers.map((item) => <option value={item.player_id} key={item.player_id}>{item.display_name}</option>)}</select></label>
                              </div>
                              <div className="fixture-edit-actions"><button className="score-button" type="button" onClick={() => void saveFixture(match)} disabled={busyId === `fixture-${match.id}`}>{busyId === `fixture-${match.id}` ? "Saving..." : "Save fixture"}</button><button className="fixture-swap-button" type="button" onClick={() => setFixtureEdits({ ...fixtureEdits, [match.id]: { ...fixtureEdit, a: fixtureEdit.b, b: fixtureEdit.a } })}>Swap sides</button><button className="fixture-cancel-button" type="button" onClick={() => cancelFixtureEdit(match.id)}>Cancel</button></div>
                            </div>}
                            {canScore && !fixtureEdit && <div className="fixture-score-entry"><span className="fixture-score-label">{match.status === "completed" ? "Edit final" : "Enter score"}</span><input type="number" min="0" value={draft.a} onChange={(event) => setScores({ ...scores, [match.id]: { ...draft, a: event.target.value } })} placeholder="0" aria-label={`${playerName(match.player_a_id)} score`} /><span>:</span><input type="number" min="0" value={draft.b} onChange={(event) => setScores({ ...scores, [match.id]: { ...draft, b: event.target.value } })} placeholder="0" aria-label={`${playerName(match.player_b_id)} score`} /><button className="score-button" onClick={() => void submitScore(match, canConfirm)} disabled={busyId === match.id}>{match.status === "completed" ? "Update" : canConfirm ? "Confirm" : "Save"}</button></div>}
                            {match.status === "pending_confirmation" && !canConfirm && <p className="fixture-note">Waiting for the opponent to confirm this score.</p>}
                          </article>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </section>
              <aside className="tournament-panel standings-panel">
                <div className="tournament-panel-heading"><div><span className="kicker">LIVE TABLE</span><h3>Leaderboard</h3></div><span>3 points per win</span></div>
                <div className="standings-table">
                  <div className="standing-header"><span>#</span><span>Player</span><span>W-L</span><span>Pts</span></div>
                  {selected.standings.map((standing) => <div className="standing-row" key={standing.player_id}><span>{standing.rank}</span><strong>{standing.display_name}</strong><span>{standing.wins}-{standing.losses}</span><b>{standing.table_points}</b></div>)}
                </div>
              </aside>
            </div>
          ) : (
            <div className="tournament-waiting"><span className="tournament-waiting-icon">+</span><div><strong>Draw sheet opens after fixtures are generated.</strong><p>Once registration closes, the organizer can generate rounds and score each match here.</p></div></div>
          )}
        </div>
      ) : (
        <div className="tournament-list">
          <div className="tournament-tabs" role="tablist" aria-label="Tournament views">
            {tournamentTabs.map((tab) => <button type="button" role="tab" aria-selected={activeView === tab.value} className={activeView === tab.value ? "active" : ""} onClick={() => setActiveView(tab.value)} key={tab.value}>{tab.label}<span>{tournaments.filter((tournament) => tournamentView(tournament) === tab.value).length}</span></button>)}
          </div>
          <div className="tournament-list-heading"><div><h2>{activeView === "upcoming" ? "Upcoming tournaments" : activeView === "pending" ? "Pending registrations" : "Tournament history"}</h2></div><span>{loading ? "Loading..." : `${visibleTournaments.length} event${visibleTournaments.length === 1 ? "" : "s"}`}</span></div>
          {visibleTournaments.length ? visibleTournaments.map((tournament) => (
            <button className="tournament-card" key={tournament.id} onClick={() => void openTournament(tournament.id)} disabled={busyId === tournament.id}>
              <span className="tournament-card-date"><strong>{new Date(`${tournament.tournament_date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit" })}</strong><small>{new Date(`${tournament.tournament_date}T00:00:00`).toLocaleDateString("en-IN", { month: "short" })}</small></span>
              <span className="tournament-card-copy"><strong>{tournament.name}</strong><small>{sportLabel(tournament.sport)} · {tournament.area} · {tournament.my_registration_status === "pending" ? "request pending" : tournament.my_registration_status === "waitlisted" ? "waitlisted" : tournament.status.replace("_", " ")}</small></span>
              <span className="tournament-card-meta"><strong>{tournament.registration_ids.length}/{tournament.capacity}</strong><small>players</small></span>
              <span className="tournament-card-arrow">-&gt;</span>
            </button>
          )) : (
            <div className="tournament-waiting"><span className="tournament-waiting-icon">+</span><div><strong>{activeView === "pending" ? "No pending registrations." : activeView === "history" ? "No tournament history yet." : "No upcoming tournaments."}</strong><p>{activeView === "pending" ? "Requests awaiting organizer approval and waitlisted events will appear here." : activeView === "history" ? "Completed events and results will stay here." : "Create a local tournament or check back for open events."}</p></div></div>
          )}
        </div>
      )}
    </section>
  );
}
