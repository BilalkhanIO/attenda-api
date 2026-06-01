-- Half-day leave support
-- working_days changes from INT to FLOAT to allow 0.5
ALTER TABLE leave_requests ALTER COLUMN working_days TYPE FLOAT USING working_days::FLOAT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS is_half_day     BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS half_day_period VARCHAR(20);
