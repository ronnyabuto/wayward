import { dbGetOrCreatePlace, dbCacheQuery, dbFindPlaceByQuery } from '../db.js';
import { logger } from './logger.js';

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
// Google Terms allow caching coordinates for 30 days; place_id is permanently cacheable.
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

// Bias results toward Kenya without hard-restricting, so Mombasa/Kisumu still work.
function buildQuery(place) {
  const lower = place.toLowerCase();
  const hasCountry = lower.includes('kenya') || lower.includes('nairobi');
  return hasCountry ? place : `${place}, Kenya`;
}

// Strip a known locality name from a comma-delimited query string.
// "Kahawa Sukari, Nairobi, Kenya" + "Nairobi" → "Kahawa Sukari, Kenya"
function stripLocality(query, localityName) {
  const lower = localityName.toLowerCase();
  return query
    .split(',')
    .map(p => p.trim())
    .filter(p => p.toLowerCase() !== lower)
    .join(', ');
}

async function fetchGeocode(queryStr) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('address', queryStr);
  url.searchParams.set('key', process.env.GOOGLE_API_KEY);
  url.searchParams.set('region', 'ke');

  let res;
  try {
    res = await fetch(url.toString());
  } catch {
    await new Promise(r => setTimeout(r, 1500));
    res = await fetch(url.toString());
  }
  if (res.status >= 500) {
    await new Promise(r => setTimeout(r, 1500));
    res = await fetch(url.toString());
  }
  if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
  return res.json();
}

// Returns { lat, lon, formatted, placeId } or throws a user-readable Error.
// Results are persisted in SQLite (place_id permanently; lat/lon for 30 days per ToS).
// On a cache hit with fresh coordinates, no API call is made.
export async function geocode(place) {
  const rawQuery  = buildQuery(place.trim());
  const cacheKey  = rawQuery.toLowerCase();

  const cached = dbFindPlaceByQuery(cacheKey);
  if (cached) {
    const ageS = Math.floor(Date.now() / 1000) - cached.refreshed_at;
    if (ageS < THIRTY_DAYS_S) {
      return { lat: cached.lat, lon: cached.lon, formatted: cached.display_name, placeId: cached.place_id };
    }
    // Coordinates stale — re-geocode; but the place_id is still valid for pool queries.
  }

  const TOO_VAGUE = ['country', 'administrative_area_level_1', 'administrative_area_level_2'];
  const t0 = Date.now();

  let data = await fetchGeocode(rawQuery);

  if (data.status === 'ZERO_RESULTS') throw new GeocodeNotFoundError(place);
  if (data.status !== 'OK') throw new Error(`Geocoding API: ${data.status} — ${data.error_message ?? ''}`);

  // When Google resolves a suburb query to the containing city (type: locality), retry
  // without the city component so the suburb gets its own geocode result.
  // Only retries when the query contained content *before* the matched city name —
  // a bare "Nairobi, Kenya" query is a valid locality request and passes through.
  const firstTypes = data.results[0].types ?? [];
  if (firstTypes.includes('locality')) {
    const localityComp = (data.results[0].address_components ?? [])
      .find(c => c.types.includes('locality'));
    const localityName = localityComp?.long_name ?? null;
    const queryLower   = rawQuery.toLowerCase();
    const localityIdx  = localityName ? queryLower.indexOf(localityName.toLowerCase()) : -1;

    if (localityName && localityIdx > 0) {
      // Query was more specific than the city — strip city and retry.
      const retryQuery = stripLocality(rawQuery, localityName);
      logger.debug({ original: rawQuery, retry: retryQuery }, 'geocode locality fallback');
      const retryData = await fetchGeocode(retryQuery);

      if (retryData.status === 'OK') {
        const retryTypes = retryData.results[0].types ?? [];
        const retryVague = TOO_VAGUE.some(t => retryTypes.includes(t)) || retryTypes.includes('locality');
        if (!retryVague) {
          data = retryData; // use the more specific result
        } else {
          throw new GeocodeNotFoundError(place);
        }
      } else if (retryData.status !== 'ZERO_RESULTS') {
        throw new Error(`Geocoding API: ${retryData.status} — ${retryData.error_message ?? ''}`);
      } else {
        throw new GeocodeNotFoundError(place);
      }
    }
    // locality query with nothing more specific before it — fall through normally.
  }

  const types = data.results[0].types ?? [];
  if (TOO_VAGUE.some(t => types.includes(t))) throw new GeocodeNotFoundError(place);

  const { lat, lng } = data.results[0].geometry.location;
  const KENYA_BBOX = { minLat: -4.9, maxLat: 4.6, minLon: 33.9, maxLon: 41.9 };
  if (lat < KENYA_BBOX.minLat || lat > KENYA_BBOX.maxLat || lng < KENYA_BBOX.minLon || lng > KENYA_BBOX.maxLon) {
    throw new GeocodeNotFoundError(place);
  }

  const formatted = data.results[0].formatted_address;
  const placeId   = data.results[0].place_id;

  dbGetOrCreatePlace(placeId, formatted, lat, lng);
  dbCacheQuery(cacheKey, placeId);

  logger.info({ query: cacheKey, placeId, latencyMs: Date.now() - t0, cached: false }, 'geocode');
  return { lat, lon: lng, formatted, placeId };
}

export class GeocodeNotFoundError extends Error {
  constructor(place) {
    super(`Could not find "${place}" on Google Maps. Try a more specific name.`);
    this.name  = 'GeocodeNotFoundError';
    this.place = place;
  }
}
