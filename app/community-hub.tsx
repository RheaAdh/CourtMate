"use client";

import { PointerEvent, useEffect, useRef, useState } from "react";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type CommunityHubProps = { apiUrl: string; authorizedFetch: (input: string, init?: RequestInit) => Promise<Response>; currentCmr?: number; gamesLogged: number; initialLatitude?: number | null; initialLongitude?: number | null; initialArea?: string };
type DensityPoint = { area: string; player_count: number; intensity: "warm" | "hot" | "very_hot"; latitude?: number | null; longitude?: number | null; cmr_min?: number | null; cmr_max?: number | null; distance_km?: number | null };
type Facility = { id: string; name: string; sport: Sport; area: string; phone?: string | null; booking_method: string; booking_url?: string | null };
type LeaderboardEntry = { rank: number; community_id: string; name: string; sport: Sport; area: string; quality_score: number; completed_games: number; active_players: number; average_match_quality: number; feedback_completion_rate: number; repeat_play_rate: number; average_cmr_improvement: number; average_reliability: number; badge?: "best_quality" | "most_improved" | "most_reliable" | "fastest_growing" | null };

const labels: Record<Sport, string> = { pickleball: "Pickleball", badminton: "Badminton", tennis: "Tennis", padel: "Padel", squash: "Squash", table_tennis: "Table tennis" };
const DEFAULT_CENTER = { latitude: 12.9698, longitude: 77.7499 };
const badgeLabels: Record<NonNullable<LeaderboardEntry["badge"]>, string> = { best_quality: "Best quality", most_improved: "Most improved", most_reliable: "Most reliable", fastest_growing: "Fastest growing" };

export function CommunityHub({ apiUrl, authorizedFetch, currentCmr, gamesLogged, initialLatitude, initialLongitude, initialArea = "Whitefield" }: CommunityHubProps) {
  const [sportFilter, setSportFilter] = useState<Sport>("tennis");
  const [radiusKm, setRadiusKm] = useState(5);
  const [cmrOnly, setCmrOnly] = useState(true);
  const [densityPoints, setDensityPoints] = useState<DensityPoint[]>([]);
  const [densityLoading, setDensityLoading] = useState(false);
  const [densityError, setDensityError] = useState("");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(initialLatitude != null && initialLongitude != null ? { latitude: initialLatitude, longitude: initialLongitude } : null);
  const [locationState, setLocationState] = useState<"saved" | "detecting" | "fallback">(initialLatitude != null && initialLongitude != null ? "saved" : "detecting");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedPoint, setSelectedPoint] = useState<DensityPoint | null>(null);
  const gesture = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    if (initialLatitude != null && initialLongitude != null) return;
    if (!navigator.geolocation) { setLocation(DEFAULT_CENTER); setLocationState("fallback"); return; }
    navigator.geolocation.getCurrentPosition((position) => { setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude }); setLocationState("saved"); }, () => { setLocation(DEFAULT_CENTER); setLocationState("fallback"); }, { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 });
  }, [initialLatitude, initialLongitude]);

  useEffect(() => {
    let cancelled = false;
    setDensityLoading(true); setDensityError("");
    const params = new URLSearchParams({ sport: sportFilter, radius_km: radiusKm.toString() });
    if (location) { params.set("latitude", location.latitude.toString()); params.set("longitude", location.longitude.toString()); }
    if (cmrOnly && currentCmr != null) { params.set("cmr_min", Math.max(0, currentCmr - 20).toString()); params.set("cmr_max", Math.min(100, currentCmr + 20).toString()); }
    void authorizedFetch(`${apiUrl}/v1/me/player-density?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ points: DensityPoint[] }>; }).then((payload) => { if (!cancelled) { setDensityPoints(payload.points); setSelectedPoint(payload.points[0] ?? null); } }).catch(() => { if (!cancelled) setDensityError("Player density is unavailable right now"); }).finally(() => { if (!cancelled) setDensityLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, sportFilter, radiusKm, cmrOnly, currentCmr, location]);

  useEffect(() => {
    let cancelled = false;
    setLeaderboardLoading(true);
    const params = new URLSearchParams({ sport: sportFilter });
    if (initialArea) params.set("area", initialArea);
    void authorizedFetch(`${apiUrl}/v1/me/community-leaderboard?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ entries: LeaderboardEntry[] }>; }).then((payload) => { if (!cancelled) setLeaderboard(payload.entries); }).catch(() => { if (!cancelled) setLeaderboard([]); }).finally(() => { if (!cancelled) setLeaderboardLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, sportFilter, initialArea]);

  useEffect(() => {
    let cancelled = false;
    if (!facilitiesOpen) return () => { cancelled = true; };
    setFacilitiesLoading(true);
    const params = new URLSearchParams({ sport: sportFilter });
    if (initialArea) params.set("area", initialArea);
    void authorizedFetch(`${apiUrl}/v1/me/venues?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ facilities: Facility[] }>; }).then((payload) => { if (!cancelled) setFacilities(payload.facilities); }).catch(() => { if (!cancelled) setFacilities([]); }).finally(() => { if (!cancelled) setFacilitiesLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, sportFilter, initialArea, facilitiesOpen]);

  const center = location ?? DEFAULT_CENTER;
  const project = (point: DensityPoint) => { if (point.latitude == null || point.longitude == null) return { x: 200, y: 130 }; const xKm = (point.longitude - center.longitude) * 111.32 * Math.cos(center.latitude * Math.PI / 180); const yKm = (center.latitude - point.latitude) * 111.32; return { x: 200 + (xKm / radiusKm) * 100, y: 130 + (yKm / radiusKm) * 100 }; };
  const startPan = (event: PointerEvent<SVGSVGElement>) => { gesture.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); };
  const movePan = (event: PointerEvent<SVGSVGElement>) => { if (!gesture.current) return; setPan({ x: gesture.current.panX + (event.clientX - gesture.current.x) / 2, y: gesture.current.panY + (event.clientY - gesture.current.y) / 2 }); };

  return <section className="page-view community-page" aria-labelledby="community-page-title">
    <header className="community-header"><span className="kicker">YOUR PEOPLE, YOUR SPORT</span><h1 id="community-page-title">Find your circle</h1><p>Players like you are showing up nearby. Log every game, improve your CMR, and make your next match better.</p></header>
    <div className="play-log-card"><div><span className="kicker">YOUR PLAY LOG</span><strong>{gamesLogged} game{gamesLogged === 1 ? "" : "s"} logged{currentCmr != null ? ` · ${currentCmr.toFixed(1)} CMR` : ""}</strong><small>Every completed game and private rating makes your next match sharper.</small></div><span className="play-log-mark" aria-hidden="true">↗</span></div>
    <section className="player-density-card" aria-labelledby="player-density-title"><div className="density-heading"><div><span className="kicker">COMMUNITY SIGNAL</span><h2 id="player-density-title">Players like you nearby</h2><p>{densityPoints.length ? `${densityPoints.reduce((total, point) => total + point.player_count, 0)} ${labels[sportFilter].toLowerCase()} players within ${radiusKm} km` : `Find ${labels[sportFilter].toLowerCase()} players within ${radiusKm} km`}</p></div><div className="density-controls"><select value={sportFilter} onChange={(event) => setSportFilter(event.target.value as Sport)} aria-label="Choose sport">{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))} aria-label="Choose search radius"><option value="5">5 km</option><option value="10">10 km</option><option value="20">20 km</option><option value="35">35 km</option><option value="50">50 km</option></select><label className="cmr-filter"><input type="checkbox" checked={cmrOnly && currentCmr != null} disabled={currentCmr == null} onChange={(event) => setCmrOnly(event.target.checked)} /> Near my CMR</label></div></div>
      {densityLoading ? <div className="density-map-loading">Scanning {radiusKm} km around you...</div> : densityPoints.length ? <><div className="density-map-shell"><div className="density-map-toolbar"><span>{locationState === "fallback" ? `Showing around ${initialArea}` : "Your approximate location"}</span><div><button type="button" onClick={() => setZoom((value) => Math.min(2.4, Number((value + .2).toFixed(1))))} aria-label="Zoom in">+</button><button type="button" onClick={() => setZoom((value) => Math.max(.7, Number((value - .2).toFixed(1))))} aria-label="Zoom out">−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset map">Reset</button></div></div><svg className="density-map-svg" viewBox="0 0 400 260" role="img" aria-label={`${labels[sportFilter]} player density within ${radiusKm} kilometres`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.max(.7, Math.min(2.4, Number((value + (event.deltaY < 0 ? .2 : -.2)).toFixed(1))))); }}><g transform={`translate(${pan.x} ${pan.y}) translate(200 130) scale(${zoom}) translate(-200 -130)`}><circle className="density-radius-ring outer" cx="200" cy="130" r="100" /><circle className="density-radius-ring inner" cx="200" cy="130" r="50" /><line className="density-map-crosshair" x1="200" y1="20" x2="200" y2="240" /><line className="density-map-crosshair" x1="90" y1="130" x2="310" y2="130" /><circle className="density-current-location" cx="200" cy="130" r="7" /><circle className="density-current-pulse" cx="200" cy="130" r="13" />{densityPoints.map((point) => { const position = project(point); return <g className={`density-hotspot-svg ${selectedPoint?.area === point.area ? "selected" : ""}`} key={point.area} transform={`translate(${position.x} ${position.y})`} onPointerDown={(event) => event.stopPropagation()} onClick={() => setSelectedPoint(point)} role="button" tabIndex={0} aria-label={`${point.area}, ${point.player_count} players`}><circle className={`density-hotspot-circle ${point.intensity}`} r={point.intensity === "very_hot" ? 27 : point.intensity === "hot" ? 23 : 19} /><text className="density-hotspot-count" y="3">{point.player_count}</text><text className="density-hotspot-area" y="41">{point.area}</text></g>; })}</g><text className="density-radius-label" x="205" y="24">{radiusKm} km radius</text></svg></div>{selectedPoint && <div className="density-detail"><div><strong>{selectedPoint.area}</strong><small>{selectedPoint.player_count} {labels[sportFilter].toLowerCase()} players · {selectedPoint.distance_km != null ? `${selectedPoint.distance_km} km away` : "nearby"}</small>{selectedPoint.cmr_min != null && <small>CMR {selectedPoint.cmr_min.toFixed(0)}–{selectedPoint.cmr_max?.toFixed(0)}</small>}</div></div>}</> : <div className="density-map-empty">{densityError || `Not enough visible ${labels[sportFilter].toLowerCase()} players in one area yet. Invite your circle to make the signal visible.`}</div>}
      <p className="density-privacy-note">Only aggregated neighborhoods are shown. Individual player locations are never shared.</p></section>
    <section className="community-leaderboard" aria-labelledby="community-leaderboard-title"><div className="density-heading"><div><span className="kicker">COMMUNITY LEADERBOARD</span><h2 id="community-leaderboard-title">Top {initialArea ? `${initialArea} ` : "nearby "}{labels[sportFilter]} circles</h2><p>Ranked by game quality, reliability, and players coming back.</p></div></div>{leaderboardLoading ? <div className="leaderboard-loading">Updating community scores...</div> : leaderboard.length ? <div className="leaderboard-list">{leaderboard.slice(0, 5).map((entry) => <article className="leaderboard-row" key={entry.community_id}><span className="leaderboard-rank">{entry.rank}</span><div><strong>{entry.name}</strong><small>{entry.completed_games} games · {Math.round(entry.average_match_quality * 20)}% match quality · {Math.round(entry.average_reliability * 100)}% reliable</small></div><div className="leaderboard-score"><b>{entry.quality_score}</b><small>{entry.badge ? badgeLabels[entry.badge] : "Quality score"}</small></div></article>)}</div> : <div className="leaderboard-empty">Circles appear after 3 completed games and 5 submitted player ratings.</div>}</section>
    <details className="facility-section facility-directory" open={facilitiesOpen} onToggle={(event) => setFacilitiesOpen(event.currentTarget.open)}><summary className="facility-directory-summary"><span><span className="kicker">COURTS NEAR YOUR CIRCLE</span><strong>Where to play {labels[sportFilter].toLowerCase()}</strong><small>Curated facilities near {initialArea}. Open to see booking details.</small></span><span className="facility-directory-count">{facilities.length || ""}<b aria-hidden="true">+</b></span></summary><div className="facility-directory-content">{facilitiesLoading ? <div className="leaderboard-loading">Finding courts...</div> : facilities.length ? <div className="facility-list">{facilities.slice(0, 5).map((facility) => <article className="facility-row" key={facility.id}><div><strong>{facility.name}</strong><small>{facility.area} · {facility.booking_method}</small></div><div className="facility-actions">{facility.phone && <a href={`tel:${facility.phone.replaceAll(" ", "")}`} aria-label={`Call ${facility.name}`}>Call</a>}{facility.booking_url && <a href={facility.booking_url} target="_blank" rel="noreferrer">Book <span>↗</span></a>}</div></article>)}</div> : <div className="leaderboard-empty">No curated {labels[sportFilter].toLowerCase()} courts found yet.</div>}</div></details>
  </section>;
}
