const EARTH_RADIUS_KM = 6371;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// ORS bbox is [minLon, minLat, maxLon, maxLat].
// Overpass expects (south, west, north, east) = (minLat, minLon, maxLat, maxLon).
export function orsBboxToOverpass([minLon, minLat, maxLon, maxLat]) {
  return [minLat, minLon, maxLat, maxLon];
}

// Google Polyline Algorithm decoder (https://developers.google.com/maps/documentation/utilities/polylinealgorithm).
// ORS returns encoded polylines in its JSON response format.
// Returns an array of [lon, lat] pairs to match the [lon, lat] convention used by ORS coordinates.
export function decodePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 32);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 32);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / 1e5, lat / 1e5]);
  }

  return coords;
}

// Pick `count` coordinates evenly spaced along a coordinate array.
// coords is an array of [lon, lat] pairs.
export function sampleCoords(coords, count) {
  if (coords.length <= count) return coords;
  const step = (coords.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => coords[Math.round(i * step)]);
}

// Sample interior points only (excluding first and last), suitable for use as
// Google Maps waypoints that sit between the stated origin and destination.
export function sampleInteriorCoords(coords, count) {
  if (coords.length <= 2) return [];
  const interior = coords.slice(1, -1);
  return sampleCoords(interior, Math.min(count, interior.length));
}
