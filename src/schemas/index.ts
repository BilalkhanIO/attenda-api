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

// FCM registration tokens are long opaque strings; min(20) rejects junk
// without pinning to an FCM-internal format.
export const deviceTokenSchema = z.object({
  token: z.string().min(20),
});

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

// ─── Wave 2 (attendance / shifts / overtime / payroll / org / departments) ──
// All wave-2 body schemas use .passthrough(): they validate the known field
// shapes without stripping fields the handlers may additionally read —
// behavior-preserving validation at the boundary.

export const checkinSchema = z.object({
  type: z.enum(['manual', 'qr', 'remote']).optional(),
  qr_code: z.string().optional(),
  duration_type: z.string().max(30).optional(),
  count_away_as_break: z.boolean().optional(),
  away_shift_break_id: z.string().optional(),
}).passthrough();

export const checkoutSchema = z.object({
  extra_office_minutes: z.coerce.number().int().min(0).optional(),
  force_checkout: z.boolean().optional(),
}).passthrough();

export const breakStartSchema = z.object({
  break_type: z.string().max(60).optional(),
  shift_break_id: z.string().optional(),
}).passthrough();

export const breakEndSchema = z.object({
  wifi_connected: z.boolean().optional(),
}).passthrough();

export const heartbeatSchema = z.object({
  ip: z.string().max(64).optional(),
  ssid: z.string().max(120).optional(),
}).passthrough();

export const ipEventSchema = z.object({
  event: z.string().min(1),
  ip: z.string().max(64).optional(),
  ssid: z.string().max(120).optional(),
  count_away_as_break: z.boolean().optional(),
  away_shift_break_id: z.string().optional(),
}).passthrough()
  .refine(d => (d.ip && d.ip.length > 0) || (d.ssid && d.ssid.length > 0), {
    message: 'ip or ssid is required',
    path: ['ip'],
  });

export const lateNoticeSchema = z.object({
  date: dateStr,
  expected_time: timeStr,
  reason: z.string().min(1).max(1000),
}).passthrough();

export const attendanceOverrideSchema = z.object({
  check_in_at: z.string().min(1).optional(),
  check_out_at: z.string().min(1).optional(),
  reason: z.string().min(1).max(1000),
}).passthrough();

// ─── Shifts ───────────────────────────────────────────
const shiftFields = {
  name: z.string().trim().min(1).max(100),
  start_time: timeStr,
  end_time: timeStr,
  color: z.string().max(20).optional(),
  active_days: z.array(z.number().int().min(0).max(6)).optional(),
  overtime_multiplier: z.coerce.number().min(1).optional(),
  min_rest_hours: z.coerce.number().min(0).optional(),
  late_tolerance_mins: z.coerce.number().int().min(0).optional(),
  early_checkout_tolerance_mins: z.coerce.number().int().min(0).optional(),
  auto_checkout: z.boolean().optional(),
  auto_checkout_buffer_mins: z.coerce.number().int().min(0).optional(),
  overtime_enabled: z.boolean().optional(),
  overtime_requires_approval: z.boolean().optional(),
  extra_time_label: z.string().max(60).optional(),
  is_org_wide: z.boolean().optional(),
  is_default: z.boolean().optional(),
};
export const createShiftSchema = z.object(shiftFields).passthrough();
export const updateShiftSchema = z.object({
  ...shiftFields,
  name: shiftFields.name.optional(),
  start_time: timeStr.optional(),
  end_time: timeStr.optional(),
}).passthrough();

export const shiftBreakSchema = z.object({
  name: z.string().trim().min(1).max(100),
  break_kind: z.enum(['fixed', 'flexible']).optional(),
  break_minutes: z.coerce.number().int().min(1).optional(),
  is_paid: z.boolean().optional(),
  after_minutes: z.coerce.number().int().min(0).optional(),
  break_start_time: timeStr.optional(),
  break_end_time: timeStr.optional(),
  allowed_count_per_shift: z.coerce.number().int().min(1).optional(),
}).passthrough();
export const updateShiftBreakSchema = shiftBreakSchema.extend({
  name: z.string().trim().min(1).max(100).optional(),
});

export const shiftAssignmentSchema = z.object({
  user_id: z.string().min(1),
  shift_id: z.string().min(1),
  date: dateStr,
}).passthrough();

export const bulkAssignmentSchema = z.object({
  assignments: z.array(shiftAssignmentSchema).min(1).max(500),
  dry_run: z.boolean().optional(),
}).passthrough();

export const publishScheduleSchema = z.object({
  from_date: dateStr,
  to_date: dateStr,
}).passthrough()
  .refine(d => d.to_date >= d.from_date, {
    message: 'to_date must be on or after from_date',
    path: ['to_date'],
  });

export const swapRequestSchema = z.object({
  target_id: z.string().min(1),
  reason: z.string().max(1000).optional(),
  requester_assign_id: z.string().optional(),
  target_assign_id: z.string().optional(),
}).passthrough();

// ─── Overtime ─────────────────────────────────────────
export const overtimeRequestSchema = z.object({
  attendance_id: z.string().min(1),
  reason: z.string().max(1000).optional(),
}).passthrough();

const overtimeRuleFields = {
  name: z.string().trim().min(1).max(100),
  rule_type: z.enum(['daily', 'weekly', 'seventh_day']),
  threshold_hours: z.coerce.number().min(0),
  multiplier: z.coerce.number().min(1),
  priority: z.coerce.number().int().optional(),
  is_active: z.boolean().optional(),
};
export const createOvertimeRuleSchema = z.object(overtimeRuleFields).passthrough();
export const updateOvertimeRuleSchema = z.object({
  ...overtimeRuleFields,
  name: overtimeRuleFields.name.optional(),
  rule_type: overtimeRuleFields.rule_type.optional(),
  threshold_hours: overtimeRuleFields.threshold_hours.optional(),
  multiplier: overtimeRuleFields.multiplier.optional(),
}).passthrough();

// ─── Payroll ──────────────────────────────────────────
export const payrollPeriodSchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
}).passthrough();

export const payrollAdjustSchema = z.object({
  field: z.enum(['regular_hours', 'overtime_hours', 'adjustments']),
  value: z.coerce.number(),
  reason: z.string().min(10).max(1000),
}).passthrough();

export const payrollRecallSchema = z.object({
  reason: z.string().min(10).max(1000),
}).passthrough();

// ─── Holidays ─────────────────────────────────────────
export const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  name: z.string().trim().min(1).max(120),
  recurring: z.coerce.boolean().optional(),
}).passthrough();

// ─── Org settings / departments ───────────────────────
export const orgSettingsSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  timezone: z.string().max(100).optional(),
  currency: z.string().max(10).optional(),
  payroll_day: z.coerce.number().int().min(1).max(28).optional(),
  tax_rate: z.coerce.number().min(0).max(100).optional(),
  pension_rate: z.coerce.number().min(0).max(100).optional(),
  late_threshold: z.coerce.number().int().min(0).max(120).optional(),
  heartbeat_grace_mins: z.coerce.number().int().min(10).max(120).optional(),
  gap_forgiveness_mins: z.coerce.number().int().min(0).max(90).optional(),
  totp_required: z.boolean().optional(),
  leave_accrual: z.record(
    z.string().min(1).max(40),
    z.object({
      days_per_year: z.coerce.number().min(0.5).max(366),
      carry_over_max: z.coerce.number().min(0).max(366).optional(),
    }),
  ).nullish(),
  late_policy: z.object({
    absent_after_mins: z.coerce.number().int().min(30).max(720).optional(),
    tiers: z.array(z.object({
      after_mins: z.coerce.number().int().min(1).max(720),
      points: z.coerce.number().min(0.5).max(100),
    })).max(10).optional(),
    points_window_days: z.coerce.number().int().min(7).max(365).optional(),
    alert_threshold_points: z.coerce.number().min(0.5).max(1000).optional(),
  }).nullish(),
  logo_url: z.string().max(1000).nullish(),
  address: z.string().max(2000).nullish(),
  phone: z.string().max(50).nullish(),
  website: z.string().max(255).nullish(),
  industry: z.string().max(100).nullish(),
  registration_number: z.string().max(100).nullish(),
}).passthrough();

export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parent_id: z.string().nullish(),
}).passthrough();
export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parent_id: z.string().nullish(),
}).passthrough();
