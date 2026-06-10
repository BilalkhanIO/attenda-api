// @ts-nocheck
jest.mock('../../services/s3', () => ({
  isS3Configured: () => false,
  S3Keys: { reportCsv: () => 'test-key' },
  uploadBuffer: jest.fn(),
  getSignedDownloadUrl: jest.fn(),
}));

import { generateAttendanceCsv, generatePayrollCsv, generateLeaveCsv, generatePerformanceCsv } from '../../services/csvExport';

// Without S3 the service returns a base64 data URI the browser downloads directly.
const DATA_URI_PREFIX = 'data:text/csv;charset=utf-8;base64,';
const decodeCsv = (uri: string) =>
  Buffer.from(uri.slice(DATA_URI_PREFIX.length), 'base64').toString('utf-8');

describe('CSV Export Service', () => {
  const orgId = 'org-test';

  describe('generateAttendanceCsv', () => {
    it('returns a CSV data URI with record values in dev mode', async () => {
      const records = [
        {
          date: new Date('2025-06-01'),
          user: { name: 'Alice', department: 'Engineering' },
          check_in_at:  new Date('2025-06-01T09:00:00'),
          check_out_at: new Date('2025-06-01T17:00:00'),
          hours_worked:  8,
          status:        'out',
          check_in_type: 'auto_ip',
          is_overridden: false,
          override_reason: null,
        },
      ];
      const result = await generateAttendanceCsv(orgId, records);
      expect(result.startsWith(DATA_URI_PREFIX)).toBe(true);
      const csv = decodeCsv(result);
      expect(csv).toContain('"Date","Employee","Department"');
      expect(csv).toContain('Alice');
      expect(csv).toContain('2025-06-01');
      expect(csv).toContain('auto_ip');
    });
  });

  describe('generatePayrollCsv', () => {
    it('returns a CSV data URI with payroll figures in dev mode', async () => {
      const records = [
        {
          user: { name: 'Bob', department: 'HR' },
          regular_hours:    160,
          overtime_hours:   10,
          hourly_rate:      25,
          base_pay:         4000,
          overtime_pay:     375,
          unpaid_deduction: 0,
          manual_adjustment: 0,
          gross_pay:        4375,
          status:           'draft',
        },
      ];
      const result = await generatePayrollCsv(orgId, records, 6, 2025);
      expect(result.startsWith(DATA_URI_PREFIX)).toBe(true);
      const csv = decodeCsv(result);
      expect(csv).toContain('Bob');
      expect(csv).toContain('4375.00');
      expect(csv).toContain('draft');
    });
  });

  describe('generateLeaveCsv', () => {
    it('returns a CSV data URI with leave details in dev mode', async () => {
      const requests = [
        {
          user:             { name: 'Chloe', department: 'Marketing' },
          reviewer:         { name: 'Sarah HR' },
          leave_type:       'annual',
          start_date:       new Date('2025-06-10'),
          end_date:         new Date('2025-06-14'),
          working_days:     5,
          status:           'approved',
          rejection_reason: null,
          created_at:       new Date('2025-05-20'),
        },
      ];
      const result = await generateLeaveCsv(orgId, requests);
      expect(result.startsWith(DATA_URI_PREFIX)).toBe(true);
      const csv = decodeCsv(result);
      expect(csv).toContain('Chloe');
      expect(csv).toContain('annual');
      expect(csv).toContain('Sarah HR');
    });
  });

  describe('generatePerformanceCsv', () => {
    it('returns a CSV data URI with review scores in dev mode', async () => {
      const reviews = [
        {
          user:             { name: 'David', department: 'Sales' },
          manager_rating:   4,
          attendance_score: 95,
          overall_score:    80,
          notes:            'Good performance',
          submitted_at:     new Date('2025-06-30'),
        },
      ];
      const result = await generatePerformanceCsv(orgId, reviews, 6, 2025);
      expect(result.startsWith(DATA_URI_PREFIX)).toBe(true);
      const csv = decodeCsv(result);
      expect(csv).toContain('David');
      expect(csv).toContain('6/2025');
      expect(csv).toContain('95.0');
    });
  });
});
