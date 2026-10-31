import { AppError, ValidationError } from './response';

export interface AttendanceSecurityPolicy {
  geofence_enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  radius_m: number;
  enforcement: 'block' | 'warn';
  require_location: boolean;
  block_mock_location: boolean;
}

export interface LocationEvidence {
  latitude?: number;
  longitude?: number;
  accuracy_m?: number;
  is_mocked?: boolean;
}

export function parseAttendanceSecurity(raw: unknown): AttendanceSecurityPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const latitude = value.latitude === null ? null : Number(value.latitude);
  const longitude = value.longitude === null ? null : Number(value.longitude);
  const radius = Number(value.radius_m);
  if (typeof value.geofence_enabled !== 'boolean' || !Number.isFinite(radius) || radius < 25 || radius > 5000) return null;
  if (value.geofence_enabled && (
    latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
  )) return null;
  return {
    geofence_enabled: value.geofence_enabled,
    latitude, longitude, radius_m: radius,
    enforcement: value.enforcement === 'block' ? 'block' : 'warn',
    require_location: value.require_location === true,
    block_mock_location: value.block_mock_location === true,
  };
}

export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
  const accuracy = Number.isFinite(location.accuracy_m) ? Math.max(0, location.accuracy_m!) : null;
  if (policy.enforcement === 'block' && accuracy !== null && accuracy > 200) {
    throw new AppError('Location accuracy is too low. Move outdoors and try again.', 422, 'LOCATION_ACCURACY_LOW');
  }
  const distance = distanceMeters(location.latitude!, location.longitude!, policy.latitude!, policy.longitude!);
  const clearlyOutside = distance - (accuracy ?? 0) > policy.radius_m;
  if (clearlyOutside && policy.enforcement === 'block') {
    throw new AppError('You are outside the allowed attendance area', 403, 'OUTSIDE_GEOFENCE');
  }
  const status = location.is_mocked ? 'mocked' : clearlyOutside ? 'outside' : distance + (accuracy ?? 0) > policy.radius_m ? 'edge' : 'inside';
  return { status, distance_m: Math.round(distance) };
}
