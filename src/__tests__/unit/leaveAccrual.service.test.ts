// Pure accrual math — parseAccrualConfig / monthlyIncrement / carryOver.
// prisma is mocked so importing the service never opens a connection.

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  jobLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { parseAccrualConfig, monthlyIncrement, carryOver, toDays, accruedTotal, availableDays } from '../../services/leaveAccrual';

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

// leave_balances.total_days/used_days are DECIMAL(6,2) — Prisma hands them
// back as Decimal objects that stringify. These helpers are the write/read
// paths for fractional days (0.5 half-days, days_per_year/12 accrual).
describe('toDays', () => {
  it('normalizes Decimal-like objects, strings and numbers', () => {
    expect(toDays(20)).toBe(20);
    expect(toDays('1.67')).toBe(1.67);
    expect(toDays({ toString: () => '0.50' })).toBe(0.5); // Prisma Decimal shape
  });

  it('falls back to 0 for garbage', () => {
    expect(toDays(null)).toBe(0);
    expect(toDays(undefined)).toBe(0);
    expect(toDays('not a number')).toBe(0);
  });
});

describe('accruedTotal (days_per_year/12 write path)', () => {
  it('applies a monthly increment to a Decimal-backed total at 2dp', () => {
    const inc = monthlyIncrement({ days_per_year: 20 }); // 1.67 — non-integer
    expect(inc).toBe(1.67);
    expect(accruedTotal({ toString: () => '1.67' }, inc)).toBe(3.34);
    expect(accruedTotal('18.33', inc)).toBe(20);
  });

  it('applies signed manual adjustments', () => {
    expect(accruedTotal(20, -2.5)).toBe(17.5);
    expect(accruedTotal('20.00', 0.5)).toBe(20.5);
  });
});

describe('availableDays (0.5 half-day read path)', () => {
  it('subtracts fractional used days from Decimal-backed columns', () => {
    expect(availableDays('20.00', '0.50')).toBe(19.5);
    expect(availableDays({ toString: () => '20' }, { toString: () => '0.5' })).toBe(19.5);
  });

  it('handles accrued fractional totals', () => {
    expect(availableDays('1.67', '0.5')).toBe(1.17);
    expect(availableDays(0, 0)).toBe(0);
  });
});
