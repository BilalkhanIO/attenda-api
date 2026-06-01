ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS last_heartbeat_at   TIMESTAMPTZ;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS last_heartbeat_ssid VARCHAR(100);
