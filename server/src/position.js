export const POSITION_MAX_AGE_MS = 10000;

export function validCoordinates(p) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180
    && !(p.lat === 0 && p.lon === 0); // Uninitialized flight-controller coordinates.
}

export function resolvePosition(state, now = Date.now()) {
  const fresh = (p) => p && Number.isFinite(p.at) && now - p.at >= 0
    && now - p.at <= POSITION_MAX_AGE_MS;
  const global = state.globalPosition;
  const gps = state.gps;
  // An estimator can provide global position using sources other than GPS.
  if (fresh(global) && validCoordinates(global)) {
    return { positionStatus: 'valid', position: {
      lat: global.lat, lon: global.lon, alt: global.alt, relAlt: global.relativeAlt,
      heading: global.heading, source: 'global', at: global.at,
    } };
  }
  if (fresh(gps) && gps.fixType >= 2 && validCoordinates(gps)) {
    return { positionStatus: 'valid', position: {
      lat: gps.lat, lon: gps.lon, alt: gps.fixType >= 3 ? gps.alt : null,
      heading: state.attitude?.yaw ?? null, source: 'gps', at: gps.at,
    } };
  }
  let positionStatus = 'no_gps_data';
  if ((gps || global) && !fresh(gps) && !fresh(global)) positionStatus = 'stale';
  else if (fresh(gps) && gps.fixType < 2) positionStatus = 'waiting_gps';
  else if (gps || global) positionStatus = 'invalid_coordinates';
  return { position: null, positionStatus };
}
