// Shared payroll recalculation math, extracted from PUT /payroll/:id/adjust
// so expense reimbursement (POST /expenses/:id/reimburse) applies EXACTLY the
// same gross → tax → pension → net pipeline when it bumps manual_adjustment.
//
// computePeriodPayroll below is the single gross-computation used by BOTH
// POST /payroll/generate and the payroll auto-generate cron — the two must
// never drift (unpaid-leave deduction, manual_adjustment preservation and
// per-shift overtime multipliers all live here).

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

/** Fallback overtime multiplier when the record has no shift (or the shift has none). */
export const DEFAULT_OVERTIME_MULTIPLIER = 1.5;

/** One attendance row as consumed by the period computation. `shift` may carry
 *  a per-shift overtime multiplier (Prisma Decimal | number | string). */
export interface PeriodAttendanceRow {
  net_hours_worked?: unknown;
  hours_worked?: unknown;
  overtime_hours?: unknown;
  shift?: { overtime_multiplier?: unknown } | null;
}

export interface PeriodPayrollInputs {
  attendance: PeriodAttendanceRow[];
  /** Sum of working_days of approved unpaid leave overlapping the period. */
  unpaid_leave_days: number;
  hourly_rate: number;
  /** Existing record's manual_adjustment — MUST be carried into a regeneration
   *  or reimbursements silently vanish from gross/net. */
  manual_adjustment: number;
}

export interface PeriodPayrollTotals extends PayrollTotals {
  regular_hours: number;
  overtime_hours: number;
  base_pay: number;
  overtime_pay: number;
  unpaid_deduction: number;
  manual_adjustment: number;
}

/**
 * Full gross → tax → pension → net computation for one user's period.
 * - regular hours prefer net_hours_worked (gross minus unpaid breaks)
 * - overtime is paid per attendance record at that record's shift
 *   overtime_multiplier, falling back to 1.5 when absent
 * - unpaid leave is deducted at 8h × hourly_rate per working day
 * - manual_adjustment is included in gross (preserved across regeneration)
 */
export function computePeriodPayroll(
  inputs: PeriodPayrollInputs,
  taxRatePct: number,
  pensionRatePct: number,
): PeriodPayrollTotals {
  const rate = Number(inputs.hourly_rate) || 0;

  let regularHours = 0;
  let overtimeHours = 0;
  let overtimePay = 0;
  for (const row of inputs.attendance) {
    regularHours += Number(row.net_hours_worked ?? row.hours_worked ?? 0) || 0;
    const ot = Number(row.overtime_hours) || 0;
    if (ot > 0) {
      const multiplier = Number(row.shift?.overtime_multiplier) || DEFAULT_OVERTIME_MULTIPLIER;
      overtimeHours += ot;
      overtimePay   += ot * rate * multiplier;
    }
  }

  const basePay        = regularHours * rate;
  const dailyRate      = rate * 8;
  const unpaidDeduction = (Number(inputs.unpaid_leave_days) || 0) * dailyRate;
  const manualAdjustment = Number(inputs.manual_adjustment) || 0;

  const grossPay = Math.max(0, basePay + overtimePay - unpaidDeduction + manualAdjustment);
  const taxRate     = (Number(taxRatePct)     || 0) / 100;
  const pensionRate = (Number(pensionRatePct) || 0) / 100;
  const taxDeduction     = grossPay * taxRate;
  const pensionDeduction = grossPay * pensionRate;

  return {
    regular_hours:     regularHours,
    overtime_hours:    overtimeHours,
    base_pay:          basePay,
    overtime_pay:      overtimePay,
    unpaid_deduction:  unpaidDeduction,
    manual_adjustment: manualAdjustment,
    gross_pay:         grossPay,
    tax_deduction:     taxDeduction,
    pension_deduction: pensionDeduction,
    net_pay:           Math.max(0, grossPay - taxDeduction - pensionDeduction),
  };
}
