"use client";

import { PointerEvent, useEffect, useRef, useState } from "react";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type SportFilter = Sport | "all";
type MapVisibilityFilter = "all" | "public" | "friends";

export type NearbyGame = {
  id: string;
  group_name: string;
  sport: Sport;
  area: string;
  venue_name?: string | null;
  session_date: string;
  start_time: string;
  end_time: string;
  open_slots: number;
  skill_min: number;
  skill_max: number;
  latitude?: number | null;
  longitude?: number | null;
  distance_km?: number | null;
  match_score: number;
  visibility?: "public" | "followers";
  is_connection_game?: boolean;
};

type DensityPoint = {
  area: string;
  player_count: number;
  intensity: "warm" | "hot" | "very_hot";
  latitude?: number | null;
  longitude?: number | null;
  cmr_min?: number | null;
  cmr_max?: number | null;
  distance_km?: number | null;
  activity_score?: number;
  active_game_count?: number;
  community_count?: number;
};

type MapCommunity = {
  community_id: string;
  name: string;
  sport: Sport;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  active_player_count: number;
  upcoming_game_count: number;
  activity_score: number;
  quality_score: number;
};

type MapCluster = {
  cluster_id: string;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
  game_count: number;
  open_slot_count: number;
  game_ids: string[];
};

type Facility = {
  id: string;
  name: string;
  sport: Sport;
  area: string;
  phone?: string | null;
  booking_method: string;
  booking_url?: string | null;
};

type LeaderboardEntry = {
  rank: number;
  community_id: string;
  name: string;
  sport: Sport;
  area: string;
  quality_score: number;
  completed_games: number;
  active_players: number;
  average_match_quality: number;
  feedback_completion_rate: number;
  repeat_play_rate: number;
  average_cmr_improvement: number;
  average_reliability: number;
  badge?: "best_quality" | "most_improved" | "most_reliable" | "fastest_growing" | null;
};

export type CommunityHubProps = {
  apiUrl: string;
  authorizedFetch: (input: string, init?: RequestInit) => Promise<Response>;
  currentCmr?: number;
  gamesLogged: number;
  requestedSessionIds?: string[];
  joinedSessionIds?: string[];
  onOpenExistingGame?: (sessionId: string, status: "pending" | "joined") => void;
  onOpenRallyCircle?: (sessionId: string) => void;
  onRequestJoin?: (game: NearbyGame) => Promise<void> | void;
  isGuest?: boolean;
  onSignIn?: () => void;
  initialLatitude?: number | null;
  initialLongitude?: number | null;
  initialArea?: string;
};

const labels: Record<SportFilter, string> = {
  all: "All sports",
  pickleball: "Pickleball",
  badminton: "Badminton",
  tennis: "Tennis",
  padel: "Padel",
  squash: "Squash",
  table_tennis: "Table tennis",
};

const DEFAULT_CENTER = { latitude: 12.9698, longitude: 77.7499 };
const BENGALURU_AREAS: Record<string, { latitude: number; longitude: number }> = {
  Whitefield: { latitude: 12.9698, longitude: 77.7499 },
  Brookefield: { latitude: 12.9665, longitude: 77.7168 },
  Varthur: { latitude: 12.9408, longitude: 77.746 },
  Marathahalli: { latitude: 12.9569, longitude: 77.7011 },
  Indiranagar: { latitude: 12.9784, longitude: 77.6408 },
  Koramangala: { latitude: 12.9352, longitude: 77.6245 },
  "HSR Layout": { latitude: 12.9116, longitude: 77.6389 },
  Bellandur: { latitude: 12.9255, longitude: 77.6762 },
  Sarjapur: { latitude: 12.9279, longitude: 77.6271 },
  Kadubeesanahalli: { latitude: 12.9358, longitude: 77.69 },
};
const badgeLabels: Record<NonNullable<LeaderboardEntry["badge"]>, string> = {
  best_quality: "Best quality",
  most_improved: "Most improved",
  most_reliable: "Most reliable",
  fastest_growing: "Fastest growing",
};

let mapsLoaderPromise: Promise<void> | null = null;
function loadGoogleMapsScript(apiKey: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (typeof (window as unknown as { google?: { maps?: { Map?: unknown } } }).google?.maps?.Map === "function") {
    return Promise.resolve();
  }
  if (mapsLoaderPromise) return mapsLoaderPromise;

  mapsLoaderPromise = new Promise<void>((resolve, reject) => {
    const callbackName = `__courtmate_gmaps_callback_${Date.now()}`;
    (window as unknown as Record<string, unknown>)[callbackName] = () => {
      delete (window as unknown as Record<string, unknown>)[callbackName];
      resolve();
    };

    const existing = document.querySelector<HTMLScriptElement>("script[data-courtmate-gmaps]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Maps script failed to load")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=maps,marker&callback=${callbackName}&loading=async&v=weekly`;
    script.async = true;
    script.defer = true;
    script.dataset.courtmateGmaps = "true";
    script.onerror = () => {
      mapsLoaderPromise = null;
      reject(new Error("Google Maps script failed to load"));
    };
    document.head.appendChild(script);
  });

  return mapsLoaderPromise;
}

function GoogleDensityMap({
  points,
  games,
  clusters,
  center,
  radiusKm,
  selectedArea,
  onMapMove,
  onSelectCluster,
  onSelectGame,
}: {
  points: DensityPoint[];
  communities: MapCommunity[];
  games: NearbyGame[];
  clusters: MapCluster[];
  center: { latitude: number; longitude: number };
  radiusKm: number;
  selectedPoint: DensityPoint | null;
  selectedArea: string | null;
  onMapMove: (center: { latitude: number; longitude: number }) => void;
  onSelect: (point: DensityPoint) => void;
  onSelectCommunity: (community: MapCommunity) => void;
  onSelectCluster: (cluster: MapCluster) => void;
  onSelectGame: (game: NearbyGame, gameIds?: string[]) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const circleInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  const onSelectClusterRef = useRef(onSelectCluster);
  const onSelectGameRef = useRef(onSelectGame);
  const onMapMoveRef = useRef(onMapMove);
  const mapDraggedRef = useRef(false);
  onSelectClusterRef.current = onSelectCluster;
  onSelectGameRef.current = onSelectGame;
  onMapMoveRef.current = onMapMove;

  const mapKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    if (!mapKey || !mapRef.current) {
      if (!mapKey) setMapError("Interactive map is unavailable right now.");
      return;
    }
    let cancelled = false;
    setMapError(null);

    loadGoogleMapsScript(mapKey)
      .then(async () => {
        if (cancelled || !mapRef.current) return;
        const googleMaps = (window as unknown as { google: { maps: any } }).google.maps;
        if (!googleMaps) throw new Error("Google Maps namespace is unavailable");

        let MapConstructor = googleMaps.Map;
        let CircleConstructor = googleMaps.Circle;
        let AdvancedMarkerElement: any = null;
        let LegacyMarkerConstructor = googleMaps.Marker;
        try {
          if (typeof googleMaps.importLibrary === "function") {
            const mapsLib = await googleMaps.importLibrary("maps");
            MapConstructor = mapsLib.Map ?? MapConstructor;
            CircleConstructor = mapsLib.Circle ?? CircleConstructor;
            const markerLib = await googleMaps.importLibrary("marker");
            AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
            LegacyMarkerConstructor = markerLib.Marker ?? LegacyMarkerConstructor;
          }
        } catch {
          // Fallback to standard marker
        }

        if (cancelled || !mapRef.current) return;
        if (typeof MapConstructor !== "function") {
          throw new Error("Google Maps Map constructor is unavailable");
        }

        if (!mapInstanceRef.current) {
          const map = new MapConstructor(mapRef.current, {
            center: { lat: center.latitude, lng: center.longitude },
            zoom: Math.max(9, Math.min(14, Math.round(14 - Math.log2(radiusKm / 5)))),
            mapId: "DEMO_MAP_ID",
            streetViewControl: false,
            mapTypeControl: false,
            fullscreenControl: false,
            zoomControl: true,
            clickableIcons: false,
            gestureHandling: "greedy",
            styles: [
              { featureType: "poi", stylers: [{ visibility: "simplified" }] },
              { featureType: "transit", stylers: [{ visibility: "off" }] },
            ],
          });
          mapInstanceRef.current = map;

          map.addListener("dragstart", () => {
            mapDraggedRef.current = true;
          });
          map.addListener("idle", () => {
            if (!mapDraggedRef.current) return;
            mapDraggedRef.current = false;
            const nextCenter = map.getCenter?.();
            if (!nextCenter) return;
            onMapMoveRef.current({ latitude: nextCenter.lat(), longitude: nextCenter.lng() });
          });

          if (typeof CircleConstructor === "function") {
            const circle = new CircleConstructor({
              map,
              center: { lat: center.latitude, lng: center.longitude },
              radius: radiusKm * 1000,
              fillColor: "#d7f23f",
              fillOpacity: 0.12,
              strokeColor: "#90a91c",
              strokeOpacity: 0.85,
              strokeWeight: 2,
            });
            circleInstanceRef.current = circle;
          }
        } else {
          mapInstanceRef.current.setCenter({ lat: center.latitude, lng: center.longitude });
          mapInstanceRef.current.setZoom(Math.max(9, Math.min(14, Math.round(14 - Math.log2(radiusKm / 5)))));
          if (circleInstanceRef.current) {
            circleInstanceRef.current.setCenter({ lat: center.latitude, lng: center.longitude });
            circleInstanceRef.current.setRadius(radiusKm * 1000);
          }
        }

        markersRef.current.forEach((marker) => {
          if (marker && typeof marker.setMap === "function") marker.setMap(null);
          else if (marker && marker.map) marker.map = null;
        });
        markersRef.current = [];

        const map = mapInstanceRef.current;

        const createMarker = (
          position: { lat: number; lng: number },
          title: string,
          badgeText: string,
          bgColor: string,
          textColor: string,
          size: number,
          isCurrentLocation = false,
          isSelected = false,
        ) => {
          if (AdvancedMarkerElement) {
            const content = document.createElement("div");
            content.className = `custom-map-pin ${isSelected ? "selected" : ""}`;
            content.style.cssText = `
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transform: translate(-50%, -50%);
              transition: transform 0.15s ease;
            `;

            const badge = document.createElement("div");
            badge.style.cssText = `
              display: grid;
              place-items: center;
              width: ${size}px;
              height: ${size}px;
              border-radius: 50%;
              background: ${bgColor};
              color: ${textColor};
              border: ${isSelected ? "3px solid #17231f" : "2px solid #d7f23f"};
              box-shadow: 0 4px 12px rgba(0,0,0,0.25);
              font: 800 ${Math.max(11, Math.round(size * 0.42))}px/1 'DM Mono', monospace, sans-serif;
              box-sizing: border-box;
            `;
            badge.textContent = badgeText;
            content.appendChild(badge);

            if (!isCurrentLocation && badgeText) {
              const label = document.createElement("div");
              label.style.cssText = `
                margin-top: 3px;
                padding: 2px 6px;
                background: #17231f;
                color: #ffffff;
                border-radius: 4px;
                font: 700 9px/1 'DM Mono', monospace, sans-serif;
                white-space: nowrap;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                pointer-events: none;
              `;
              label.textContent = `${badgeText} ${Number(badgeText) === 1 ? "game" : "games"}`;
              content.appendChild(label);
            }

            const marker = new AdvancedMarkerElement({
              map,
              position,
              title,
              content,
            });
            return marker;
          }

          if (typeof LegacyMarkerConstructor !== "function") {
            throw new Error("Google Maps marker constructor is unavailable");
          }
          return new LegacyMarkerConstructor({
            map,
            position,
            title,
            label: badgeText ? { text: badgeText, color: textColor, fontWeight: "800" } : undefined,
            icon: {
              path: googleMaps.SymbolPath.CIRCLE,
              fillColor: bgColor,
              fillOpacity: 1,
              strokeColor: "#d7f23f",
              strokeWeight: 2,
              scale: size / 2,
            },
          });
        };

        const centerMarker = createMarker(
          { lat: center.latitude, lng: center.longitude },
          "Your location",
          "",
          "#17231f",
          "#ffffff",
          18,
          true,
        );
        markersRef.current.push(centerMarker);

        const visibleClusters = clusters.filter((cluster) =>
          cluster.game_ids.some((id) => games.some((game) => game.id === id)),
        );

        visibleClusters.forEach((cluster) => {
          if (cluster.latitude == null || cluster.longitude == null) return;
          const isSelected = selectedArea?.trim().toLowerCase() === cluster.area.trim().toLowerCase();
          const marker = createMarker(
            { lat: cluster.latitude, lng: cluster.longitude },
            `${cluster.game_count} active games in ${cluster.area}`,
            String(cluster.game_count),
            isSelected ? "#d7f23f" : "#17231f",
            isSelected ? "#17231f" : "#ffffff",
            44,
            false,
            isSelected,
          );

          if (marker.addListener) {
            marker.addListener("click", () => {
              onSelectClusterRef.current(cluster);
            });
          } else if (marker.element) {
            marker.element.addEventListener("click", () => {
              onSelectClusterRef.current(cluster);
            });
          }
          markersRef.current.push(marker);
        });

        games.forEach((game) => {
          if (
            game.latitude == null ||
            game.longitude == null ||
            visibleClusters.some((cluster) => cluster.game_ids.includes(game.id))
          ) {
            return;
          }
          const marker = createMarker(
            { lat: game.latitude, lng: game.longitude },
            `${game.group_name}: ${game.open_slots} spots open`,
            "1",
            "#90a91c",
            "#17231f",
            28,
          );
          if (marker.addListener) {
            marker.addListener("click", () => onSelectGameRef.current(game, [game.id]));
          } else if (marker.element) {
            marker.element.addEventListener("click", () => onSelectGameRef.current(game, [game.id]));
          }
          markersRef.current.push(marker);
        });

        if (!cancelled) {
          setMapError(null);
          setMapReady(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMapReady(false);
          setMapError("Interactive map is unavailable right now. Nearby games are still listed below.");
        }
        console.error("CourtMate Google Maps initialization notice:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [mapKey, center.latitude, center.longitude, radiusKm, games, clusters, points, selectedArea]);

  if (!mapKey) {
    return (
      <div className="google-density-map-status" role="status">
        <strong>Interactive map unavailable</strong>
        <span>Nearby games are still listed below.</span>
      </div>
    );
  }

  return (
    <>
      <div
        className={`google-density-map ${mapReady ? "is-ready" : ""}`}
        ref={mapRef}
        aria-label="Google Maps active games radar"
      />
      {mapError && (
        <div className="google-density-map-status" role="status">
          <strong>Interactive map unavailable</strong>
          <span>{mapError.replace("Interactive map is unavailable right now. ", "")}</span>
        </div>
      )}
    </>
  );
}

export function CommunityHub({
  apiUrl,
  authorizedFetch,
  currentCmr,
  requestedSessionIds = [],
  joinedSessionIds = [],
  onOpenExistingGame,
  onOpenRallyCircle,
  onRequestJoin,
  isGuest = false,
  onSignIn,
  initialLatitude,
  initialLongitude,
  initialArea = "Whitefield",
}: CommunityHubProps) {
  const authorizedFetchRef = useRef(authorizedFetch);
  authorizedFetchRef.current = authorizedFetch;
  const apiScope = isGuest ? "public" : "me";

  const [sportFilter, setSportFilter] = useState<SportFilter>("all");
  const [radiusKm, setRadiusKm] = useState(50);
  const [visibilityFilter, setVisibilityFilter] = useState<MapVisibilityFilter>("all");
  const [mapRefresh, setMapRefresh] = useState(1);
  const [hasSearched, setHasSearched] = useState(true);
  const [cmrOnly, setCmrOnly] = useState(false);

  const [densityPoints, setDensityPoints] = useState<DensityPoint[]>([]);
  const [densityLoading, setDensityLoading] = useState(false);
  const [densityError, setDensityError] = useState("");
  const [nearbyGamesState, setNearbyGamesState] = useState<NearbyGame[]>([]);
  const [mapCommunities, setMapCommunities] = useState<MapCommunity[]>([]);
  const [mapClusters, setMapClusters] = useState<MapCluster[]>([]);
  const [selectedGame, setSelectedGameState] = useState<NearbyGame | null>(null);
  const [selectedMapArea, setSelectedMapArea] = useState<string | null>(null);
  const [selectedGameIds, setSelectedGameIds] = useState<string[] | null>(null);
  const [requestingGameId, setRequestingGameId] = useState<string | null>(null);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);

  const [location, setLocation] = useState<{ latitude: number; longitude: number }>(
    initialLatitude != null && initialLongitude != null
      ? { latitude: initialLatitude, longitude: initialLongitude }
      : DEFAULT_CENTER,
  );
  const [locationState, setLocationState] = useState<"saved" | "detecting" | "fallback">(
    initialLatitude != null && initialLongitude != null ? "saved" : "fallback",
  );
  const [areaFilter, setAreaFilter] = useState(
    Object.prototype.hasOwnProperty.call(BENGALURU_AREAS, initialArea) ? initialArea : "Whitefield",
  );

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedPoint, setSelectedPoint] = useState<DensityPoint | null>(null);
  const gesture = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const manualAreaRef = useRef(false);

  useEffect(() => {
    if (initialLatitude != null && initialLongitude != null) return;
    if (!navigator.geolocation) {
      setLocation(DEFAULT_CENTER);
      setLocationState("fallback");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!manualAreaRef.current) {
          setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude });
          setLocationState("saved");
        }
      },
      () => {
        if (!manualAreaRef.current) {
          setLocation(DEFAULT_CENTER);
          setLocationState("fallback");
        }
      },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 },
    );
  }, [initialLatitude, initialLongitude]);

  useEffect(() => {
    let cancelled = false;
    setDensityLoading(true);
    setDensityError("");

    const params = new URLSearchParams({
      sport: sportFilter,
      radius_km: radiusKm.toString(),
      activity_type: "all",
      area: areaFilter,
    });
    if (!isGuest) params.set("visibility_filter", visibilityFilter);
    if (location) {
      params.set("latitude", location.latitude.toString());
      params.set("longitude", location.longitude.toString());
    }
    if (cmrOnly && currentCmr != null) {
      params.set("cmr_min", Math.max(1, currentCmr - 1.8).toFixed(2));
      params.set("cmr_max", Math.min(10, currentCmr + 1.8).toFixed(2));
    }

    const loadLegacyMap = async () => {
      if (isGuest) throw new Error("Public map unavailable");
      const legacyParams = new URLSearchParams({ sport: sportFilter === "all" ? "tennis" : sportFilter, radius_km: radiusKm.toString() });
      if (location) {
        legacyParams.set("latitude", location.latitude.toString());
        legacyParams.set("longitude", location.longitude.toString());
      }
      const [densityResponse, exploreResponse] = await Promise.all([
        authorizedFetchRef.current(`${apiUrl}/v1/me/player-density?${legacyParams}`),
        authorizedFetchRef.current(`${apiUrl}/v1/me/explore`),
      ]);
      if (!densityResponse.ok || !exploreResponse.ok) throw new Error();
      const densityPayload = (await densityResponse.json()) as { points: DensityPoint[] };
      const explorePayload = (await exploreResponse.json()) as {
        recommendations: {
          session: Omit<NearbyGame, "open_slots" | "match_score"> & {
            capacity: number;
            confirmed_player_ids: string[];
          };
        }[];
      };
      return {
        player_density: densityPayload.points,
        community_activity: [],
        game_clusters: [],
        nearby_games: explorePayload.recommendations.map(({ session }) => ({
          ...session,
          open_slots: Math.max(0, session.capacity - session.confirmed_player_ids.length),
          match_score: 50,
        })),
      };
    };

    void authorizedFetchRef
      .current(`${apiUrl}/v1/${apiScope}/community-map?${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{
          player_density: DensityPoint[];
          community_activity: MapCommunity[];
          game_clusters: MapCluster[];
          nearby_games: NearbyGame[];
        }>;
      })
      .catch(() => loadLegacyMap())
      .then((payload) => {
        if (!cancelled) {
          setDensityPoints(payload.player_density || []);
          setMapCommunities(payload.community_activity || []);
          setMapClusters(payload.game_clusters || []);
          setNearbyGamesState(payload.nearby_games || []);
          setSelectedPoint(null);
          setSelectedGameState(null);
          setSelectedMapArea(null);
          setSelectedGameIds(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDensityError("Community map is temporarily unavailable");
          setDensityPoints([]);
          setMapCommunities([]);
          setMapClusters([]);
          setNearbyGamesState([]);
        }
      })
      .finally(() => {
        if (!cancelled) setDensityLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl, apiScope, isGuest, mapRefresh, sportFilter, radiusKm, visibilityFilter, areaFilter, location.latitude, location.longitude, cmrOnly, currentCmr]);

  useEffect(() => {
    let cancelled = false;
    if (sportFilter === "all") {
      setLeaderboard([]);
      setLeaderboardLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLeaderboardLoading(true);
    const params = new URLSearchParams({ sport: sportFilter });
    if (initialArea) params.set("area", initialArea);

    void authorizedFetchRef
      .current(`${apiUrl}/v1/${apiScope}/community-leaderboard?${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ entries: LeaderboardEntry[] }>;
      })
      .then((payload) => {
        if (!cancelled) setLeaderboard(payload.entries || []);
      })
      .catch(() => {
        if (!cancelled) setLeaderboard([]);
      })
      .finally(() => {
        if (!cancelled) setLeaderboardLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl, apiScope, sportFilter, initialArea]);

  useEffect(() => {
    let cancelled = false;
    if (!facilitiesOpen) return () => { cancelled = true; };
    if (sportFilter === "all") {
      setFacilities([]);
      setFacilitiesLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setFacilitiesLoading(true);
    const params = new URLSearchParams({ sport: sportFilter });
    if (initialArea) params.set("area", initialArea);

    void authorizedFetchRef
      .current(`${apiUrl}/v1/${apiScope}/venues?${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ facilities: Facility[] }>;
      })
      .then((payload) => {
        if (!cancelled) setFacilities(payload.facilities || []);
      })
      .catch(() => {
        if (!cancelled) setFacilities([]);
      })
      .finally(() => {
        if (!cancelled) setFacilitiesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl, apiScope, sportFilter, initialArea, facilitiesOpen]);

  const center = location ?? DEFAULT_CENTER;

  const handleMapMove = (nextCenter: { latitude: number; longitude: number }) => {
    if (Math.abs(nextCenter.latitude - center.latitude) < 0.001 && Math.abs(nextCenter.longitude - center.longitude) < 0.001) return;
    let nearestArea = areaFilter;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [area, coordinates] of Object.entries(BENGALURU_AREAS)) {
      const distance = Math.hypot(nextCenter.latitude - coordinates.latitude, nextCenter.longitude - coordinates.longitude);
      if (distance < nearestDistance) {
        nearestArea = area;
        nearestDistance = distance;
      }
    }
    manualAreaRef.current = true;
    setLocation(nextCenter);
    setAreaFilter(nearestArea);
    setLocationState("fallback");
    setSelectedGameState(null);
    setSelectedMapArea(null);
    setSelectedGameIds(null);
  };

  const isRequested = (sessionId: string) => requestedSessionIds.includes(sessionId);
  const isJoined = (sessionId: string) => joinedSessionIds.includes(sessionId);

  const handleSelectCluster = (cluster: MapCluster) => {
    setSelectedMapArea(cluster.area);
    setSelectedGameIds(cluster.game_ids);
    const firstGame = nearbyGamesState.find((candidate) => cluster.game_ids.includes(candidate.id)) ?? null;
    setSelectedGameState(firstGame);
    const point = densityPoints.find((p) => p.area.toLowerCase() === cluster.area.toLowerCase()) ?? null;
    setSelectedPoint(point);
  };

  const handleSelectGame = (game: NearbyGame, gameIds: string[] = [game.id]) => {
    setSelectedGameState(game);
    setSelectedMapArea(game.area);
    setSelectedGameIds(gameIds);
  };

  const handleGameAction = async (game: NearbyGame) => {
    if (isGuest) {
      onSignIn?.();
      return;
    }
    if (isRequested(game.id)) {
      onOpenExistingGame?.(game.id, "pending");
      return;
    }
    if (isJoined(game.id)) {
      onOpenExistingGame?.(game.id, "joined");
      return;
    }

    if (onRequestJoin) {
      setRequestingGameId(game.id);
      try {
        await onRequestJoin(game);
      } finally {
        setRequestingGameId(null);
      }
      return;
    }

    // Default inline fallback join
    setRequestingGameId(game.id);
    try {
      const response = await authorizedFetchRef.current(`${apiUrl}/v1/sessions/${game.id}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(errorPayload.detail ?? "Join request failed");
      }
      onOpenExistingGame?.(game.id, "pending");
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not request to join");
    } finally {
      setRequestingGameId(null);
    }
  };

  const displayedGames = selectedGameIds
    ? nearbyGamesState.filter((game) => selectedGameIds.includes(game.id))
    : selectedMapArea
    ? nearbyGamesState.filter((game) => game.area.trim().toLowerCase() === selectedMapArea.trim().toLowerCase())
    : nearbyGamesState;

  const project = (point: DensityPoint) => {
    if (point.latitude == null || point.longitude == null) return { x: 200, y: 130 };
    const xKm = (point.longitude - center.longitude) * 111.32 * Math.cos((center.latitude * Math.PI) / 180);
    const yKm = (center.latitude - point.latitude) * 111.32;
    return { x: 200 + (xKm / radiusKm) * 100, y: 130 + (yKm / radiusKm) * 100 };
  };

  const startPan = (event: PointerEvent<SVGSVGElement>) => {
    gesture.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: PointerEvent<SVGSVGElement>) => {
    if (!gesture.current) return;
    setPan({
      x: gesture.current.panX + (event.clientX - gesture.current.x) / 2,
      y: gesture.current.panY + (event.clientY - gesture.current.y) / 2,
    });
  };

  return (
    <section className="community-page" aria-label="Nearby games and community activity">
      <section className="player-density-card" aria-labelledby="player-density-title">
        <div className="density-heading">
          <div>
            <span className="kicker">LIVE COMMUNITY RADAR</span>
            <h2 id="player-density-title">Active games near you</h2>
            <p>
              {nearbyGamesState.length
                ? `${nearbyGamesState.length} ${!isGuest && visibilityFilter === "friends" ? "connection" : visibilityFilter === "public" || isGuest ? "public" : "visible"} ${labels[sportFilter].toLowerCase()} game${nearbyGamesState.length === 1 ? "" : "s"} within ${radiusKm} km`
                : `Find active ${labels[sportFilter].toLowerCase()} games within ${radiusKm} km`}
            </p>
          </div>
          <div className="density-heading-side">
            <div className="radar-selectors">
              <select
                value={sportFilter}
                onChange={(event) => {
                  setSportFilter(event.target.value as SportFilter);
                  setSelectedGameState(null);
                  setSelectedMapArea(null);
                  setSelectedGameIds(null);
                }}
                aria-label="Choose sport"
              >
                <option value="all">All sports</option>
                {Object.entries(labels).map(([value, label]) => (
                  value !== "all" &&
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>

              <select
                value={radiusKm}
                onChange={(event) => {
                  setRadiusKm(Number(event.target.value));
                  setSelectedGameState(null);
                }}
                aria-label="Choose map radius"
              >
                <option value="5">Within 5 km</option>
                <option value="10">Within 10 km</option>
                <option value="20">Within 20 km</option>
                <option value="35">Within 35 km</option>
                <option value="50">Within 50 km</option>
              </select>

              {!isGuest && (
                <select
                  value={visibilityFilter}
                  onChange={(event) => {
                    setVisibilityFilter(event.target.value as MapVisibilityFilter);
                    setSelectedGameState(null);
                    setSelectedMapArea(null);
                    setSelectedGameIds(null);
                  }}
                  aria-label="Choose game visibility"
                >
                  <option value="all">All games</option>
                  <option value="public">Public only</option>
                  <option value="friends">Friends</option>
                </select>
              )}

              <select
                value={areaFilter}
                onChange={(event) => {
                  const nextArea = event.target.value;
                  manualAreaRef.current = true;
                  setAreaFilter(nextArea);
                  setLocation(BENGALURU_AREAS[nextArea] || DEFAULT_CENTER);
                  setLocationState("fallback");
                  setSelectedGameState(null);
                  setSelectedMapArea(null);
                  setSelectedGameIds(null);
                }}
                aria-label="Choose Bengaluru area"
              >
                {Object.keys(BENGALURU_AREAS).map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="radar-search-button"
                onClick={() => {
                  setHasSearched(true);
                  setSelectedGameState(null);
                  setSelectedMapArea(null);
                  setSelectedGameIds(null);
                  setMapRefresh((value) => value + 1);
                }}
              >
                Search games
              </button>
              {!isGuest && currentCmr != null && <button type="button" className={`radar-cmr-toggle ${cmrOnly ? "active" : ""}`} onClick={() => setCmrOnly((enabled) => !enabled)} aria-label="Filter games by my CMR" aria-pressed={cmrOnly}><span>CMR fit</span><i aria-hidden="true" /></button>}
            </div>
            <div className="map-data-legend">
              <span>
                <i className="legend-dot games" /> Active games
              </span>
              <span>
                <i className="legend-dot community" /> Game clusters (tap to view)
              </span>
            </div>
          </div>
        </div>

        {!hasSearched ? (
          <div className="density-map-empty">
            Choose your sport, radius, and area, then press Search games to find nearby activity.
          </div>
        ) : densityLoading ? (
          <div className="density-map-loading">Scanning {radiusKm} km around you...</div>
        ) : (
          <>
            <div className="density-map-shell">
              <div className="density-map-toolbar">
                <span>
                  {locationState === "fallback" ? `Showing around ${areaFilter || initialArea}` : "Your approximate location"}
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => setZoom((value) => Math.min(2.4, Number((value + 0.2).toFixed(1))))}
                    aria-label="Zoom in"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom((value) => Math.max(0.7, Number((value - 0.2).toFixed(1))))}
                    aria-label="Zoom out"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                    aria-label="Reset map"
                  >
                    Reset
                  </button>
                </div>
              </div>

              <GoogleDensityMap
                points={densityPoints}
                communities={mapCommunities}
                games={nearbyGamesState}
                clusters={mapClusters}
                center={center}
                radiusKm={radiusKm}
                selectedPoint={selectedPoint}
                selectedArea={selectedMapArea}
                onMapMove={handleMapMove}
                onSelect={setSelectedPoint}
                onSelectCommunity={(community) =>
                  setSelectedPoint(densityPoints.find((point) => point.area === community.area) ?? null)
                }
                onSelectCluster={handleSelectCluster}
                onSelectGame={handleSelectGame}
              />

              <svg
                className="density-map-svg"
                viewBox="0 0 400 260"
                role="img"
                aria-label={`${labels[sportFilter]} player density within ${radiusKm} kilometres`}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={() => {
                  gesture.current = null;
                }}
                onPointerCancel={() => {
                  gesture.current = null;
                }}
                onWheel={(event) => {
                  setZoom((value) =>
                    Math.max(0.7, Math.min(2.4, Number((value + (event.deltaY < 0 ? 0.2 : -0.2)).toFixed(1)))),
                  );
                }}
              >
                <g transform={`translate(${pan.x} ${pan.y}) translate(200 130) scale(${zoom}) translate(-200 -130)`}>
                  <circle className="density-radius-ring outer" cx="200" cy="130" r="100" />
                  <circle className="density-radius-ring inner" cx="200" cy="130" r="50" />
                  <line className="density-map-crosshair" x1="200" y1="20" x2="200" y2="240" />
                  <line className="density-map-crosshair" x1="90" y1="130" x2="310" y2="130" />
                  <circle className="density-current-location" cx="200" cy="130" r="7" />
                  <circle className="density-current-pulse" cx="200" cy="130" r="13" />
                  {densityPoints.map((point) => {
                    const position = project(point);
                    return (
                      <g
                        className={`density-hotspot-svg ${selectedPoint?.area === point.area ? "selected" : ""}`}
                        key={point.area}
                        transform={`translate(${position.x} ${position.y})`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          setSelectedPoint(point);
                          setSelectedMapArea(point.area);
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`${point.area}, ${point.player_count} players`}
                      >
                        <circle
                          className={`density-hotspot-circle ${point.intensity}`}
                          r={point.intensity === "very_hot" ? 27 : point.intensity === "hot" ? 23 : 19}
                        />
                        <text className="density-hotspot-count" y="3">
                          {point.player_count}
                        </text>
                        <text className="density-hotspot-area" y="41">
                          {point.area}
                        </text>
                      </g>
                    );
                  })}
                </g>
                <text className="density-radius-label" x="205" y="24">
                  {radiusKm} km radius
                </text>
              </svg>
            </div>

            {selectedMapArea && (
              <div className="map-selected-game">
                <div>
                  <strong>Showing games in {selectedMapArea}</strong>
                  <span>{displayedGames.length} active match{displayedGames.length === 1 ? "" : "es"} found in this cluster</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedMapArea(null);
                    setSelectedGameIds(null);
                    setSelectedGameState(null);
                  }}
                >
                  Show all nearby games
                </button>
              </div>
            )}

            {displayedGames.length > 0 && (
              <section className="map-game-list" aria-labelledby="nearby-games-title">
                <div className="map-game-list-heading">
                  <div>
                    <span className="kicker">{!isGuest && visibilityFilter === "friends" ? "FRIEND GAMES NEARBY" : "GAMES NEARBY"}</span>
                    <h3 id="nearby-games-title">
                      {selectedMapArea ? `Games in ${selectedMapArea}` : "Games happening around you"}
                    </h3>
                  </div>
                  <span>{displayedGames.length} available</span>
                </div>
                {displayedGames.slice(0, 10).map((game) => (
                  <article className="map-game-row" key={game.id}>
                    <div>
                      <strong>{game.group_name}</strong>
                      <small>
                        {game.area}
                        {game.venue_name ? ` · ${game.venue_name}` : ""} · {game.session_date} · {game.start_time}–{game.end_time}
                      </small>
                      <small>
                        {game.open_slots} {game.open_slots === 1 ? "spot" : "spots"} open · {Math.round(game.match_score)}% match fit
                      </small>
                      {game.is_connection_game && <small className="map-game-connection">From a connection</small>}
                    </div>
                    <div className="map-game-actions">
                      <button
                        type="button"
                        className={
                          isRequested(game.id)
                            ? "is-requested"
                            : isJoined(game.id)
                            ? "is-joined"
                            : "is-open"
                        }
                        onClick={() => void handleGameAction(game)}
                        disabled={requestingGameId === game.id}
                      >
                        {isGuest
                          ? "Log in to join →"
                          : requestingGameId === game.id
                          ? "Requesting..."
                          : isRequested(game.id)
                          ? "Pending request →"
                          : isJoined(game.id)
                          ? "In your games →"
                          : game.open_slots > 0
                          ? "Request to join →"
                          : "Join waitlist →"}
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}
          </>
        )}

        <p className="density-privacy-note">
          Only aggregated neighborhoods are shown. Individual player locations are never shared.
        </p>
      </section>

      <section className="community-leaderboard" aria-labelledby="community-leaderboard-title">
        <div className="density-heading">
          <div>
            <span className="kicker">COMMUNITY LEADERBOARD</span>
            <h2 id="community-leaderboard-title">
              Top {initialArea ? `${initialArea} ` : "nearby "}
              {labels[sportFilter]} circles
            </h2>
            <p>Quality over popularity: circles are ranked by the games people want to play again.</p>
          </div>
        </div>
        <div className="leaderboard-explainer">
          <strong>How the score works</strong>
          <span>Match quality 35%</span>
          <span>Feedback 20%</span>
          <span>Repeat play 20%</span>
          <span>Reliability 15%</span>
          <span>CMR improvement 10%</span>
          <small>Minimum to qualify: 3 completed games and 5 player ratings.</small>
        </div>
        {leaderboardLoading ? (
          <div className="leaderboard-loading">Updating community scores...</div>
        ) : leaderboard.length ? (
          <div className="leaderboard-list">
            {leaderboard.slice(0, 5).map((entry) => (
              <article className="leaderboard-row" key={entry.community_id}>
                <span className="leaderboard-rank">{entry.rank}</span>
                <div>
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.completed_games} games · {Math.round(entry.average_match_quality * 20)}% match quality ·{" "}
                    {Math.round(entry.average_reliability * 100)}% reliable
                  </small>
                </div>
                <div className="leaderboard-score">
                  <b>
                    {entry.quality_score}
                    <em>/100</em>
                  </b>
                  <small>{entry.badge ? badgeLabels[entry.badge] : "Quality score"}</small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="leaderboard-empty">
            Circles appear after 3 completed games and 5 submitted player ratings.
          </div>
        )}
      </section>

      <details
        className="facility-section facility-directory"
        open={facilitiesOpen}
        onToggle={(event) => setFacilitiesOpen(event.currentTarget.open)}
      >
        <summary className="facility-directory-summary">
          <span>
            <span className="kicker">COURTS NEAR YOUR CIRCLE</span>
            <strong>Where to play {labels[sportFilter].toLowerCase()}</strong>
            <small>Curated facilities near {initialArea}. Open to see booking details.</small>
          </span>
          <span className="facility-directory-count">
            {facilities.length || ""}
            <b aria-hidden="true">+</b>
          </span>
        </summary>
        <div className="facility-directory-content">
          {facilitiesLoading ? (
            <div className="leaderboard-loading">Finding courts...</div>
          ) : facilities.length ? (
            <div className="facility-list">
              {facilities.slice(0, 5).map((facility) => (
                <article className="facility-row" key={facility.id}>
                  <div>
                    <strong>{facility.name}</strong>
                    <small>
                      {facility.area} · {facility.booking_method}
                    </small>
                  </div>
                  <div className="facility-actions">
                    {facility.phone && (
                      <a href={`tel:${facility.phone.replaceAll(" ", "")}`} aria-label={`Call ${facility.name}`}>
                        Call
                      </a>
                    )}
                    {facility.booking_url && (
                      <a href={facility.booking_url} target="_blank" rel="noreferrer">
                        Book <span>↗</span>
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="leaderboard-empty">No curated {labels[sportFilter].toLowerCase()} courts found yet.</div>
          )}
        </div>
      </details>
    </section>
  );
}
