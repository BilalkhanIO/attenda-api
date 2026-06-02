ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS early_checkin_minutes INT NOT NULL DEFAULT 0;
