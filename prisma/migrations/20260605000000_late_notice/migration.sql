-- LateArrivalNotice table
CREATE TABLE IF NOT EXISTS late_arrival_notices (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  user_id         TEXT        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  org_id          TEXT        NOT NULL REFERENCES organisations(id)  ON DELETE CASCADE,
  date            DATE        NOT NULL,
  expected_time   VARCHAR(10) NOT NULL,
  reason          TEXT        NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, date)
);

-- New columns on attendance_records
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS hour_alerted         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS is_on_approved_leave BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS late_notice_id       TEXT    REFERENCES late_arrival_notices(id) ON DELETE SET NULL;
