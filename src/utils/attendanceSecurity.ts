import { AppError, ValidationError } from './response';

export type GeofenceVertex = { latitude: number; longitude: number };
export interface AttendanceSecurityPolicy {
  geofence_enabled: boolean;
  shape: 'circle' | 'polygon';
  latitude: number | null;
  longitude: number | null;
  vertices: GeofenceVertex[];
  radius_m: number;
  enforcement: 'block' | 'warn';
  require_location: boolean;
  block_mock_location: boolean;
  max_accuracy_m: number;
}

export interface LocationEvidence {
  latitude?: number;
  longitude?: number;
  accuracy_m?: number;
  is_mocked?: boolean;
}

function validPoint(value: unknown): value is GeofenceVertex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && Number(point.latitude) >= -90 && Number(point.latitude) <= 90
    && Number(point.longitude) >= -180 && Number(point.longitude) <= 180;
}

function parsePolicy(raw: unknown, legacy = false): AttendanceSecurityPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const enabled = legacy ? value.geofence_enabled : value.enabled;
  if (typeof enabled !== 'boolean') return null;
  const shape = value.shape === 'polygon' ? 'polygon' : 'circle';
  const latitude = value.latitude === null || value.latitude === undefined ? null : Number(value.latitude);
  const longitude = value.longitude === null || value.longitude === undefined ? null : Number(value.longitude);
  const radius = Number(value.radius_m ?? 150);
  const vertices = Array.isArray(value.vertices) ? value.vertices : [];
  const maxAccuracy = Number(value.max_accuracy_m ?? 200);
  if (!Number.isFinite(radius) || radius < 25 || radius > 5000 || !Number.isFinite(maxAccuracy) || maxAccuracy < 10 || maxAccuracy > 2000) return null;
  if (shape === 'circle' && enabled && (
    latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
  )) return null;
  if (shape === 'polygon' && enabled && (vertices.length < 3 || vertices.length > 100 || !vertices.every(validPoint))) return null;
  return {
    geofence_enabled: enabled,
    shape,
    latitude, longitude,
    vertices: vertices as GeofenceVertex[],
    radius_m: radius,
    enforcement: value.enforcement === 'block' ? 'block' : 'warn',
    require_location: value.require_location === true,
    block_mock_location: value.block_mock_location === true,
    max_accuracy_m: maxAccuracy,
  };
}

/** Reads the legacy organization-wide circle policy. */
export function parseAttendanceSecurity(raw: unknown): AttendanceSecurityPolicy | null {
  return parsePolicy(raw, true);
}

/** Reads a location-scoped circle or polygon. Null means no branch override. */
export function parseLocationGeofence(raw: unknown): AttendanceSecurityPolicy | null {
  return parsePolicy(raw);
}

/** Validates JSON written to Location.geofence. Null clears the branch override. */
export function validateLocationGeofence(raw: unknown): AttendanceSecurityPolicy | null {
  if (raw === null) return null;
  const parsed = parseLocationGeofence(raw);
  if (!parsed) throw new ValidationError('Geofence must have valid settings; enabled circles need a center, and enabled polygons need 3–100 valid points');
  return parsed;
}

export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonMetrics(point: GeofenceVertex, vertices: GeofenceVertex[]) {
  const earth = 6_371_000;
  const radians = Math.PI / 180;
  const cosLat = Math.cos(point.latitude * radians);
  const project = ({ latitude, longitude }: GeofenceVertex) => ({
    x: (longitude - point.longitude) * radians * earth * cosLat,
    y: (latitude - point.latitude) * radians * earth,
  });
  const p = { x: 0, y: 0 };
  let inside = false;
  let minDistance = Infinity;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = project(vertices[j]);
    const b = project(vertices[i]);
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    minDistance = Math.min(minDistance, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return { inside, boundary_m: minDistance };
}

export function evaluateCheckinLocation(policy: AttendanceSecurityPolicy | null, location: LocationEvidence) {
  if (!policy?.geofence_enabled) return null;
  const hasPosition = Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  if (!hasPosition) {
    if (policy.require_location) throw new ValidationError('Location is required by your organization to check in');
    return { status: 'missing', distance_m: null };
  }
  if (location.is_mocked && policy.block_mock_location) {
    throw new AppError('Mocked locations are not accepted for attendance check-in', 403, 'MOCK_LOCATION_BLOCKED');
  }
  const accuracy = Number.isFinite(location.accuracy_m) ? Math.max(0, location.accuracy_m!) : 0;
  const lowAccuracy = accuracy > policy.max_accuracy_m;
  if (policy.enforcement === 'block' && lowAccuracy) {
    throw new AppError('Location accuracy is too low. Move to an area with a clearer GPS signal and try again.', 422, 'LOCATION_ACCURACY_LOW');
  }

  let clearlyInside = false;
  let clearlyOutside = false;
  let distance: number;
  if (policy.shape === 'polygon') {
    const metrics = polygonMetrics({ latitude: location.latitude!, longitude: location.longitude! }, policy.vertices);
    distance = metrics.boundary_m;
    clearlyInside = metrics.inside && distance > accuracy;
    clearlyOutside = !metrics.inside && distance > accuracy;
  } else {
    distance = distanceMeters(location.latitude!, location.longitude!, policy.latitude!, policy.longitude!);
    clearlyOutside = distance - accuracy > policy.radius_m;
    clearlyInside = distance + accuracy <= policy.radius_m;
  }
  if (clearlyOutside && policy.enforcement === 'block') {
    throw new AppError('You are outside the allowed attendance area', 403, 'OUTSIDE_GEOFENCE');
  }
  const status = location.is_mocked ? 'mocked' : lowAccuracy ? 'low_accuracy' : clearlyOutside ? 'outside' : clearlyInside ? 'inside' : 'edge';
  return { status, distance_m: Math.round(distance) };
}
