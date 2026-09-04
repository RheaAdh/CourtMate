"use client";

import { PointerEvent, useEffect, useEffectEvent, useRef, useState } from "react";

import { TennisBallLoader } from "./tennis-ball-loader";

type Sport = "pickleball" | "badminton" | "tennis" | "padel" | "squash" | "table_tennis";
type SportFilter = Sport | "all";
type MapVisibilityFilter = "all" | "public" | "friends";

type AppliedMapQuery = {
  sport: SportFilter;
  radiusKm: number;
  visibility: MapVisibilityFilter;
  area: string;
  location: { latitude: number; longitude: number };
};

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

export type CommunityHubProps = {
  apiUrl: string;
  authorizedFetch: (input: string, init?: RequestInit) => Promise<Response>;
  gamesLogged: number;
  requestedSessionIds?: string[];
  recentlyRequestedSessionId?: string | null;
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

function formatGameDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(
    new Date(year, month - 1, day),
  );
}

function formatGameTime(value: string) {
  return value.slice(0, 5);
}

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
  onMapClick,
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
  onMapClick?: () => void;
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

  const selectCluster = useEffectEvent((cluster: MapCluster) => onSelectCluster(cluster));
  const selectGame = useEffectEvent((game: NearbyGame, gameIds?: string[]) => onSelectGame(game, gameIds));
  const selectMap = useEffectEvent(() => onMapClick?.());

  const mapKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    if (!mapKey || !mapRef.current) {
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
          });
          mapInstanceRef.current = map;

          map.addListener("click", () => selectMap());

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
              gmpClickable: true,
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

        const bindMarkerClick = (marker: any, handler: () => void) => {
          const markerContent = marker?.content;
          if (markerContent instanceof HTMLElement) {
            markerContent.addEventListener("click", (event) => {
              event.stopPropagation();
              handler();
            });
            markerContent.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              handler();
            });
            markerContent.tabIndex = 0;
            markerContent.setAttribute("role", "button");
            return;
          }
          if (typeof marker?.addListener === "function") {
            marker.addListener("click", handler);
          }
        };

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

          bindMarkerClick(marker, () => selectCluster(cluster));
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
          bindMarkerClick(marker, () => selectGame(game, [game.id]));
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
  requestedSessionIds = [],
  recentlyRequestedSessionId = null,
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
  useEffect(() => {
    authorizedFetchRef.current = authorizedFetch;
  }, [authorizedFetch]);
  const apiScope = isGuest ? "public" : "me";
  const initialLocation = initialLatitude != null && initialLongitude != null
    ? { latitude: initialLatitude, longitude: initialLongitude }
    : DEFAULT_CENTER;
  const initialAreaFilter = Object.prototype.hasOwnProperty.call(BENGALURU_AREAS, initialArea) ? initialArea : "Whitefield";

  const [sportFilter, setSportFilter] = useState<SportFilter>("all");
  const [radiusKm, setRadiusKm] = useState(50);
  const [visibilityFilter, setVisibilityFilter] = useState<MapVisibilityFilter>("all");
  const [mapRefresh, setMapRefresh] = useState(1);
  const [hasSearched, setHasSearched] = useState(true);
  const [mapLoaded, setMapLoaded] = useState(false);

  const [densityPoints, setDensityPoints] = useState<DensityPoint[]>([]);
  const [densityLoading, setDensityLoading] = useState(false);
  const [densityError, setDensityError] = useState("");
  const [nearbyGamesState, setNearbyGamesState] = useState<NearbyGame[]>([]);
  const [mapCommunities, setMapCommunities] = useState<MapCommunity[]>([]);
  const [mapClusters, setMapClusters] = useState<MapCluster[]>([]);
  const [selectedMapArea, setSelectedMapArea] = useState<string | null>(null);
  const [selectedGameIds, setSelectedGameIds] = useState<string[] | null>(null);
  const [requestingGameId, setRequestingGameId] = useState<string | null>(null);
  const mapCarouselRef = useRef<HTMLDivElement>(null);

  const [location, setLocation] = useState<{ latitude: number; longitude: number }>(initialLocation);
  const [locationState, setLocationState] = useState<"saved" | "detecting" | "fallback">(
    initialLatitude != null && initialLongitude != null ? "saved" : "fallback",
  );
  const [areaFilter, setAreaFilter] = useState(initialAreaFilter);
  const [mapQuery, setMapQuery] = useState<AppliedMapQuery>({
    sport: "all",
    radiusKm: 50,
    visibility: "all",
    area: initialAreaFilter,
    location: initialLocation,
  });

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedPoint, setSelectedPoint] = useState<DensityPoint | null>(null);
  const gesture = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const manualAreaRef = useRef(false);

  useEffect(() => {
    if (initialLatitude != null && initialLongitude != null) return;
    if (!navigator.geolocation) {
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!manualAreaRef.current) {
          setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude });
          setLocationState("saved");
        }
      },
      () => undefined,
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 },
    );
  }, [initialLatitude, initialLongitude]);

  useEffect(() => {
    let cancelled = false;
    setMapLoaded(false);
    setDensityLoading(true);
    setDensityError("");

    const params = new URLSearchParams({
      sport: mapQuery.sport,
      radius_km: mapQuery.radiusKm.toString(),
      activity_type: "all",
      area: mapQuery.area,
    });
    if (!isGuest) params.set("visibility_filter", mapQuery.visibility);
    params.set("latitude", mapQuery.location.latitude.toString());
    params.set("longitude", mapQuery.location.longitude.toString());

    const loadLegacyMap = async () => {
      if (isGuest) throw new Error("Public map unavailable");
      const legacyParams = new URLSearchParams({ sport: mapQuery.sport === "all" ? "tennis" : mapQuery.sport, radius_km: mapQuery.radiusKm.toString() });
      legacyParams.set("latitude", mapQuery.location.latitude.toString());
      legacyParams.set("longitude", mapQuery.location.longitude.toString());
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
          setMapLoaded(true);
          setSelectedPoint(null);
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
          setMapLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) setDensityLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl, apiScope, isGuest, mapQuery, mapRefresh]);

  const center = mapQuery.location;
  const noGamesFound = hasSearched && mapLoaded && !densityLoading && !densityError && nearbyGamesState.length === 0;

  const isRequested = (sessionId: string) =>
    sessionId === recentlyRequestedSessionId || requestedSessionIds.includes(sessionId);
  const isJoined = (sessionId: string) => joinedSessionIds.includes(sessionId);

  const revealSelectedGames = () => {
    if (window.matchMedia("(max-width: 700px)").matches) return;
    window.requestAnimationFrame(() => {
      document.getElementById("nearby-games-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const handleSelectCluster = (cluster: MapCluster) => {
    if (isGuest) {
      onSignIn?.();
      return;
    }
    setSelectedMapArea(cluster.area);
    setSelectedGameIds(cluster.game_ids);
    const point = densityPoints.find((p) => p.area.toLowerCase() === cluster.area.toLowerCase()) ?? null;
    setSelectedPoint(point);
    revealSelectedGames();
  };

  const handleSelectGame = (game: NearbyGame, gameIds: string[] = [game.id]) => {
    if (isGuest) {
      onSignIn?.();
      return;
    }
    setSelectedMapArea(game.area);
    setSelectedGameIds(gameIds);
    revealSelectedGames();
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

  const moveMapCarousel = (direction: -1 | 1) => {
    const carousel = mapCarouselRef.current;
    if (!carousel) return;
    carousel.scrollBy({ left: direction * carousel.clientWidth, behavior: "smooth" });
  };

  const project = (point: DensityPoint) => {
    if (point.latitude == null || point.longitude == null) return { x: 200, y: 130 };
    const xKm = (point.longitude - center.longitude) * 111.32 * Math.cos((center.latitude * Math.PI) / 180);
    const yKm = (center.latitude - point.latitude) * 111.32;
    return { x: 200 + (xKm / mapQuery.radiusKm) * 100, y: 130 + (yKm / mapQuery.radiusKm) * 100 };
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

  const applyMapSearch = () => {
    const nextLocation = manualAreaRef.current
      ? BENGALURU_AREAS[areaFilter] || DEFAULT_CENTER
      : location;
    setLocation(nextLocation);
    setLocationState(manualAreaRef.current ? "fallback" : "saved");
    setMapQuery({
      sport: sportFilter,
      radiusKm,
      visibility: visibilityFilter,
      area: areaFilter,
      location: nextLocation,
    });
    setHasSearched(true);
    setSelectedMapArea(null);
    setSelectedGameIds(null);
    setMapRefresh((value) => value + 1);
  };

  const mapControls = (
    <div className="density-heading-side map-filter-controls">
      <div className="radar-selectors">
        <select
          value={sportFilter}
          onChange={(event) => {
            setSportFilter(event.target.value as SportFilter);
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
            setSelectedMapArea(null);
            setSelectedGameIds(null);
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

        <button type="button" className="radar-search-button" onClick={applyMapSearch}>
          Search games
        </button>
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
  );

  return (
    <section className="community-page" aria-label="Nearby games and community activity">
      <section className="player-density-card" aria-labelledby="player-density-title">
        {!isGuest && (
          <div className="density-heading">
            <div>
              <span className="kicker">LIVE COMMUNITY RADAR</span>
              <h2 id="player-density-title">Active games near you</h2>
              <p>
                {nearbyGamesState.length
                  ? `${nearbyGamesState.length} ${mapQuery.visibility === "friends" ? "connection" : mapQuery.visibility === "public" ? "public" : "visible"} ${labels[mapQuery.sport].toLowerCase()} game${nearbyGamesState.length === 1 ? "" : "s"} within ${mapQuery.radiusKm} km`
                  : `Find active ${labels[mapQuery.sport].toLowerCase()} games within ${mapQuery.radiusKm} km`}
              </p>
            </div>
          </div>
        )}

        {!hasSearched ? (
          <div className="density-map-empty">
            Choose your sport, radius, and area, then press Search games to find nearby activity.
          </div>
        ) : densityLoading ? (
          <div className="density-map-loading">
            <TennisBallLoader compact label={`Scanning ${mapQuery.radiusKm} km around you...`} />
          </div>
        ) : (
          <>
            <div className="density-map-shell">
              <div className="density-map-toolbar">
                <span>
                  {locationState === "fallback" ? `Showing around ${mapQuery.area || initialArea}` : "Your approximate location"}
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
                radiusKm={mapQuery.radiusKm}
                selectedPoint={selectedPoint}
                selectedArea={selectedMapArea}
                onMapClick={isGuest ? onSignIn : undefined}
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
                aria-label={`${labels[mapQuery.sport]} player density within ${mapQuery.radiusKm} kilometres`}
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
                onClick={() => {
                  if (isGuest) onSignIn?.();
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
                        onClick={(event) => {
                          event.stopPropagation();
                          if (isGuest) {
                            onSignIn?.();
                            return;
                          }
                          setSelectedPoint(point);
                          setSelectedMapArea(point.area);
                          const areaGames = nearbyGamesState.filter((game) => game.area.trim().toLowerCase() === point.area.trim().toLowerCase());
                          setSelectedGameIds(areaGames.map((game) => game.id));
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
                  {mapQuery.radiusKm} km radius
                </text>
              </svg>
              {noGamesFound && (
                <div className="density-no-results" role="status">
                  <strong>No games found</strong>
                  <span>Try another sport, area, or radius.</span>
                </div>
              )}
              {!isGuest && selectedMapArea && (
                <aside className="map-game-sheet map-game-carousel" aria-live="polite" aria-label={`${displayedGames.length} games selected in ${selectedMapArea}`}>
                  <header className="map-game-carousel-header">
                    <div><span>{selectedMapArea}</span><strong>{displayedGames.length} active game{displayedGames.length === 1 ? "" : "s"}</strong></div>
                    {displayedGames.length > 1 && <nav aria-label="Browse selected games"><button type="button" onClick={() => moveMapCarousel(-1)} aria-label="Previous game">←</button><button type="button" onClick={() => moveMapCarousel(1)} aria-label="Next game">→</button></nav>}
                  </header>
                  {displayedGames.length ? <div className="map-game-carousel-track" ref={mapCarouselRef}>
                    {displayedGames.map((game, index) => <article className="map-game-carousel-card" key={game.id}>
                      <div><span>{labels[game.sport]} · {index + 1} of {displayedGames.length}</span><strong>{game.group_name}</strong><small>{game.session_date} · {game.start_time.slice(0, 5)}–{game.end_time.slice(0, 5)} · {game.open_slots} spot{game.open_slots === 1 ? "" : "s"}</small></div>
                      <button type="button" onClick={() => void handleGameAction(game)} disabled={requestingGameId === game.id}>{requestingGameId === game.id ? "Working..." : isJoined(game.id) ? "Open game" : isRequested(game.id) ? "View request" : "Join game"}</button>
                    </article>)}
                  </div> : <p className="map-game-carousel-empty">No active games in this circle. Try another circle or broaden the map filters.</p>}
                </aside>
              )}
            </div>

            {!isGuest && mapControls}

            {!isGuest && selectedMapArea && (
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
                  }}
                >
                  Show all nearby games
                </button>
              </div>
            )}

            {!isGuest && displayedGames.length > 0 && (
              <section className="map-game-list" aria-labelledby="nearby-games-title">
                <div className="map-game-list-heading">
                  <div>
                    <span className="kicker">{!isGuest && mapQuery.visibility === "friends" ? "FRIEND GAMES NEARBY" : "GAMES NEARBY"}</span>
                    <h3 id="nearby-games-title">
                      {selectedMapArea ? `Games in ${selectedMapArea}` : "Games happening around you"}
                    </h3>
                  </div>
                  <span className="map-game-count">{displayedGames.length} nearby</span>
                </div>
                {displayedGames.slice(0, 10).map((game) => (
                  <article className="map-game-row" key={game.id}>
                    <div className="map-game-main">
                      <div className="map-game-title-row">
                        <strong>{game.group_name}</strong>
                        <span className={`map-game-slots ${game.open_slots > 0 ? "is-available" : "is-full"}`}>
                          {game.open_slots > 0
                            ? `${game.open_slots} ${game.open_slots === 1 ? "spot" : "spots"} open`
                            : "Full"}
                        </span>
                      </div>
                      <p className="map-game-location">
                        {game.venue_name || game.area}
                        {game.venue_name && <span>{game.area}</span>}
                      </p>
                      <div className="map-game-meta" aria-label="Game details">
                        <span>{formatGameDate(game.session_date)}</span>
                        <span>{formatGameTime(game.start_time)}–{formatGameTime(game.end_time)}</span>
                        <span>{Math.round(game.match_score)}% match</span>
                      </div>
                      {game.is_connection_game && <span className="map-game-connection">From a connection</span>}
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
                        disabled={requestingGameId === game.id || isRequested(game.id)}
                      >
                        {isGuest
                          ? "Log in to join →"
                          : requestingGameId === game.id
                          ? "Requesting..."
                          : isRequested(game.id)
                          ? "Requested"
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

        {!isGuest && (
          <p className="density-privacy-note">
            Only aggregated neighborhoods are shown. Individual player locations are never shared.
          </p>
        )}
      </section>

    </section>
  );
}
