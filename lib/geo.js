'use strict';

const EARTH_R = 6371000; // metres

function haversine(lat1, lon1, lat2, lon2) {
  const r = d => d * Math.PI / 180;
  const dLat = r(lat2 - lat1);
  const dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns the nearest active location and whether the coords are within its fence.
function findNearestLocation(lat, lon, locations) {
  if (!locations.length) return { location: null, within: false, distanceMeters: null };
  let best = null;
  let bestDist = Infinity;
  for (const loc of locations) {
    const d = haversine(lat, lon, Number(loc.lat), Number(loc.lng));
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return {
    location: best,
    within: bestDist <= best.radius_meters,
    distanceMeters: Math.round(bestDist),
  };
}

module.exports = { haversine, findNearestLocation };
