import prisma from '../utils/prisma';
import { statutoryParameterSetSchema, type StatutoryParameterSetInput } from '../schemas/statutory-payroll';
import type { PayrollTotals } from '../utils/payroll';

function money(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function calculateAnnualProgressiveTax(annualTaxableIncome: number, slabs: StatutoryParameterSetInput['annual_tax_slabs']): number {
  const income = Math.max(0, annualTaxableIncome);
  const slab = slabs.find(row => income >= row.lower_bound && (row.upper_bound === null || income < row.upper_bound));
  if (!slab) return 0;
  return money(slab.base_tax + Math.max(0, income - slab.lower_bound) * slab.marginal_rate_pct / 100);
}

export async function calculateStatutoryPayroll(input: { orgId: string; userId: string; year: number; month: number; grossPay: number }) {
  const periodEnd = new Date(Date.UTC(input.year, input.month, 0));
  const org = await prisma.organisation.findUnique({ where: { id: input.orgId }, select: { country_code: true } });
  if (!org?.country_code) return null;
  const set = await prisma.statutoryParameterSet.findFirst({
    where: {
      org_id: input.orgId, country_code: org.country_code, status: 'active', effective_from: { lte: periodEnd },
      OR: [{ effective_to: null }, { effective_to: { gte: periodEnd } }],
    },
    orderBy: [{ effective_from: 'desc' }, { created_at: 'desc' }],
  });
  if (!set) return null;
  const parsed = statutoryParameterSetSchema.safeParse({
    country_code: set.country_code,
    effective_from: set.effective_from.toISOString().slice(0, 10),
    effective_to: set.effective_to?.toISOString().slice(0, 10) ?? null,
    source_reference: set.source_reference,
    annual_tax_slabs: set.annual_tax_slabs,
    contributions: set.contributions,
  });
  if (!parsed.success) throw new Error(`Active statutory parameter set ${set.id} is invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);

  const previous = await prisma.payrollRecord.findMany({
    where: { org_id: input.orgId, user_id: input.userId, period_year: input.year, period_month: { lt: input.month }, status: { not: 'recalled' } },
    select: { gross_pay: true, tax_deduction: true },
  });
  const priorTaxableGross = previous.reduce((sum, row) => sum + Number(row.gross_pay), 0);
  const priorTaxWithheld = previous.reduce((sum, row) => sum + Number(row.tax_deduction), 0);
  const monthsRemaining = 13 - input.month;
  const hasSlabs = parsed.data.annual_tax_slabs.length > 0;
  const annualTax = hasSlabs
    ? calculateAnnualProgressiveTax(priorTaxableGross + Math.max(0, input.grossPay) * monthsRemaining, parsed.data.annual_tax_slabs)
    : 0;
  const taxDeduction = hasSlabs ? money(Math.max(0, (annualTax - priorTaxWithheld) / monthsRemaining)) : null;

  const employeeDeductions: Array<{ key: string; label: string; amount: number }> = [];
  const employerContributions: Array<{ key: string; label: string; amount: number }> = [];
  for (const contribution of parsed.data.contributions) {
    const base = Math.max(0, contribution.wage_base_cap_monthly === null
      ? input.grossPay
      : Math.min(input.grossPay, contribution.wage_base_cap_monthly));
    const employeeAmount = money(base * contribution.employee_rate_pct / 100);
    const employerAmount = money(base * contribution.employer_rate_pct / 100);
    if (employeeAmount) employeeDeductions.push({ key: contribution.key, label: contribution.label, amount: employeeAmount });
    if (employerAmount) employerContributions.push({ key: contribution.key, label: contribution.label, amount: employerAmount });
  }
  return {
    setId: set.id,
    countryCode: set.country_code,
    taxCalculationMethod: hasSlabs ? 'projected_annual' : 'flat_percent',
    taxDeduction,
    employeeDeductions,
    employerContributions,
  };
}

export async function applyStatutoryPayroll<T extends PayrollTotals>(input: { orgId: string; userId: string; year: number; month: number }, totals: T) {
  const statutory = await calculateStatutoryPayroll({ ...input, grossPay: totals.gross_pay });
  if (!statutory) return {
    totals,
    statutory_parameter_set_id: null as string | null,
    tax_calculation_method: 'flat_percent',
    employee_statutory_deductions: [] as Array<{ key: string; label: string; amount: number }>,
    employer_statutory_contributions: [] as Array<{ key: string; label: string; amount: number }>,
  };
  const employeeContributionTotal = statutory.employeeDeductions.reduce((sum, item) => sum + item.amount, 0);
  const taxDeduction = statutory.taxDeduction ?? totals.tax_deduction;
  return {
    totals: {
      ...totals,
      tax_deduction: taxDeduction,
      net_pay: Math.max(0, Math.round((totals.gross_pay - taxDeduction - totals.pension_deduction - employeeContributionTotal) * 100) / 100),
    },
    statutory_parameter_set_id: statutory.setId,
    tax_calculation_method: statutory.taxCalculationMethod,
    employee_statutory_deductions: statutory.employeeDeductions,
    employer_statutory_contributions: statutory.employerContributions,
  };
}
