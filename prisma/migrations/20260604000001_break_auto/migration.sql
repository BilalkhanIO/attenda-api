ALTER TABLE break_records ADD COLUMN IF NOT EXISTS auto_started   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE break_records ADD COLUMN IF NOT EXISTS shift_break_id TEXT     REFERENCES shift_breaks(id) ON DELETE SET NULL;
