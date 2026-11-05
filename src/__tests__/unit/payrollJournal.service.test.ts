import { buildPayrollJournal, type JournalSourceRecord } from '../../services/payrollJournal';

const record = (overrides: Partial<JournalSourceRecord> = {}): JournalSourceRecord => ({
  period_month: 3,
  period_year: 2026,
  gross_pay: '1000.00',
  tax_deduction: '100.00',
  pension_deduction: '50.00',
  net_pay: '830.00',
  employee_statutory_deductions: [{ key: 'eobi', label: 'EOBI', amount: 20 }],
  employer_statutory_contributions: [{ key: 'eobi', label: 'EOBI', amount: 100 }],
  currency: 'PKR',
  ...overrides,
});

describe('buildPayrollJournal', () => {
  it('exports balanced account lines for processed payroll and employer contributions', () => {
    const lines = buildPayrollJournal([record()]);
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: '2026-03-31', account_code: 'EXP-PAYROLL', debit: 1000, credit: 0 }),
      expect.objectContaining({ account_code: 'LIAB-INCOME-TAX', debit: 0, credit: 100 }),
      expect.objectContaining({ account_code: 'LIAB-EMP-EOBI', debit: 0, credit: 20 }),
      expect.objectContaining({ account_code: 'LIAB-NET-PAY', debit: 0, credit: 830 }),
      expect.objectContaining({ account_code: 'EXP-ER-EOBI', debit: 100, credit: 0 }),
      expect.objectContaining({ account_code: 'LIAB-ER-EOBI', debit: 0, credit: 100 }),
    ]));
    expect(lines.reduce((sum, line) => sum + line.debit, 0)).toBe(1100);
    expect(lines.reduce((sum, line) => sum + line.credit, 0)).toBe(1100);
  });

  it('keeps currencies in separate balanced journal groups', () => {
    const lines = buildPayrollJournal([
      record(),
      record({ period_month: 4, period_year: 2026, currency: 'USD' }),
    ]);
    expect(new Set(lines.map(line => line.currency))).toEqual(new Set(['PKR', 'USD']));
    expect(new Set(lines.map(line => line.period))).toEqual(new Set(['2026-03', '2026-04']));
  });

  it('rejects unbalanced source payroll rather than exporting a false journal', () => {
    expect(() => buildPayrollJournal([record({ net_pay: 900 })])).toThrow(/out of balance/);
  });

  it('does not emit zero-value lines', () => {
    const lines = buildPayrollJournal([record({
      tax_deduction: 0,
      pension_deduction: 0,
      employee_statutory_deductions: [],
      employer_statutory_contributions: [],
      net_pay: 1000,
    })]);
    expect(lines).toHaveLength(2);
    expect(lines.every(line => line.debit > 0 || line.credit > 0)).toBe(true);
  });
});
