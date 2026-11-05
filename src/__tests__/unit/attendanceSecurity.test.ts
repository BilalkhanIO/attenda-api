import { evaluateCheckinLocation, parseAttendanceSecurity, parseLocationGeofence, validateLocationGeofence } from '../../utils/attendanceSecurity';

const polygon = {
  enabled: true,
  shape: 'polygon',
  vertices: [
    { latitude: 31.520, longitude: 74.350 },
    { latitude: 31.520, longitude: 74.360 },
    { latitude: 31.530, longitude: 74.360 },
    { latitude: 31.530, longitude: 74.350 },
  ],
  enforcement: 'warn',
  radius_m: 150,
  max_accuracy_m: 200,
};

describe('attendance geofence policy', () => {
  it('preserves legacy organization circles', () => {
    const policy = parseAttendanceSecurity({
      geofence_enabled: true, latitude: 31.52, longitude: 74.35, radius_m: 300,
      enforcement: 'warn', require_location: true, block_mock_location: false,
    });
    expect(policy?.shape).toBe('circle');
    expect(evaluateCheckinLocation(policy, { latitude: 31.52, longitude: 74.35 })?.status).toBe('inside');
  });

  it('classifies positions inside, outside, and near a polygon edge', () => {
    const policy = parseLocationGeofence(polygon)!;
    expect(evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.355 })?.status).toBe('inside');
    expect(evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.365 })?.status).toBe('outside');
    expect(evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.360, accuracy_m: 20 })?.status).toBe('edge');
  });

  it('blocks clear outside points and poor accuracy only in block mode', () => {
    const policy = parseLocationGeofence({ ...polygon, enforcement: 'block', max_accuracy_m: 100 })!;
    expect(() => evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.365 })).toThrow('outside the allowed attendance area');
    expect(() => evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.355, accuracy_m: 150 })).toThrow('accuracy is too low');
    expect(evaluateCheckinLocation(parseLocationGeofence(polygon), { latitude: 31.525, longitude: 74.355, accuracy_m: 150 })?.status).toBe('inside');
  });

  it('sends low-accuracy fixes to review in warn mode', () => {
    const policy = parseLocationGeofence({ ...polygon, max_accuracy_m: 80 })!;
    expect(evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.355, accuracy_m: 120 })?.status).toBe('low_accuracy');
  });

  it('requires location when configured, and recognizes configurable mock-location blocks', () => {
    const policy = parseLocationGeofence({ ...polygon, require_location: true, block_mock_location: true })!;
    expect(() => evaluateCheckinLocation(policy, {})).toThrow('Location is required');
    expect(() => evaluateCheckinLocation(policy, { latitude: 31.525, longitude: 74.355, is_mocked: true })).toThrow('Mocked locations');
  });

  it('validates polygon bounds and permits clearing a location override', () => {
    expect(() => validateLocationGeofence({ ...polygon, vertices: [{ latitude: 91, longitude: 0 }, ...polygon.vertices.slice(1)] })).toThrow('valid settings');
    expect(() => validateLocationGeofence({ ...polygon, vertices: polygon.vertices.slice(0, 2) })).toThrow('valid settings');
    expect(validateLocationGeofence(null)).toBeNull();
  });
});
