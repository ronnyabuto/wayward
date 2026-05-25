import { get as cacheGet, set as cacheSet } from './cache.js';

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
// Coordinates of named places don't change — 7-day TTL is safe.
const GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Bias results toward Kenya without hard-restricting to it, so that a user
// can still say "Mombasa" or "Kisumu" and get a sensible result.
function buildQuery(place) {
  const lower = place.toLowerCase();
  const hasCountry = lower.includes('kenya') || lower.includes('nairobi');
  return hasCountry ? place : `${place}, Kenya`;
}

// Returns { lat, lon } or throws a user-readable Error.
export async function geocode(place) {
  const query = buildQuery(place.trim());
  const cacheKey = `geocode:${query.toLowerCase()}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(ENDPOINT);
  url.searchParams.set('address', query);
  url.searchParams.set('key', process.env.GOOGLE_API_KEY);
  // Soft-bias toward Kenya — does not exclude other countries.
  url.searchParams.set('region', 'ke');

  // Retry once on network failures or 5xx server errors — these are transient and
  // would otherwise surface to the user as "Something went wrong looking up those places."
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

  const data = await res.json();

  if (data.status === 'ZERO_RESULTS') {
    throw new GeocodeNotFoundError(place);
  }
  if (data.status !== 'OK') {
    throw new Error(`Geocoding API: ${data.status} — ${data.error_message ?? ''}`);
  }

  // Reject results that resolved to a country or top-level region — too vague to route to.
  // Use .some() not .every(): Google always pairs vague types with "political", so every()
  // would fail to catch ["country","political"] because "political" isn't in the list.
  const types = data.results[0].types ?? [];
  const TOO_VAGUE = ['country', 'administrative_area_level_1', 'administrative_area_level_2'];
  const isVague = TOO_VAGUE.some((t) => types.includes(t));
  if (isVague) throw new GeocodeNotFoundError(place);

  // Reject results outside Kenya's bounding box — catches garbage geocodes where
  // Google matched an obscure token to something on the other side of the planet.
  const { lat, lng } = data.results[0].geometry.location;
  const KENYA_BBOX = { minLat: -4.9, maxLat: 4.6, minLon: 33.9, maxLon: 41.9 };
  if (lat < KENYA_BBOX.minLat || lat > KENYA_BBOX.maxLat || lng < KENYA_BBOX.minLon || lng > KENYA_BBOX.maxLon) {
    throw new GeocodeNotFoundError(place);
  }

  const formatted = data.results[0].formatted_address;
  const result = { lat, lon: lng, formatted };

  cacheSet(cacheKey, result, GEOCODE_TTL_MS);
  return result;
}

export class GeocodeNotFoundError extends Error {
  constructor(place) {
    super(`Could not find "${place}" on Google Maps. Try a more specific name.`);
    this.name = 'GeocodeNotFoundError';
    this.place = place;
  }
}
