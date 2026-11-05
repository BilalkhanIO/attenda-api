import { z } from 'zod';

export const approvalsQuerySchema = z.object({
  type: z.enum(['all', 'leave', 'overtime', 'remote', 'swap', 'late_notice', 'expense', 'correction', 'timesheet']).optional().default('all'),
  cursor_mode: z.enum(['true', 'false', '1', '0']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const approvalReviewSchema = z.object({
  type: z.enum(['leave', 'overtime', 'remote', 'swap', 'late_notice', 'expense', 'correction', 'timesheet']),
  id: z.string().min(1),
  action: z.enum(['approve', 'reject', 'acknowledge']),
  reason: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
});
