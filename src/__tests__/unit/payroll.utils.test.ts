// Shared payroll recalculation math (utils/payroll.ts) — used by both
// PUT /payroll/:id/adjust and POST /expenses/:id/reimburse.

import { recalcPayrollTotals, PayrollFigures } from '../../utils/payroll';

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
