-- Idempotent flag so the late-arrival detector alerts a manager exactly once.
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS late_alerted BOOLEAN NOT NULL DEFAULT false;
