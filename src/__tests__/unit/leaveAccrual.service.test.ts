// Pure accrual math — parseAccrualConfig / monthlyIncrement / carryOver.
// prisma is mocked so importing the service never opens a connection.

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  jobLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { parseAccrualConfig, monthlyIncrement, carryOver } from '../../services/leaveAccrual';

describe('parseAccrualConfig', () => {
  it('returns null for non-object input', () => {
    expect(parseAccrualConfig(null)).toBeNull();
    expect(parseAccrualConfig(undefined)).toBeNull();
    expect(parseAccrualConfig('annual')).toBeNull();
    expect(parseAccrualConfig(42)).toBeNull();
    expect(parseAccrualConfig([{ days_per_year: 20 }])).toBeNull();
  });

  it('returns null when no usable policies remain', () => {
    expect(parseAccrualConfig({})).toBeNull();
    expect(parseAccrualConfig({ annual: { days_per_year: 0 } })).toBeNull();
    expect(parseAccrualConfig({ annual: { days_per_year: 400 } })).toBeNull();
    expect(parseAccrualConfig({ annual: { days_per_year: 'lots' } })).toBeNull();
    expect(parseAccrualConfig({ annual: null, sick: 'x' })).toBeNull();
  });

  it('keeps valid policies and drops invalid siblings', () => {
    const cfg = parseAccrualConfig({
      annual: { days_per_year: 20, carry_over_max: 5 },
      sick: { days_per_year: -3 },
    });
    expect(cfg).toEqual({ annual: { days_per_year: 20, carry_over_max: 5 } });
  });

  it('coerces numeric strings and ignores a negative carry-over cap', () => {
    const cfg = parseAccrualConfig({
      annual: { days_per_year: '24', carry_over_max: -2 },
    });
    expect(cfg).toEqual({ annual: { days_per_year: 24 } });
  });
});

describe('monthlyIncrement', () => {
  it('pro-rates the annual rate to 2dp', () => {
    expect(monthlyIncrement({ days_per_year: 20 })).toBe(1.67);
    expect(monthlyIncrement({ days_per_year: 24 })).toBe(2);
    expect(monthlyIncrement({ days_per_year: 12 })).toBe(1);
    expect(monthlyIncrement({ days_per_year: 1 })).toBe(0.08);
  });
});

describe('carryOver', () => {
  it('carries the unused balance up to the cap', () => {
    expect(carryOver({ days_per_year: 20, carry_over_max: 5 }, 20, 12)).toBe(5);
    expect(carryOver({ days_per_year: 20, carry_over_max: 10 }, 20, 12)).toBe(8);
  });

  it('defaults to zero carry-over when no cap is configured', () => {
    expect(carryOver({ days_per_year: 20 }, 20, 0)).toBe(0);
  });

  it('never goes negative when usage exceeds the balance', () => {
    expect(carryOver({ days_per_year: 20, carry_over_max: 5 }, 10, 15)).toBe(0);
  });

  it('rounds to 2dp', () => {
    expect(carryOver({ days_per_year: 20, carry_over_max: 9.999 }, 20, 10.005)).toBeCloseTo(9.99, 2);
  });
});
