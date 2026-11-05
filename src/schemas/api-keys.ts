import { z } from 'zod';
import { PUBLIC_API_SCOPES } from '../constants/public-api';

export const createPublicApiKeySchema = z.object({
  name: z.string().trim().min(2).max(120),
  scopes: z.array(z.enum(PUBLIC_API_SCOPES)).min(1).max(PUBLIC_API_SCOPES.length),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});

export const employeeDirectoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(100).optional(),
});

export const attendanceExportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(value => value.to >= value.from, { message: '`to` must be on or after `from`', path: ['to'] });

export const leaveExportQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
