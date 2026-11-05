export interface JournalSourceRecord {
  period_month: number;
  period_year: number;
  gross_pay: unknown;
  tax_deduction: unknown;
  pension_deduction: unknown;
  net_pay: unknown;
  employee_statutory_deductions: unknown;
  employer_statutory_contributions: unknown;
  currency: string;
}

export interface PayrollJournalLine {
  date: string;
  period: string;
  currency: string;
  account_code: string;
  account_name: string;
  description: string;
  debit: number;
  credit: number;
  source_records: number;
}

const amount = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const accountSuffix = (key: string) => key.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'OTHER';

/**
 * Convert finalized payroll into balanced, account-aggregated journal lines.
 * This is an accounting export only; it does not create or initiate payments.
 */
export function buildPayrollJournal(records: JournalSourceRecord[]): PayrollJournalLine[] {
  const groups = new Map<string, JournalSourceRecord[]>();
  for (const record of records) {
    const currency = String(record.currency || 'USD').toUpperCase();
    if (!/^[A-Z]{3,10}$/.test(currency)) throw new Error(`Invalid payroll currency code: ${currency}`);
    const period = `${record.period_year}-${String(record.period_month).padStart(2, '0')}`;
    const key = `${period}:${currency}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...record, currency }]);
  }

  const lines: PayrollJournalLine[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const period = `${first.period_year}-${String(first.period_month).padStart(2, '0')}`;
    const date = new Date(Date.UTC(first.period_year, first.period_month, 0)).toISOString().slice(0, 10);
    const sourceRecords = group.length;
    const sum = (field: 'gross_pay' | 'tax_deduction' | 'pension_deduction' | 'net_pay') => roundMoney(group.reduce((total, row) => total + amount(row[field]), 0));
    const statutoryTotals = (field: 'employee_statutory_deductions' | 'employer_statutory_contributions') => {
      const result = new Map<string, { label: string; amount: number }>();
      for (const row of group) {
        if (!Array.isArray(row[field])) continue;
        for (const item of row[field] as Array<{ key?: unknown; label?: unknown; amount?: unknown }>) {
          const key = typeof item?.key === 'string' ? item.key.trim() : '';
          if (!key) continue;
          const current = result.get(key) ?? { label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : key, amount: 0 };
          current.amount += amount(item.amount);
          result.set(key, current);
        }
      }
      return [...result.entries()].map(([key, value]) => ({ key, label: value.label, amount: roundMoney(value.amount) })).filter(value => value.amount > 0);
    };

    const employeeStatutory = statutoryTotals('employee_statutory_deductions');
    const employerStatutory = statutoryTotals('employer_statutory_contributions');
    const groupLines: PayrollJournalLine[] = [];
    const add = (account_code: string, account_name: string, description: string, debit: number, credit: number) => {
      const dr = roundMoney(debit);
      const cr = roundMoney(credit);
      if (dr || cr) groupLines.push({ date, period, currency: first.currency, account_code, account_name, description, debit: dr, credit: cr, source_records: sourceRecords });
    };

    add('EXP-PAYROLL', 'Payroll expense', `Gross payroll ${period}`, sum('gross_pay'), 0);
    add('LIAB-INCOME-TAX', 'Income tax payable', `Employee income tax ${period}`, 0, sum('tax_deduction'));
    add('LIAB-PENSION', 'Employee pension payable', `Employee pension deductions ${period}`, 0, sum('pension_deduction'));
    for (const item of employeeStatutory) {
      add(`LIAB-EMP-${accountSuffix(item.key)}`, `${item.label} payable`, `Employee ${item.label} deductions ${period}`, 0, item.amount);
    }
    add('LIAB-NET-PAY', 'Net payroll payable', `Net payroll ${period}`, 0, sum('net_pay'));
    for (const item of employerStatutory) {
      const suffix = accountSuffix(item.key);
      add(`EXP-ER-${suffix}`, `${item.label} employer expense`, `Employer ${item.label} contribution ${period}`, item.amount, 0);
      add(`LIAB-ER-${suffix}`, `${item.label} employer payable`, `Employer ${item.label} contribution ${period}`, 0, item.amount);
    }

    const debitTotal = roundMoney(groupLines.reduce((total, line) => total + line.debit, 0));
    const creditTotal = roundMoney(groupLines.reduce((total, line) => total + line.credit, 0));
    if (Math.abs(debitTotal - creditTotal) > 0.01) {
      throw new Error(`Processed payroll journal is out of balance for ${period} ${first.currency}: debits ${debitTotal.toFixed(2)}, credits ${creditTotal.toFixed(2)}`);
    }
    lines.push(...groupLines);
  }

  return lines.sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency) || a.account_code.localeCompare(b.account_code));
}
