import { orsBboxToOverpass, decodePolyline, sampleInteriorCoords } from '../utils/geo.js';
import { get as cacheGet, set as cacheSet } from '../utils/cache.js';

// ORS confirmed endpoint from Phase 0. Profile driving-car; alternatives via
// alternative_routes.target_count. The ORS "green" weighting is foot-* only,
// so we score driving routes ourselves using Overpass scenic node counts.
const ORS_ENDPOINT = 'https://api.openrouteservice.org/v2/directions/driving-car/json';
// overpass-api.de can be unreachable from certain hosts; private.coffee is independent infrastructure.
// overpass.kumi.systems migrated to overpass.private.coffee (confirmed defunct as of May 2026).
const OVERPASS_ENDPOINT = 'https://overpass.private.coffee/api/interpreter';
const OVERPASS_TTL_MS = 24 * 60 * 60 * 1000;

export async function getAlternativeRoutes(origin, destination) {
  const body = {
    coordinates: [
      [origin.lon, origin.lat],
      [destination.lon, destination.lat],
    ],
    alternative_routes: {
      target_count: 3,
      weight_factor: 1.6,
      share_factor: 0.6,
    },
    geometry: true,
    instructions: false,
  };

  const res = await fetch(ORS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.ORS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let code = null;
    try { code = JSON.parse(text).error?.code ?? null; } catch { /* ignore */ }
    const err = new Error(`ORS API ${res.status}: ${text}`);
    err.orsCode = code;
    throw err;
  }

  const data = await res.json();
  return data.routes ?? [];
}

async function queryScenicElements(overpassBbox) {
  const [s, w, n, e] = overpassBbox;
  const cacheKey = `overpass:${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const bbox = `(${s},${w},${n},${e})`;
  const query = `
    [out:json][timeout:25];
    (
      way["natural"="wood"]${bbox};
      way["landuse"="forest"]${bbox};
      way["natural"="water"]${bbox};
      way["natural"="wetland"]${bbox};
      way["natural"="coastline"]${bbox};
      way["waterway"~"river|stream|canal"]${bbox};
      node["waterway"~"river|stream|waterfall"]${bbox};
      way["landuse"="plantation"]${bbox};
      way["landuse"="farmland"]["crop"~"tea|coffee|sugarcane"]${bbox};
      way["leisure"="park"]${bbox};
      node["tourism"="viewpoint"]${bbox};
      node["natural"~"peak|spring|cliff|beach|bay|cape"]${bbox};
    );
    out body;
  `;

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'wayward-bot/0.1 (Nairobi commuter assistant; github.com/ronnyabuto/wayward)',
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) throw new Error(`Overpass API ${res.status}`);

  const data = await res.json();
  const elements = data.elements ?? [];
  cacheSet(cacheKey, elements, OVERPASS_TTL_MS);
  return elements;
}

// Score and rank routes by scenic value.
// Returns the best-scoring entry: { route, coords, scenicScore, scenicNodeCount, topName }
// coords is a decoded [lon, lat] array from the route's encoded polyline geometry.
export async function scoreAndRank(routes) {
  if (!routes.length) return null;

  const baseDuration = routes[0].summary.duration;

  const scored = await Promise.all(
    routes.map(async (route) => {
      const coords = decodePolyline(route.geometry);
      const overpassBbox = orsBboxToOverpass(route.bbox);

      let elements = [];
      try {
        elements = await queryScenicElements(overpassBbox);
      } catch {
        // Non-fatal — if Overpass is unreachable for this bbox, score is 0.
      }

      // scenic_score = scenic_element_count / (route_duration / baseline_duration).
      // Dividing by the duration ratio penalises longer routes.
      const durationRatio = route.summary.duration / baseDuration;
      const scenicScore = elements.length / durationRatio;

      const topName = elements.find((el) => el.tags?.name)?.tags?.name ?? null;

      return { route, coords, scenicScore, scenicNodeCount: elements.length, topName };
    })
  );

  scored.sort((a, b) => b.scenicScore - a.scenicScore);
  return scored[0];
}

// Extract up to `count` interior waypoints from decoded route coordinates.
// Interior = skipping the first and last points (which are origin/destination).
export function extractWaypoints(coords, count = 3) {
  return sampleInteriorCoords(coords, count);
}

// Build a Google Maps deep link.
// originStr / destinationStr are human-readable names (e.g. "Karen, Nairobi, Kenya").
// waypoints is an array of [lon, lat] pairs.
export function buildMapsLink(originStr, destinationStr, waypoints) {
  const base = 'https://www.google.com/maps/dir/?api=1';
  const wStr = waypoints.map(([lon, lat]) => `${lat},${lon}`).join('|');
  return (
    `${base}` +
    `&origin=${encodeURIComponent(originStr)}` +
    `&destination=${encodeURIComponent(destinationStr)}` +
    (wStr ? `&waypoints=${encodeURIComponent(wStr)}` : '')
  );
}
