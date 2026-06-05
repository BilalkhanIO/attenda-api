ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS extra_office_minutes INT NOT NULL DEFAULT 0;

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS overtime_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overtime_requires_approval BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS extra_time_label VARCHAR(100) NOT NULL DEFAULT 'Extra office time';

ALTER TABLE shift_breaks
  ADD COLUMN IF NOT EXISTS break_kind VARCHAR(20) NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS allowed_count_per_shift INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS paid_within_limit BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deduct_extra_time BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_extra_breaks BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS applies_days INT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exception_dates TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE break_records
  ADD COLUMN IF NOT EXISTS limit_exceeded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS counted_as_extra BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS overtime_requests (
  id TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  attendance_id TEXT NOT NULL UNIQUE REFERENCES attendance_records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organisations(id),
  requested_minutes INT NOT NULL,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
