import { z } from 'zod';

export const approvalsQuerySchema = z.object({
  type: z.enum(['all', 'leave', 'overtime', 'remote', 'swap', 'late_notice', 'expense', 'correction']).optional().default('all'),
});

export const approvalReviewSchema = z.object({
  type: z.enum(['leave', 'overtime', 'remote', 'swap', 'late_notice', 'expense', 'correction']),
  id: z.string().min(1),
  action: z.enum(['approve', 'reject', 'acknowledge']),
  reason: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
});
