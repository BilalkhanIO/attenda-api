import { z } from 'zod';

// Wave-1 request schemas (auth, leave, users). Shape/type validation only —
// business rules (balances, role escalation, uniqueness) stay in handlers.
// Conventions: dates are 'YYYY-MM-DD', wall-clock times are 'HH:mm'.

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, 'Expected HH:mm');
const totpCode = z.coerce.string().regex(/^\d{6}$/, 'Expected a 6-digit code');

// ─── Auth ─────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password required'),
});

export const registerSchema = z.object({
  org_name: z.string().trim().min(1, 'Organisation name required'),
  name: z.string().trim().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  timezone: z.string().optional(),
  currency: z.string().max(10).optional(),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export const setupAccountSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

export const totpVerifySchema = z.object({ code: totpCode });

export const totpAuthenticateSchema = z.object({
  partial_token: z.string().min(1),
  code: totpCode,
});

// ─── Leave ────────────────────────────────────────────
export const leaveRequestSchema = z
  .object({
    // free string, not enum: orgs may use custom leave types; balance rules
    // are enforced in the handler
    leave_type: z.string().trim().min(1),
    start_date: dateStr,
    end_date: dateStr,
    reason: z.string().max(1000).optional(),
    is_half_day: z.boolean().optional(),
    half_day_period: z.enum(['morning', 'afternoon']).optional(),
    leave_start_time: timeStr.optional(),
    leave_end_time: timeStr.optional(),
  })
  .refine(d => d.end_date >= d.start_date, {
    message: 'end_date must be on or after start_date',
    path: ['end_date'],
  });

// ─── Users ────────────────────────────────────────────
const ORG_ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'] as const;

export const createUserSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  role: z.enum(ORG_ROLES),
  department: z.string().max(100).nullish(),
  department_id: z.string().nullish(),
  job_title: z.string().max(100).nullish(),
  phone: z.string().max(30).nullish(),
  hourly_rate: z.coerce.number().min(0).optional(),
  manager_id: z.string().nullish(),
  employment_type: z.string().max(30).nullish(),
  joined_at: dateStr.nullish(),
  national_id: z.string().max(100).nullish(),
});

export const updateUserSchema = createUserSchema
  .partial()
  .extend({
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
  });
