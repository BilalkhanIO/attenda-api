// Shared payroll recalculation math, extracted from PUT /payroll/:id/adjust
// so expense reimbursement (POST /expenses/:id/reimburse) applies EXACTLY the
// same gross → tax → pension → net pipeline when it bumps manual_adjustment.

export interface PayrollFigures {
  regular_hours: number;
  overtime_hours: number;
  hourly_rate: number;
  unpaid_deduction: number;
  manual_adjustment: number;
}

export interface PayrollTotals {
  gross_pay: number;
  tax_deduction: number;
  pension_deduction: number;
  net_pay: number;
}

/**
 * Recomputes gross/tax/pension/net from the record's figures.
 * Rates are whole percentages (e.g. 7.5 for 7.5%), matching
 * organisations.tax_rate / pension_rate. Gross and net are floored at 0.
 */
export function recalcPayrollTotals(
  figures: PayrollFigures,
  taxRatePct: number,
  pensionRatePct: number,
): PayrollTotals {
  const grossPay = Math.max(0,
    figures.regular_hours * figures.hourly_rate +
    figures.overtime_hours * figures.hourly_rate * 1.5 -
    figures.unpaid_deduction +
    figures.manual_adjustment
  );
  const taxRate     = (Number(taxRatePct)     || 0) / 100;
  const pensionRate = (Number(pensionRatePct) || 0) / 100;
  const taxDeduction     = grossPay * taxRate;
  const pensionDeduction = grossPay * pensionRate;
  return {
    gross_pay:         grossPay,
    tax_deduction:     taxDeduction,
    pension_deduction: pensionDeduction,
    net_pay:           Math.max(0, grossPay - taxDeduction - pensionDeduction),
  };
}
