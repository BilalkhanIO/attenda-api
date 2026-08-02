// Shared payroll recalculation math (utils/payroll.ts) — used by both
// PUT /payroll/:id/adjust and POST /expenses/:id/reimburse; and the shared
// period computation used by POST /payroll/generate and the auto-generate cron.

import { recalcPayrollTotals, computePeriodPayroll, PayrollFigures, PeriodPayrollInputs } from '../../utils/payroll';

const base: PayrollFigures = {
  regular_hours: 160,
  overtime_hours: 0,
  hourly_rate: 10,
  unpaid_deduction: 0,
  manual_adjustment: 0,
};

describe('recalcPayrollTotals', () => {
  it('computes gross = regular hours × rate with zero rates', () => {
    const t = recalcPayrollTotals(base, 0, 0);
    expect(t).toEqual({ gross_pay: 1600, tax_deduction: 0, pension_deduction: 0, net_pay: 1600 });
  });

  it('pays overtime at 1.5× the hourly rate', () => {
    const t = recalcPayrollTotals({ ...base, overtime_hours: 10 }, 0, 0);
    expect(t.gross_pay).toBe(1600 + 10 * 10 * 1.5);
  });

  it('subtracts unpaid deductions and adds manual adjustments', () => {
    const t = recalcPayrollTotals({ ...base, unpaid_deduction: 80, manual_adjustment: 45.5 }, 0, 0);
    expect(t.gross_pay).toBe(1600 - 80 + 45.5);
  });

  it('applies tax and pension as whole percentages of gross', () => {
    const t = recalcPayrollTotals(base, 10, 5);
    expect(t.tax_deduction).toBeCloseTo(160);
    expect(t.pension_deduction).toBeCloseTo(80);
    expect(t.net_pay).toBeCloseTo(1600 - 160 - 80);
  });

  it('floors gross at zero when deductions exceed earnings', () => {
    const t = recalcPayrollTotals({ ...base, regular_hours: 1, unpaid_deduction: 500 }, 10, 5);
    expect(t.gross_pay).toBe(0);
    expect(t.net_pay).toBe(0);
  });

  it('treats non-finite rates as zero (matches route Number(x) || 0 guard)', () => {
    const t = recalcPayrollTotals(base, NaN, NaN);
    expect(t.tax_deduction).toBe(0);
    expect(t.net_pay).toBe(1600);
  });

  it('reimbursement bump: adding a claim amount to manual_adjustment raises net by amount × (1 − rates)', () => {
    const before = recalcPayrollTotals(base, 10, 5);
    const after = recalcPayrollTotals({ ...base, manual_adjustment: 200 }, 10, 5);
    expect(after.gross_pay - before.gross_pay).toBeCloseTo(200);
    expect(after.net_pay - before.net_pay).toBeCloseTo(200 * (1 - 0.10 - 0.05));
  });
});

// ─── computePeriodPayroll — shared by route generate + cron ─────────
const periodBase: PeriodPayrollInputs = {
  attendance: [
    { net_hours_worked: 8, overtime_hours: 0, shift: null },
    { net_hours_worked: 8, overtime_hours: 0, shift: null },
  ],
  unpaid_leave_days: 0,
  hourly_rate: 10,
  manual_adjustment: 0,
};

describe('computePeriodPayroll', () => {
  it('sums regular hours preferring net_hours_worked, falling back to hours_worked', () => {
    const t = computePeriodPayroll({
      ...periodBase,
      attendance: [
        { net_hours_worked: 7.5, hours_worked: 9, overtime_hours: 0 },
        { net_hours_worked: null, hours_worked: 8, overtime_hours: 0 }, // legacy record
      ],
    }, 0, 0);
    expect(t.regular_hours).toBe(15.5);
    expect(t.gross_pay).toBe(155);
  });

  it('(a) preserves manual_adjustment in gross across regeneration', () => {
    const withoutAdj = computePeriodPayroll(periodBase, 10, 5);
    const withAdj    = computePeriodPayroll({ ...periodBase, manual_adjustment: 120 }, 10, 5);
    expect(withAdj.manual_adjustment).toBe(120);
    expect(withAdj.gross_pay - withoutAdj.gross_pay).toBeCloseTo(120);
    expect(withAdj.net_pay - withoutAdj.net_pay).toBeCloseTo(120 * (1 - 0.10 - 0.05));
  });

  it('(b) deducts unpaid leave at 8h × rate per working day (route and cron alike)', () => {
    const t = computePeriodPayroll({ ...periodBase, unpaid_leave_days: 1.5 }, 0, 0);
    expect(t.unpaid_deduction).toBe(1.5 * 8 * 10);
    expect(t.gross_pay).toBe(160 - 120);
  });

  it('(c) pays overtime at each record\'s shift overtime_multiplier, falling back to 1.5', () => {
    const t = computePeriodPayroll({
      ...periodBase,
      attendance: [
        { net_hours_worked: 8, overtime_hours: 2, shift: { overtime_multiplier: 2 } },
        { net_hours_worked: 8, overtime_hours: 1, shift: { overtime_multiplier: '1.25' } }, // Prisma Decimal stringifies
        { net_hours_worked: 8, overtime_hours: 1, shift: null },                            // no shift → 1.5
        { net_hours_worked: 8, overtime_hours: 1, shift: {} },                              // no multiplier → 1.5
      ],
    }, 0, 0);
    expect(t.overtime_hours).toBe(5);
    expect(t.overtime_pay).toBeCloseTo(2 * 10 * 2 + 1 * 10 * 1.25 + 1 * 10 * 1.5 + 1 * 10 * 1.5);
    expect(t.gross_pay).toBeCloseTo(32 * 10 + t.overtime_pay);
  });

  it('floors gross at zero and computes tax/pension as whole percentages', () => {
    const zero = computePeriodPayroll({ ...periodBase, attendance: [], unpaid_leave_days: 5 }, 10, 5);
    expect(zero.gross_pay).toBe(0);
    expect(zero.net_pay).toBe(0);

    const t = computePeriodPayroll(periodBase, 10, 5);
    expect(t.tax_deduction).toBeCloseTo(16);
    expect(t.pension_deduction).toBeCloseTo(8);
    expect(t.net_pay).toBeCloseTo(160 - 16 - 8);
  });
});
