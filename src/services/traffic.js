// Google Routes API — confirmed endpoint and field names from Phase 0 research.
// POST https://routes.googleapis.com/directions/v2:computeRoutes
// duration     = traffic-aware travel time (string like "165s")
// staticDuration = travel time with no traffic — the physical minimum for the route

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Returns { seconds, staticSeconds } or null if no route found. Throws on API failure.
// departureTime: optional Date — defaults to now+60s. Pass a future Date to get
// Google's historical traffic prediction for that time slot.
//
// origin / destination accept either:
//   { lat, lon } — coordinates from geocode(); preferred — avoids re-geocoding by the
//                  Routes API, which can land on a different point when formatted_address
//                  is a vague city-level label (e.g. "Nairobi, Kenya" for a specific POI).
//   string       — address string; used by the scheduler and watch poller which only have
//                  the NLP-extracted string stored in the DB.
function toRoutesLocation(input) {
  if (input && typeof input === 'object' && 'lat' in input) {
    return { location: { latLng: { latitude: input.lat, longitude: input.lon } } };
  }
  return { address: input };
}

// Returns array of { seconds, staticSeconds, distanceMeters, description } or null.
// computeAlternativeRoutes asks Google for up to 3 route options — useful for
// "should I take the long way?" comparisons. description is a brief label like
// "via Uhuru Highway" when Google returns one.
export async function getRouteOptions(origin, destination, departureTime = null) {
  const depTime = departureTime ?? new Date(Date.now() + 60_000);
  const body = {
    origin: toRoutesLocation(origin),
    destination: toRoutesLocation(destination),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    departureTime: depTime.toISOString(),
    computeAlternativeRoutes: true,
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Routes API ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.routes?.length) return null;

  return data.routes.map(route => ({
    seconds: parseInt(route.duration, 10),
    staticSeconds: route.staticDuration
      ? parseInt(route.staticDuration, 10)
      : parseInt(route.duration, 10),
    distanceMeters: route.distanceMeters ?? 0,
    description: route.description ?? null,
  }));
}

export async function getDurationSeconds(origin, destination, departureTime = null) {
  const depTime = departureTime ?? new Date(Date.now() + 60_000);
  const body = {
    origin: toRoutesLocation(origin),
    destination: toRoutesLocation(destination),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    departureTime: depTime.toISOString(),
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
      // X-Goog-FieldMask is mandatory — omitting it causes a 400.
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Routes API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const route = data.routes?.[0];
  if (!route?.duration) return null;

  const seconds = parseInt(route.duration, 10);
  // staticDuration is the no-traffic minimum — the floor for any watch threshold.
  // Falls back to the traffic-aware time if Google doesn't return it.
  const staticSeconds = route.staticDuration
    ? parseInt(route.staticDuration, 10)
    : seconds;

  return { seconds, staticSeconds };
}
