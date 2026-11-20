import type { GeoPoint } from './types';

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km. Used by clients for display; the database does the real ranking. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lat/lng box around a point; lets Postgres use a btree index before the exact distance check. */
export function boundingBox(center: GeoPoint, radiusKm: number) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLng: center.lng - dLng,
    maxLng: center.lng + dLng,
  };
}

/**
 * ETA model for the golden sample: prep time grows with the kitchen's queue,
 * travel at ~18 km/h urban courier speed. Real deployments replace this with a learned model.
 */
export function estimateEtaMinutes(distanceKm: number, activeOrders: number, capacityPer15Min: number): number {
  const prep = 12 + Math.ceil((activeOrders / Math.max(1, capacityPer15Min)) * 15);
  const travel = Math.ceil((distanceKm / 18) * 60);
  return prep + travel;
}
