"use client";

import { PointerEvent, useEffect, useRef, useState } from "react";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type CommunityHubProps = { apiUrl: string; authorizedFetch: (input: string, init?: RequestInit) => Promise<Response>; currentCmr?: number; gamesLogged: number; initialLatitude?: number | null; initialLongitude?: number | null; initialArea?: string };
type DensityPoint = { area: string; player_count: number; intensity: "warm" | "hot" | "very_hot"; latitude?: number | null; longitude?: number | null; cmr_min?: number | null; cmr_max?: number | null; distance_km?: number | null; activity_score?: number; active_game_count?: number; community_count?: number };
type NearbyGame = { id: string; group_name: string; sport: Sport; area: string; venue_name?: string | null; session_date: string; start_time: string; end_time: string; open_slots: number; skill_min: number; skill_max: number; latitude?: number | null; longitude?: number | null; distance_km?: number | null; match_score: number };
type MapCommunity = { community_id: string; name: string; sport: Sport; area: string; latitude?: number | null; longitude?: number | null; active_player_count: number; upcoming_game_count: number; activity_score: number; quality_score: number };
type MapCluster = { cluster_id: string; area: string; latitude?: number | null; longitude?: number | null; game_count: number; open_slot_count: number; game_ids: string[] };
type Facility = { id: string; name: string; sport: Sport; area: string; phone?: string | null; booking_method: string; booking_url?: string | null };
type LeaderboardEntry = { rank: number; community_id: string; name: string; sport: Sport; area: string; quality_score: number; completed_games: number; active_players: number; average_match_quality: number; feedback_completion_rate: number; repeat_play_rate: number; average_cmr_improvement: number; average_reliability: number; badge?: "best_quality" | "most_improved" | "most_reliable" | "fastest_growing" | null };

const labels: Record<Sport, string> = { pickleball: "Pickleball", badminton: "Badminton", tennis: "Tennis", padel: "Padel", squash: "Squash", table_tennis: "Table tennis" };
const DEFAULT_CENTER = { latitude: 12.9698, longitude: 77.7499 };
const badgeLabels: Record<NonNullable<LeaderboardEntry["badge"]>, string> = { best_quality: "Best quality", most_improved: "Most improved", most_reliable: "Most reliable", fastest_growing: "Fastest growing" };

function GoogleDensityMap({ points, communities, games, clusters, center, radiusKm, selectedPoint, onSelect, onSelectCommunity, onSelectGame }: { points: DensityPoint[]; communities: MapCommunity[]; games: NearbyGame[]; clusters: MapCluster[]; center: { latitude: number; longitude: number }; radiusKm: number; selectedPoint: DensityPoint | null; onSelect: (point: DensityPoint) => void; onSelectCommunity: (community: MapCommunity) => void; onSelectGame: (game: NearbyGame) => void }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const onSelectCommunityRef = useRef(onSelectCommunity);
  const onSelectGameRef = useRef(onSelectGame);
  const mapKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  onSelectRef.current = onSelect;
  onSelectCommunityRef.current = onSelectCommunity;
  onSelectGameRef.current = onSelectGame;

  useEffect(() => {
    if (!mapKey || !mapRef.current) return;
    let cancelled = false;
    const loadMap = async () => {
      if (!(window as Window & { google?: { maps?: unknown } }).google?.maps) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector<HTMLScriptElement>("script[data-courtmate-google-maps]");
          if (existing) { existing.addEventListener("load", () => resolve(), { once: true }); existing.addEventListener("error", () => reject(new Error("Google Maps failed to load")), { once: true }); return; }
          const script = document.createElement("script");
          script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapKey)}`;
          script.async = true; script.defer = true; script.dataset.courtmateGoogleMaps = "true";
          script.onload = () => resolve(); script.onerror = () => reject(new Error("Google Maps failed to load")); document.head.appendChild(script);
        });
      }
      if (cancelled || !mapRef.current) return;
      const maps = (window as unknown as { google: { maps: any } }).google.maps;
      const map = new maps.Map(mapRef.current, { center: { lat: center.latitude, lng: center.longitude }, zoom: Math.max(9, Math.min(14, Math.round(14 - Math.log2(radiusKm / 5)))), streetViewControl: false, mapTypeControl: false, fullscreenControl: false, zoomControl: true, clickableIcons: false, gestureHandling: "greedy" });
      new maps.Circle({ map, center: { lat: center.latitude, lng: center.longitude }, radius: radiusKm * 1000, fillColor: "#d7f23f", fillOpacity: .12, strokeColor: "#90a91c", strokeOpacity: .8, strokeWeight: 2 });
      new maps.Marker({ map, position: { lat: center.latitude, lng: center.longitude }, title: "Your approximate location", icon: { path: maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#17231f", fillOpacity: 1, strokeColor: "#d7f23f", strokeWeight: 3 } });
      points.forEach((point) => { if (point.latitude == null || point.longitude == null) return; const marker = new maps.Marker({ map, position: { lat: point.latitude, lng: point.longitude }, label: { text: String(point.player_count), color: "#17231f", fontWeight: "800" }, title: `${point.area}: ${point.player_count} players` }); marker.addListener("click", () => onSelectRef.current(point)); });
      communities.forEach((community) => { if (community.latitude == null || community.longitude == null) return; const marker = new maps.Marker({ map, position: { lat: community.latitude, lng: community.longitude }, label: { text: "C", color: "#17231f", fontWeight: "800" }, title: `${community.name}: ${community.active_player_count} active players` }); marker.addListener("click", () => onSelectCommunityRef.current(community)); });
      clusters.forEach((cluster) => { if (cluster.latitude == null || cluster.longitude == null) return; const marker = new maps.Marker({ map, position: { lat: cluster.latitude, lng: cluster.longitude }, label: { text: String(cluster.game_count), color: "#ffffff", fontWeight: "800" }, title: `${cluster.game_count} active games in ${cluster.area}`, icon: { path: maps.SymbolPath.CIRCLE, scale: 17, fillColor: "#17231f", fillOpacity: 1, strokeColor: "#d7f23f", strokeWeight: 2 } }); marker.addListener("click", () => { const game = games.find((candidate) => candidate.id === cluster.game_ids[0]); if (game) onSelectGameRef.current(game); }); });
      games.forEach((game) => { if (game.latitude == null || game.longitude == null || clusters.some((cluster) => cluster.game_ids.includes(game.id))) return; const marker = new maps.Marker({ map, position: { lat: game.latitude, lng: game.longitude }, title: `${game.group_name}: ${game.open_slots} spots open`, icon: { path: maps.SymbolPath.CIRCLE, scale: 9, fillColor: "#90a91c", fillOpacity: 1, strokeColor: "#17231f", strokeWeight: 2 } }); marker.addListener("click", () => onSelectGameRef.current(game)); });
    };
    void loadMap().catch(() => undefined);
    return () => { cancelled = true; if (mapRef.current) mapRef.current.replaceChildren(); };
  }, [mapKey, center.latitude, center.longitude, radiusKm, points, communities, games, clusters]);

  if (!mapKey) return null;
  return <div className="google-density-map" ref={mapRef} aria-label="Aggregated player density map" data-selected-area={selectedPoint?.area ?? ""} />;
}

export function CommunityHub({ apiUrl, authorizedFetch, currentCmr, gamesLogged, initialLatitude, initialLongitude, initialArea = "Whitefield" }: CommunityHubProps) {
  const [sportFilter, setSportFilter] = useState<Sport>("tennis");
  const [radiusKm, setRadiusKm] = useState(5);
  const [cmrOnly, setCmrOnly] = useState(true);
  const [densityPoints, setDensityPoints] = useState<DensityPoint[]>([]);
  const [densityLoading, setDensityLoading] = useState(false);
  const [densityError, setDensityError] = useState("");
  const [nearbyGames, setNearbyGames] = useState<NearbyGame[]>([]);
  const [mapCommunities, setMapCommunities] = useState<MapCommunity[]>([]);
  const [mapClusters, setMapClusters] = useState<MapCluster[]>([]);
  const [activityFilter, setActivityFilter] = useState<"all" | "players" | "communities" | "games">("all");
  const [dateFilter, setDateFilter] = useState("");
  const [timeFilter, setTimeFilter] = useState("");
  const [selectedGame, setSelectedGame] = useState<NearbyGame | null>(null);
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
    const params = new URLSearchParams({ sport: sportFilter, radius_km: radiusKm.toString(), activity_type: activityFilter });
    if (location) { params.set("latitude", location.latitude.toString()); params.set("longitude", location.longitude.toString()); }
    if (dateFilter) params.set("date", dateFilter);
    if (timeFilter) params.set("time_of_day", timeFilter);
    if (cmrOnly && currentCmr != null) { params.set("cmr_min", Math.max(0, currentCmr - 20).toString()); params.set("cmr_max", Math.min(100, currentCmr + 20).toString()); }
    const loadLegacyMap = async () => {
      const legacyParams = new URLSearchParams({ sport: sportFilter, radius_km: radiusKm.toString() });
      if (location) { legacyParams.set("latitude", location.latitude.toString()); legacyParams.set("longitude", location.longitude.toString()); }
      if (cmrOnly && currentCmr != null) { legacyParams.set("cmr_min", Math.max(0, currentCmr - 20).toString()); legacyParams.set("cmr_max", Math.min(100, currentCmr + 20).toString()); }
      const [densityResponse, exploreResponse] = await Promise.all([authorizedFetch(`${apiUrl}/v1/me/player-density?${legacyParams}`), authorizedFetch(`${apiUrl}/v1/me/explore`)]);
      if (!densityResponse.ok || !exploreResponse.ok) throw new Error();
      const densityPayload = await densityResponse.json() as { points: DensityPoint[] };
      const explorePayload = await exploreResponse.json() as { recommendations: { session: Omit<NearbyGame, "open_slots" | "match_score"> & { capacity: number; confirmed_player_ids: string[] } }[] };
      return { player_density: densityPayload.points, community_activity: [], game_clusters: [], nearby_games: explorePayload.recommendations.map(({ session }) => ({ ...session, open_slots: Math.max(0, session.capacity - session.confirmed_player_ids.length), match_score: 50 })) };
    };
    void authorizedFetch(`${apiUrl}/v1/me/community-map?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ player_density: DensityPoint[]; community_activity: MapCommunity[]; game_clusters: MapCluster[]; nearby_games: NearbyGame[] }>; }).catch(() => loadLegacyMap()).then((payload) => { if (!cancelled) { setDensityPoints(payload.player_density); setMapCommunities(payload.community_activity); setMapClusters(payload.game_clusters); setNearbyGames(payload.nearby_games); setSelectedPoint(payload.player_density[0] ?? null); setSelectedGame(null); } }).catch(() => { if (!cancelled) { setDensityError("Community map is unavailable right now"); setDensityPoints([]); setMapCommunities([]); setMapClusters([]); setNearbyGames([]); } }).finally(() => { if (!cancelled) setDensityLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, authorizedFetch, sportFilter, radiusKm, activityFilter, dateFilter, timeFilter, cmrOnly, currentCmr, location]);

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
  const selectedGames = selectedPoint ? nearbyGames.filter((game) => game.sport === sportFilter && game.area.trim().toLowerCase() === selectedPoint.area.trim().toLowerCase()) : [];
  const selectedCommunity = selectedPoint ? mapCommunities.find((community) => community.area.trim().toLowerCase() === selectedPoint.area.trim().toLowerCase()) : null;
  const project = (point: DensityPoint) => { if (point.latitude == null || point.longitude == null) return { x: 200, y: 130 }; const xKm = (point.longitude - center.longitude) * 111.32 * Math.cos(center.latitude * Math.PI / 180); const yKm = (center.latitude - point.latitude) * 111.32; return { x: 200 + (xKm / radiusKm) * 100, y: 130 + (yKm / radiusKm) * 100 }; };
  const openGroupSpace = (game: NearbyGame) => window.location.assign(`/?group-space=${encodeURIComponent(game.id)}`);
  const startPan = (event: PointerEvent<SVGSVGElement>) => { gesture.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); };
  const movePan = (event: PointerEvent<SVGSVGElement>) => { if (!gesture.current) return; setPan({ x: gesture.current.panX + (event.clientX - gesture.current.x) / 2, y: gesture.current.panY + (event.clientY - gesture.current.y) / 2 }); };

  return <section className="page-view community-page" aria-labelledby="community-page-title">
    <header className="community-header"><span className="kicker">YOUR PEOPLE, YOUR SPORT</span><h1 id="community-page-title">Find your circle</h1><p>Players like you are showing up nearby. Log every game, improve your CMR, and make your next match better.</p></header>
    <div className="map-filter-strip" aria-label="Community map filters"><span className="map-filter-label">MAP FILTERS</span><select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value as typeof activityFilter)} aria-label="Choose map activity"><option value="all">All activity</option><option value="players">Players nearby</option><option value="communities">Active communities</option><option value="games">Games happening</option></select><select value={sportFilter} onChange={(event) => setSportFilter(event.target.value as Sport)} aria-label="Choose sport">{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))} aria-label="Choose search radius"><option value="5">Within 5 km</option><option value="10">Within 10 km</option><option value="20">Within 20 km</option><option value="35">Within 35 km</option><option value="50">Within 50 km</option></select><select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)} aria-label="Choose game time"><option value="">Any time</option><option value="morning">Morning</option><option value="day">Day</option><option value="evening">Evening</option><option value="night">Night</option></select><label className="map-date-filter"><span>Date</span><input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} aria-label="Choose game date" /></label><label className="map-cmr-toggle"><input type="checkbox" checked={cmrOnly && currentCmr != null} disabled={currentCmr == null} onChange={(event) => setCmrOnly(event.target.checked)} /><span>CMR fit</span></label><button type="button" className="map-reset-filters" onClick={() => { setActivityFilter("all"); setSportFilter("tennis"); setRadiusKm(5); setTimeFilter(""); setDateFilter(""); setCmrOnly(true); }}>Reset filters</button></div>
    <section className="player-density-card" aria-labelledby="player-density-title"><div className="density-heading"><div><span className="kicker">LIVE COMMUNITY RADAR</span><h2 id="player-density-title">Where your next game is happening</h2><p>{densityPoints.length ? `${densityPoints.reduce((total, point) => total + point.player_count, 0)} ${labels[sportFilter].toLowerCase()} players within ${radiusKm} km` : `Find ${labels[sportFilter].toLowerCase()} players within ${radiusKm} km`}</p></div><div className="map-data-legend"><span><i className="legend-dot players" /> Players</span><span><i className="legend-dot community" /> Communities</span><span><i className="legend-dot games" /> Games</span></div></div>
      {densityLoading ? <div className="density-map-loading">Scanning {radiusKm} km around you...</div> : densityPoints.length || mapCommunities.length || nearbyGames.length ? <><div className="density-map-shell"><div className="density-map-toolbar"><span>{locationState === "fallback" ? `Showing around ${initialArea}` : "Your approximate location"}</span><div><button type="button" onClick={() => setZoom((value) => Math.min(2.4, Number((value + .2).toFixed(1))))} aria-label="Zoom in">+</button><button type="button" onClick={() => setZoom((value) => Math.max(.7, Number((value - .2).toFixed(1))))} aria-label="Zoom out">−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset map">Reset</button></div></div><GoogleDensityMap points={densityPoints} communities={mapCommunities} games={nearbyGames} clusters={mapClusters} center={center} radiusKm={radiusKm} selectedPoint={selectedPoint} onSelect={setSelectedPoint} onSelectCommunity={(community) => setSelectedPoint(densityPoints.find((point) => point.area === community.area) ?? null)} onSelectGame={setSelectedGame} /><svg className="density-map-svg" viewBox="0 0 400 260" role="img" aria-label={`${labels[sportFilter]} player density within ${radiusKm} kilometres`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.max(.7, Math.min(2.4, Number((value + (event.deltaY < 0 ? .2 : -.2)).toFixed(1))))); }}><g transform={`translate(${pan.x} ${pan.y}) translate(200 130) scale(${zoom}) translate(-200 -130)`}><circle className="density-radius-ring outer" cx="200" cy="130" r="100" /><circle className="density-radius-ring inner" cx="200" cy="130" r="50" /><line className="density-map-crosshair" x1="200" y1="20" x2="200" y2="240" /><line className="density-map-crosshair" x1="90" y1="130" x2="310" y2="130" /><circle className="density-current-location" cx="200" cy="130" r="7" /><circle className="density-current-pulse" cx="200" cy="130" r="13" />{densityPoints.map((point) => { const position = project(point); return <g className={`density-hotspot-svg ${selectedPoint?.area === point.area ? "selected" : ""}`} key={point.area} transform={`translate(${position.x} ${position.y})`} onPointerDown={(event) => event.stopPropagation()} onClick={() => setSelectedPoint(point)} role="button" tabIndex={0} aria-label={`${point.area}, ${point.player_count} players`}><circle className={`density-hotspot-circle ${point.intensity}`} r={point.intensity === "very_hot" ? 27 : point.intensity === "hot" ? 23 : 19} /><text className="density-hotspot-count" y="3">{point.player_count}</text><text className="density-hotspot-area" y="41">{point.area}</text></g>; })}</g><text className="density-radius-label" x="205" y="24">{radiusKm} km radius</text></svg></div>{selectedPoint && <div className="density-detail"><div><strong>{selectedPoint.area}</strong><small>{selectedPoint.player_count} {labels[sportFilter].toLowerCase()} players · {selectedPoint.distance_km != null ? `${selectedPoint.distance_km} km away` : "nearby"}</small>{selectedPoint.cmr_min != null && <small>CMR {selectedPoint.cmr_min.toFixed(0)}–{selectedPoint.cmr_max?.toFixed(0)}</small>}</div><div className="density-games"><strong>{selectedGames.length ? "Active games here" : "No active games here yet"}</strong>{selectedGames.slice(0, 3).map((game) => <article key={game.id}><span>{game.group_name}</span><small>{game.session_date} · {game.start_time}–{game.end_time} · {game.open_slots} spots open</small></article>)}</div></div>}</> : <div className="density-map-empty">{densityError || `Not enough visible ${labels[sportFilter].toLowerCase()} players in one area yet. Invite your circle to make the signal visible.`}</div>}
      {selectedGame && <div className="map-selected-game"><strong>{selectedGame.group_name}</strong><span>{selectedGame.area} · {selectedGame.session_date} · {selectedGame.start_time}–{selectedGame.end_time}</span><small>{selectedGame.open_slots} spots open · {Math.round(selectedGame.match_score)}% CMR/location fit</small><button type="button" onClick={() => openGroupSpace(selectedGame)}>View Rally Circle</button></div>}
      {nearbyGames.length > 0 && <section className="map-game-list" aria-labelledby="nearby-games-title"><div className="map-game-list-heading"><div><span className="kicker">PUBLIC GAMES NEARBY</span><h3 id="nearby-games-title">Games happening around you</h3></div><span>{nearbyGames.length} found</span></div>{nearbyGames.slice(0, 8).map((game) => <article className="map-game-row" key={game.id}><div><strong>{game.group_name}</strong><small>{game.area}{game.venue_name ? ` · ${game.venue_name}` : ""} · {game.session_date}</small><small>{game.start_time}–{game.end_time} · {game.open_slots} spots open · {Math.round(game.match_score)}% fit</small></div><button type="button" onClick={() => openGroupSpace(game)}>View Rally Circle <span aria-hidden="true">→</span></button></article>)}</section>}
      <p className="density-privacy-note">Only aggregated neighborhoods are shown. Individual player locations are never shared.</p></section>
    <section className="community-leaderboard" aria-labelledby="community-leaderboard-title"><div className="density-heading"><div><span className="kicker">COMMUNITY LEADERBOARD</span><h2 id="community-leaderboard-title">Top {initialArea ? `${initialArea} ` : "nearby "}{labels[sportFilter]} circles</h2><p>Ranked by game quality, reliability, and players coming back.</p></div></div>{leaderboardLoading ? <div className="leaderboard-loading">Updating community scores...</div> : leaderboard.length ? <div className="leaderboard-list">{leaderboard.slice(0, 5).map((entry) => <article className="leaderboard-row" key={entry.community_id}><span className="leaderboard-rank">{entry.rank}</span><div><strong>{entry.name}</strong><small>{entry.completed_games} games · {Math.round(entry.average_match_quality * 20)}% match quality · {Math.round(entry.average_reliability * 100)}% reliable</small></div><div className="leaderboard-score"><b>{entry.quality_score}</b><small>{entry.badge ? badgeLabels[entry.badge] : "Quality score"}</small></div></article>)}</div> : <div className="leaderboard-empty">Circles appear after 3 completed games and 5 submitted player ratings.</div>}</section>
    <details className="facility-section facility-directory" open={facilitiesOpen} onToggle={(event) => setFacilitiesOpen(event.currentTarget.open)}><summary className="facility-directory-summary"><span><span className="kicker">COURTS NEAR YOUR CIRCLE</span><strong>Where to play {labels[sportFilter].toLowerCase()}</strong><small>Curated facilities near {initialArea}. Open to see booking details.</small></span><span className="facility-directory-count">{facilities.length || ""}<b aria-hidden="true">+</b></span></summary><div className="facility-directory-content">{facilitiesLoading ? <div className="leaderboard-loading">Finding courts...</div> : facilities.length ? <div className="facility-list">{facilities.slice(0, 5).map((facility) => <article className="facility-row" key={facility.id}><div><strong>{facility.name}</strong><small>{facility.area} · {facility.booking_method}</small></div><div className="facility-actions">{facility.phone && <a href={`tel:${facility.phone.replaceAll(" ", "")}`} aria-label={`Call ${facility.name}`}>Call</a>}{facility.booking_url && <a href={facility.booking_url} target="_blank" rel="noreferrer">Book <span>↗</span></a>}</div></article>)}</div> : <div className="leaderboard-empty">No curated {labels[sportFilter].toLowerCase()} courts found yet.</div>}</div></details>
  </section>;
}
