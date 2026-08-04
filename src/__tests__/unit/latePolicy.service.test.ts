// Pure late-policy math — parseLatePolicy / pointsForLateness.
// prisma is mocked so importing the service never opens a connection.

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  jobLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { parseLatePolicy, pointsForLateness, DEFAULT_ABSENT_AFTER_MINS } from '../../services/latePolicy';

describe('parseLatePolicy', () => {
  it('returns null for non-object or empty input', () => {
    expect(parseLatePolicy(null)).toBeNull();
    expect(parseLatePolicy(undefined)).toBeNull();
    expect(parseLatePolicy('strict')).toBeNull();
    expect(parseLatePolicy([1, 2])).toBeNull();
    expect(parseLatePolicy({})).toBeNull();
    expect(parseLatePolicy({ absent_after_mins: 'soon' })).toBeNull();
  });

  it('bounds absent_after_mins to [30, 720]', () => {
    expect(parseLatePolicy({ absent_after_mins: 90 })).toEqual({ absent_after_mins: 90 });
    expect(parseLatePolicy({ absent_after_mins: 10 })).toBeNull();
    expect(parseLatePolicy({ absent_after_mins: 800 })).toBeNull();
  });

  it('keeps valid tiers sorted by after_mins and drops junk entries', () => {
    const parsed = parseLatePolicy({
      tiers: [
        { after_mins: 60, points: 3 },
        { after_mins: 5, points: 1 },
        { after_mins: 'a lot', points: 9 },
        { after_mins: 30, points: -2 },
        null,
      ],
    });
    expect(parsed).toEqual({
      tiers: [
        { after_mins: 5, points: 1 },
        { after_mins: 60, points: 3 },
      ],
    });
  });

  it('accepts the full shape', () => {
    expect(parseLatePolicy({
      absent_after_mins: 120,
      tiers: [{ after_mins: 5, points: 1 }],
      points_window_days: 30,
      alert_threshold_points: 6,
    })).toEqual({
      absent_after_mins: 120,
      tiers: [{ after_mins: 5, points: 1 }],
      points_window_days: 30,
      alert_threshold_points: 6,
    });
  });

  it('exports a 2h default no-show window', () => {
    expect(DEFAULT_ABSENT_AFTER_MINS).toBe(120);
  });
});

describe('pointsForLateness', () => {
  const tiers = [
    { after_mins: 5, points: 1 },
    { after_mins: 30, points: 2 },
    { after_mins: 60, points: 3 },
  ];

  it('awards the highest tier reached', () => {
    expect(pointsForLateness(4, tiers)).toBe(0);
    expect(pointsForLateness(5, tiers)).toBe(1);
    expect(pointsForLateness(29, tiers)).toBe(1);
    expect(pointsForLateness(30, tiers)).toBe(2);
    expect(pointsForLateness(90, tiers)).toBe(3);
  });

  it('is zero without tiers or without lateness', () => {
    expect(pointsForLateness(45, undefined)).toBe(0);
    expect(pointsForLateness(45, [])).toBe(0);
    expect(pointsForLateness(0, tiers)).toBe(0);
    expect(pointsForLateness(-5, tiers)).toBe(0);
  });
});
