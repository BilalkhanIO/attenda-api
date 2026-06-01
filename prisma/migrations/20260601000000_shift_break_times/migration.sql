-- Add clock-time columns to shift_breaks (idempotent)
ALTER TABLE shift_breaks ADD COLUMN IF NOT EXISTS break_start_time VARCHAR(10);
ALTER TABLE shift_breaks ADD COLUMN IF NOT EXISTS break_end_time   VARCHAR(10);
