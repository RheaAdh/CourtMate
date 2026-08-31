"use client";

import { PointerEvent, useEffect, useRef, useState } from "react";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type CommunityHubProps = { apiUrl: string; authorizedFetch: (input: string, init?: RequestInit) => Promise<Response>; currentCmr?: number; gamesLogged: number; requestedSessionIds?: string[]; joinedSessionIds?: string[]; onOpenExistingGame?: (sessionId: string, status: "pending" | "joined") => void; initialLatitude?: number | null; initialLongitude?: number | null; initialArea?: string };
type DensityPoint = { area: string; player_count: number; intensity: "warm" | "hot" | "very_hot"; latitude?: number | null; longitude?: number | null; cmr_min?: number | null; cmr_max?: number | null; distance_km?: number | null; activity_score?: number; active_game_count?: number; community_count?: number };
type NearbyGame = { id: string; group_name: string; sport: Sport; area: string; venue_name?: string | null; session_date: string; start_time: string; end_time: string; open_slots: number; skill_min: number; skill_max: number; latitude?: number | null; longitude?: number | null; distance_km?: number | null; match_score: number };
type MapCommunity = { community_id: string; name: string; sport: Sport; area: string; latitude?: number | null; longitude?: number | null; active_player_count: number; upcoming_game_count: number; activity_score: number; quality_score: number };
type MapCluster = { cluster_id: string; area: string; latitude?: number | null; longitude?: number | null; game_count: number; open_slot_count: number; game_ids: string[] };
type Facility = { id: string; name: string; sport: Sport; area: string; phone?: string | null; booking_method: string; booking_url?: string | null };
type LeaderboardEntry = { rank: number; community_id: string; name: string; sport: Sport; area: string; quality_score: number; completed_games: number; active_players: number; average_match_quality: number; feedback_completion_rate: number; repeat_play_rate: number; average_cmr_improvement: number; average_reliability: number; badge?: "best_quality" | "most_improved" | "most_reliable" | "fastest_growing" | null };

const labels: Record<Sport, string> = { pickleball: "Pickleball", badminton: "Badminton", tennis: "Tennis", padel: "Padel", squash: "Squash", table_tennis: "Table tennis" };
const DEFAULT_CENTER = { latitude: 12.9698, longitude: 77.7499 };
const BENGALURU_AREAS: Record<string, { latitude: number; longitude: number }> = { Whitefield: { latitude: 12.9698, longitude: 77.7499 }, Brookefield: { latitude: 12.9665, longitude: 77.7168 }, Varthur: { latitude: 12.9408, longitude: 77.746 }, Marathahalli: { latitude: 12.9569, longitude: 77.7011 }, Indiranagar: { latitude: 12.9784, longitude: 77.6408 }, Koramangala: { latitude: 12.9352, longitude: 77.6245 }, "HSR Layout": { latitude: 12.9116, longitude: 77.6389 }, Bellandur: { latitude: 12.9255, longitude: 77.6762 }, Sarjapur: { latitude: 12.9279, longitude: 77.6271 }, Kadubeesanahalli: { latitude: 12.9358, longitude: 77.69 } };
const badgeLabels: Record<NonNullable<LeaderboardEntry["badge"]>, string> = { best_quality: "Best quality", most_improved: "Most improved", most_reliable: "Most reliable", fastest_growing: "Fastest growing" };

function GoogleDensityMap({ points, communities, games, clusters, center, radiusKm, selectedPoint, onSelect, onSelectCommunity, onSelectGame }: { points: DensityPoint[]; communities: MapCommunity[]; games: NearbyGame[]; clusters: MapCluster[]; center: { latitude: number; longitude: number }; radiusKm: number; selectedPoint: DensityPoint | null; onSelect: (point: DensityPoint) => void; onSelectCommunity: (community: MapCommunity) => void; onSelectGame: (game: NearbyGame, gameIds?: string[]) => void }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapReady, setMapReady] = useState(false);
  const onSelectRef = useRef(onSelect);
  const onSelectCommunityRef = useRef(onSelectCommunity);
  const onSelectGameRef = useRef(onSelectGame);
  const mapKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  onSelectRef.current = onSelect;
  onSelectCommunityRef.current = onSelectCommunity;
  onSelectGameRef.current = onSelectGame;

  useEffect(() => {
    if (!mapKey) {
      console.warn("CourtMate Google Maps key is missing from the browser bundle; using the SVG map fallback.");
      return;
    }
    if (!mapRef.current) return;
    let cancelled = false;
    setMapReady(false);
    const loadMap = async () => {
      const mapConstructorReady = () => typeof (window as Window & { google?: { maps?: { Map?: unknown } } }).google?.maps?.Map === "function";
      if (!mapConstructorReady()) {
        await new Promise<void>((resolve, reject) => {
          const waitForMapConstructor = () => {
            const startedAt = Date.now();
            const timer = window.setInterval(() => {
              if (mapConstructorReady()) { window.clearInterval(timer); resolve(); }
              else if (Date.now() - startedAt > 8000) { window.clearInterval(timer); reject(new Error("Google Maps did not finish initializing")); }
            }, 50);
          };
          const existing = document.querySelector<HTMLScriptElement>("script[data-courtmate-google-maps]");
          if (existing) { existing.addEventListener("load", waitForMapConstructor, { once: true }); existing.addEventListener("error", () => reject(new Error("Google Maps failed to load")), { once: true }); waitForMapConstructor(); return; }
          const script = document.createElement("script");
          script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapKey)}&loading=async&libraries=marker`;
          script.async = true; script.defer = true; script.dataset.courtmateGoogleMaps = "true";
          script.onload = waitForMapConstructor; script.onerror = () => reject(new Error("Google Maps failed to load")); document.head.appendChild(script);
        });
      }
      if (cancelled || !mapRef.current) return;
      const maps = (window as unknown as { google: { maps: any } }).google.maps;
      const markerLibrary = typeof maps.importLibrary === "function" ? await maps.importLibrary("marker") : null;
      const AdvancedMarkerElement = markerLibrary?.AdvancedMarkerElement;
      const makeMarkerContent = (text: string, background: string, foreground: string, size: number) => { const content = document.createElement("div"); content.textContent = text; content.style.cssText = `display:grid;place-items:center;width:${size}px;height:${size}px;border-radius:50%;background:${background};color:${foreground};border:2px solid #d7f23f;font:800 ${Math.max(11, size * .42)}px/1 sans-serif;box-sizing:border-box;`; return content; };
      const map = new maps.Map(mapRef.current, { center: { lat: center.latitude, lng: center.longitude }, zoom: Math.max(9, Math.min(14, Math.round(14 - Math.log2(radiusKm / 5)))), mapId: "DEMO_MAP_ID", streetViewControl: false, mapTypeControl: false, fullscreenControl: false, zoomControl: true, clickableIcons: false, gestureHandling: "greedy" });
      new maps.Circle({ map, center: { lat: center.latitude, lng: center.longitude }, radius: radiusKm * 1000, fillColor: "#d7f23f", fillOpacity: .12, strokeColor: "#90a91c", strokeOpacity: .8, strokeWeight: 2 });
      const makeMarker = (position: { lat: number; lng: number }, title: string, text: string, background: string, foreground: string, size: number) => {
        if (AdvancedMarkerElement) return new AdvancedMarkerElement({ map, position, title, content: makeMarkerContent(text, background, foreground, size) });
        return new maps.Marker({ map, position, title, label: text ? { text, color: foreground, fontWeight: "800" } : undefined, icon: { path: maps.SymbolPath.CIRCLE, fillColor: background, fillOpacity: 1, strokeColor: "#d7f23f", strokeWeight: 2, scale: size / 2 } });
      };
      makeMarker({ lat: center.latitude, lng: center.longitude }, "Your approximate location", "", "#17231f", "#ffffff", 18);
      const visibleClusters = clusters.filter((cluster) => cluster.game_ids.some((id) => games.some((game) => game.id === id)));
      visibleClusters.forEach((cluster) => { if (cluster.latitude == null || cluster.longitude == null) return; const marker = makeMarker({ lat: cluster.latitude, lng: cluster.longitude }, `${cluster.game_count} active games in ${cluster.area}`, String(cluster.game_count), "#17231f", "#ffffff", 42); marker.addListener("click", () => { const game = games.find((candidate) => candidate.id === cluster.game_ids[0]); if (game) onSelectGameRef.current(game, cluster.game_ids); }); });
      games.forEach((game) => { if (game.latitude == null || game.longitude == null || visibleClusters.some((cluster) => cluster.game_ids.includes(game.id))) return; const marker = makeMarker({ lat: game.latitude, lng: game.longitude }, `${game.group_name}: ${game.open_slots} spots open`, "•", "#90a91c", "#17231f", 24); marker.addListener("click", () => onSelectGameRef.current(game, [game.id])); });
      if (!cancelled) setMapReady(true);
    };
    void loadMap().catch((error: unknown) => {
      if (!cancelled) setMapReady(false);
      console.error("CourtMate Google Maps initialization failed", error);
    });
    return () => { cancelled = true; if (mapRef.current) mapRef.current.replaceChildren(); };
  }, [mapKey, center.latitude, center.longitude, radiusKm, points, communities, games, clusters]);

  if (!mapKey) return null;
  return <div className={`google-density-map ${mapReady ? "is-ready" : ""}`} ref={mapRef} aria-label="Aggregated player density map" data-selected-area={selectedPoint?.area ?? ""} />;
}

export function CommunityHub({ apiUrl, authorizedFetch, currentCmr, gamesLogged, requestedSessionIds = [], joinedSessionIds = [], onOpenExistingGame, initialLatitude, initialLongitude, initialArea = "Whitefield" }: CommunityHubProps) {
  const authorizedFetchRef = useRef(authorizedFetch);
  authorizedFetchRef.current = authorizedFetch;
  const [sportFilter, setSportFilter] = useState<Sport>("tennis");
  const [radiusKm, setRadiusKm] = useState(5);
  const [mapRefresh, setMapRefresh] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [cmrOnly, setCmrOnly] = useState(false);
  const [densityPoints, setDensityPoints] = useState<DensityPoint[]>([]);
  const [densityLoading, setDensityLoading] = useState(false);
  const [densityError, setDensityError] = useState("");
  const [nearbyGamesState, setNearbyGamesState] = useState<NearbyGame[]>([]);
  const [mapCommunities, setMapCommunities] = useState<MapCommunity[]>([]);
  const [mapClusters, setMapClusters] = useState<MapCluster[]>([]);
  const [activityFilter, setActivityFilter] = useState<"all" | "players" | "communities" | "games">("games");
  const [dateFilter, setDateFilter] = useState("");
  const [timeFilter, setTimeFilter] = useState("");
  const [selectedGame, setSelectedGameState] = useState<NearbyGame | null>(null);
  const [selectedMapArea, setSelectedMapArea] = useState<string | null>(null);
  const [selectedGameIds, setSelectedGameIds] = useState<string[] | null>(null);
  const setSelectedGame = (game: NearbyGame | null, gameIds: string[] = game ? [game.id] : []) => { setSelectedGameState(game); setSelectedMapArea(game?.area ?? null); setSelectedGameIds(game ? gameIds : null); };
  const nearbyGames = selectedGameIds ? nearbyGamesState.filter((game) => selectedGameIds.includes(game.id)) : nearbyGamesState;
  const setNearbyGames = setNearbyGamesState;
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number }>(initialLatitude != null && initialLongitude != null ? { latitude: initialLatitude, longitude: initialLongitude } : DEFAULT_CENTER);
  const [locationState, setLocationState] = useState<"saved" | "detecting" | "fallback">(initialLatitude != null && initialLongitude != null ? "saved" : "fallback");
  const [areaFilter, setAreaFilter] = useState(Object.prototype.hasOwnProperty.call(BENGALURU_AREAS, initialArea) ? initialArea : "Whitefield");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedPoint, setSelectedPoint] = useState<DensityPoint | null>(null);
  const gesture = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const manualAreaRef = useRef(false);

  useEffect(() => {
    if (initialLatitude != null && initialLongitude != null) return;
    if (!navigator.geolocation) { setLocation(DEFAULT_CENTER); setLocationState("fallback"); return; }
    navigator.geolocation.getCurrentPosition((position) => { if (!manualAreaRef.current) { setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude }); setLocationState("saved"); } }, () => { if (!manualAreaRef.current) { setLocation(DEFAULT_CENTER); setLocationState("fallback"); } }, { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 });
  }, [initialLatitude, initialLongitude]);

  useEffect(() => {
    let cancelled = false;
    if (mapRefresh === 0) return () => { cancelled = true; };
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
      const [densityResponse, exploreResponse] = await Promise.all([authorizedFetchRef.current(`${apiUrl}/v1/me/player-density?${legacyParams}`), authorizedFetchRef.current(`${apiUrl}/v1/me/explore`)]);
      if (!densityResponse.ok || !exploreResponse.ok) throw new Error();
      const densityPayload = await densityResponse.json() as { points: DensityPoint[] };
      const explorePayload = await exploreResponse.json() as { recommendations: { session: Omit<NearbyGame, "open_slots" | "match_score"> & { capacity: number; confirmed_player_ids: string[] } }[] };
      return { player_density: densityPayload.points, community_activity: [], game_clusters: [], nearby_games: explorePayload.recommendations.map(({ session }) => ({ ...session, open_slots: Math.max(0, session.capacity - session.confirmed_player_ids.length), match_score: 50 })) };
    };
    void authorizedFetchRef.current(`${apiUrl}/v1/me/community-map?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ player_density: DensityPoint[]; community_activity: MapCommunity[]; game_clusters: MapCluster[]; nearby_games: NearbyGame[] }>; }).catch(() => loadLegacyMap()).then((payload) => { if (!cancelled) { setDensityPoints(payload.player_density); setMapCommunities(payload.community_activity); setMapClusters(payload.game_clusters); setNearbyGames(payload.nearby_games); setSelectedPoint(null); setSelectedGame(null); setSelectedMapArea(null); } }).catch(() => { if (!cancelled) { setDensityError("Community map is unavailable right now"); setDensityPoints([]); setMapCommunities([]); setMapClusters([]); setNearbyGames([]); } }).finally(() => { if (!cancelled) setDensityLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, mapRefresh]);

  useEffect(() => {
    let cancelled = false;
    setLeaderboardLoading(true);
    const params = new URLSearchParams({ sport: sportFilter });
    if (initialArea) params.set("area", initialArea);
    void authorizedFetchRef.current(`${apiUrl}/v1/me/community-leaderboard?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ entries: LeaderboardEntry[] }>; }).then((payload) => { if (!cancelled) setLeaderboard(payload.entries); }).catch(() => { if (!cancelled) setLeaderboard([]); }).finally(() => { if (!cancelled) setLeaderboardLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, sportFilter, initialArea]);

  useEffect(() => {
    let cancelled = false;
    if (!facilitiesOpen) return () => { cancelled = true; };
    setFacilitiesLoading(true);
    const params = new URLSearchParams({ sport: sportFilter });
    if (initialArea) params.set("area", initialArea);
    void authorizedFetchRef.current(`${apiUrl}/v1/me/venues?${params}`).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ facilities: Facility[] }>; }).then((payload) => { if (!cancelled) setFacilities(payload.facilities); }).catch(() => { if (!cancelled) setFacilities([]); }).finally(() => { if (!cancelled) setFacilitiesLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl, sportFilter, initialArea, facilitiesOpen]);

  const center = location ?? DEFAULT_CENTER;
  const gamesInSelectedArea = selectedMapArea ? nearbyGames.filter((game) => game.area.trim().toLowerCase() === selectedMapArea.trim().toLowerCase()) : nearbyGames;
  const selectedGames = selectedPoint ? nearbyGames.filter((game) => game.sport === sportFilter && game.area.trim().toLowerCase() === selectedPoint.area.trim().toLowerCase()) : [];
  const selectedCommunity = selectedPoint ? mapCommunities.find((community) => community.area.trim().toLowerCase() === selectedPoint.area.trim().toLowerCase()) : null;
  const isRequested = (sessionId: string) => requestedSessionIds.includes(sessionId);
  const isJoined = (sessionId: string) => joinedSessionIds.includes(sessionId);
  const openExistingGame = (game: NearbyGame) => {
    if (isRequested(game.id)) onOpenExistingGame?.(game.id, "pending");
    else if (isJoined(game.id)) onOpenExistingGame?.(game.id, "joined");
    else openGroupSpace(game);
  };
  const project = (point: DensityPoint) => { if (point.latitude == null || point.longitude == null) return { x: 200, y: 130 }; const xKm = (point.longitude - center.longitude) * 111.32 * Math.cos(center.latitude * Math.PI / 180); const yKm = (center.latitude - point.latitude) * 111.32; return { x: 200 + (xKm / radiusKm) * 100, y: 130 + (yKm / radiusKm) * 100 }; };
  const openGroupSpace = (game: NearbyGame) => window.location.assign(`/?rally-circle=${encodeURIComponent(game.id)}`);
  const startPan = (event: PointerEvent<SVGSVGElement>) => { gesture.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); };
  const movePan = (event: PointerEvent<SVGSVGElement>) => { if (!gesture.current) return; setPan({ x: gesture.current.panX + (event.clientX - gesture.current.x) / 2, y: gesture.current.panY + (event.clientY - gesture.current.y) / 2 }); };

  return <section className="page-view community-page" aria-labelledby="community-page-title">
    <header className="community-header"><span className="kicker">YOUR PEOPLE, YOUR SPORT</span><h1 id="community-page-title">Find your circle</h1><p>Players like you are showing up nearby. Log every game, improve your CMR, and make your next match better.</p></header>
    <section className="player-density-card" aria-labelledby="player-density-title"><div className="density-heading"><div><span className="kicker">LIVE COMMUNITY RADAR</span><h2 id="player-density-title">Active games near you</h2><p>{nearbyGames.length ? `${nearbyGames.length} public ${labels[sportFilter].toLowerCase()} game${nearbyGames.length === 1 ? "" : "s"} within ${radiusKm} km` : `Find active ${labels[sportFilter].toLowerCase()} games within ${radiusKm} km`}</p></div><div className="density-heading-side"><div className="radar-selectors"><select value={sportFilter} onChange={(event) => { setSportFilter(event.target.value as Sport); setHasSearched(false); setSelectedGame(null); }} aria-label="Choose sport">{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={radiusKm} onChange={(event) => { setRadiusKm(Number(event.target.value)); setHasSearched(false); setSelectedGame(null); }} aria-label="Choose map radius"><option value="5">Within 5 km</option><option value="10">Within 10 km</option><option value="20">Within 20 km</option><option value="35">Within 35 km</option><option value="50">Within 50 km</option></select><select value={areaFilter} onChange={(event) => { const nextArea = event.target.value; manualAreaRef.current = true; setAreaFilter(nextArea); setLocation(BENGALURU_AREAS[nextArea]); setHasSearched(false); setLocationState("fallback"); setSelectedGame(null); }} aria-label="Choose Bengaluru area">{Object.keys(BENGALURU_AREAS).map((area) => <option key={area} value={area}>{area}</option>)}</select><button type="button" className="radar-search-button" onClick={() => { setHasSearched(true); setSelectedGame(null); setMapRefresh((value) => value + 1); }}>Search games</button></div><div className="map-data-legend"><span><i className="legend-dot games" /> Active games</span><span><i className="legend-dot community" /> Game clusters</span></div></div></div>
      {!hasSearched ? <div className="density-map-empty">Choose your sport, radius, and area, then press Search games to find nearby activity.</div> : densityLoading ? <div className="density-map-loading">Scanning {radiusKm} km around you...</div> : densityPoints.length || mapCommunities.length || nearbyGames.length ? <><div className="density-map-shell"><div className="density-map-toolbar"><span>{locationState === "fallback" ? `Showing around ${initialArea}` : "Your approximate location"}</span><div><button type="button" onClick={() => setZoom((value) => Math.min(2.4, Number((value + .2).toFixed(1))))} aria-label="Zoom in">+</button><button type="button" onClick={() => setZoom((value) => Math.max(.7, Number((value - .2).toFixed(1))))} aria-label="Zoom out">−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset map">Reset</button></div></div><GoogleDensityMap points={densityPoints} communities={mapCommunities} games={nearbyGames} clusters={mapClusters} center={center} radiusKm={radiusKm} selectedPoint={selectedPoint} onSelect={setSelectedPoint} onSelectCommunity={(community) => setSelectedPoint(densityPoints.find((point) => point.area === community.area) ?? null)} onSelectGame={setSelectedGame} /><svg className="density-map-svg" viewBox="0 0 400 260" role="img" aria-label={`${labels[sportFilter]} player density within ${radiusKm} kilometres`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onWheel={(event) => { setZoom((value) => Math.max(.7, Math.min(2.4, Number((value + (event.deltaY < 0 ? .2 : -.2)).toFixed(1))))); }}><g transform={`translate(${pan.x} ${pan.y}) translate(200 130) scale(${zoom}) translate(-200 -130)`}><circle className="density-radius-ring outer" cx="200" cy="130" r="100" /><circle className="density-radius-ring inner" cx="200" cy="130" r="50" /><line className="density-map-crosshair" x1="200" y1="20" x2="200" y2="240" /><line className="density-map-crosshair" x1="90" y1="130" x2="310" y2="130" /><circle className="density-current-location" cx="200" cy="130" r="7" /><circle className="density-current-pulse" cx="200" cy="130" r="13" />{densityPoints.map((point) => { const position = project(point); return <g className={`density-hotspot-svg ${selectedPoint?.area === point.area ? "selected" : ""}`} key={point.area} transform={`translate(${position.x} ${position.y})`} onPointerDown={(event) => event.stopPropagation()} onClick={() => setSelectedPoint(point)} role="button" tabIndex={0} aria-label={`${point.area}, ${point.player_count} players`}><circle className={`density-hotspot-circle ${point.intensity}`} r={point.intensity === "very_hot" ? 27 : point.intensity === "hot" ? 23 : 19} /><text className="density-hotspot-count" y="3">{point.player_count}</text><text className="density-hotspot-area" y="41">{point.area}</text></g>; })}</g><text className="density-radius-label" x="205" y="24">{radiusKm} km radius</text></svg></div>{selectedPoint && <div className="density-detail"><div><strong>{selectedPoint.area}</strong><small>{selectedPoint.player_count} {labels[sportFilter].toLowerCase()} players · {selectedPoint.distance_km != null ? `${selectedPoint.distance_km} km away` : "nearby"}</small>{selectedPoint.cmr_min != null && <small>CMR {selectedPoint.cmr_min.toFixed(0)}–{selectedPoint.cmr_max?.toFixed(0)}</small>}</div><div className="density-games"><strong>{selectedGames.length ? "Active games here" : "No active games here yet"}</strong>{selectedGames.slice(0, 3).map((game) => <article key={game.id}><span>{game.group_name}</span><small>{game.session_date} · {game.start_time}–{game.end_time} · {game.open_slots} spots open</small></article>)}</div></div>}</> : <div className="density-map-empty">{densityError || `Not enough visible ${labels[sportFilter].toLowerCase()} players in one area yet. Invite your circle to make the signal visible.`}</div>}
      {selectedGame && <div className="map-selected-game"><strong>{selectedGame.group_name}</strong><span>{selectedGame.area} · {selectedGame.session_date} · {selectedGame.start_time}–{selectedGame.end_time}</span><small>{isRequested(selectedGame.id) ? "Already requested · " : isJoined(selectedGame.id) ? "Already in My games · " : ""}{selectedGame.open_slots} spots open · {Math.round(selectedGame.match_score)}% CMR/location fit</small><button type="button" onClick={() => openExistingGame(selectedGame)}>View Rally Circle</button></div>}
      {nearbyGames.length > 0 && <section className="map-game-list" aria-labelledby="nearby-games-title"><div className="map-game-list-heading"><div><span className="kicker">PUBLIC GAMES NEARBY</span><h3 id="nearby-games-title">Games happening around you</h3></div><span>{nearbyGames.length} found</span></div>{nearbyGames.slice(0, 8).map((game) => <article className="map-game-row" key={game.id}><div><strong>{game.group_name}</strong><small>{game.area}{game.venue_name ? ` · ${game.venue_name}` : ""} · {game.session_date}</small><small>{game.start_time}–{game.end_time} · {game.open_slots} spots open · {Math.round(game.match_score)}% fit</small></div><button type="button" onClick={() => openExistingGame(game)}>{isRequested(game.id) ? "Already requested" : isJoined(game.id) ? "Already in My games" : "View Rally Circle"} <span aria-hidden="true">→</span></button></article>)}</section>}
      <p className="density-privacy-note">Only aggregated neighborhoods are shown. Individual player locations are never shared.</p></section>
    <section className="community-leaderboard" aria-labelledby="community-leaderboard-title"><div className="density-heading"><div><span className="kicker">COMMUNITY LEADERBOARD</span><h2 id="community-leaderboard-title">Top {initialArea ? `${initialArea} ` : "nearby "}{labels[sportFilter]} circles</h2><p>Quality over popularity: circles are ranked by the games people want to play again.</p></div></div><div className="leaderboard-explainer"><strong>How the score works</strong><span>Match quality 35%</span><span>Feedback 20%</span><span>Repeat play 20%</span><span>Reliability 15%</span><span>CMR improvement 10%</span><small>Minimum to qualify: 3 completed games and 5 player ratings.</small></div>{leaderboardLoading ? <div className="leaderboard-loading">Updating community scores...</div> : leaderboard.length ? <div className="leaderboard-list">{leaderboard.slice(0, 5).map((entry) => <article className="leaderboard-row" key={entry.community_id}><span className="leaderboard-rank">{entry.rank}</span><div><strong>{entry.name}</strong><small>{entry.completed_games} games · {Math.round(entry.average_match_quality * 20)}% match quality · {Math.round(entry.average_reliability * 100)}% reliable</small></div><div className="leaderboard-score"><b>{entry.quality_score}<em>/100</em></b><small>{entry.badge ? badgeLabels[entry.badge] : "Quality score"}</small></div></article>)}</div> : <div className="leaderboard-empty">Circles appear after 3 completed games and 5 submitted player ratings.</div>}</section>
    <details className="facility-section facility-directory" open={facilitiesOpen} onToggle={(event) => setFacilitiesOpen(event.currentTarget.open)}><summary className="facility-directory-summary"><span><span className="kicker">COURTS NEAR YOUR CIRCLE</span><strong>Where to play {labels[sportFilter].toLowerCase()}</strong><small>Curated facilities near {initialArea}. Open to see booking details.</small></span><span className="facility-directory-count">{facilities.length || ""}<b aria-hidden="true">+</b></span></summary><div className="facility-directory-content">{facilitiesLoading ? <div className="leaderboard-loading">Finding courts...</div> : facilities.length ? <div className="facility-list">{facilities.slice(0, 5).map((facility) => <article className="facility-row" key={facility.id}><div><strong>{facility.name}</strong><small>{facility.area} · {facility.booking_method}</small></div><div className="facility-actions">{facility.phone && <a href={`tel:${facility.phone.replaceAll(" ", "")}`} aria-label={`Call ${facility.name}`}>Call</a>}{facility.booking_url && <a href={facility.booking_url} target="_blank" rel="noreferrer">Book <span>↗</span></a>}</div></article>)}</div> : <div className="leaderboard-empty">No curated {labels[sportFilter].toLowerCase()} courts found yet.</div>}</div></details>
  </section>;
}
