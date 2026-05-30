-- Change performance_goals.completion from TEXT to INTEGER
-- Convert existing "pending" (and any non-numeric) values to 0; numeric strings are cast directly
ALTER TABLE performance_goals
  ALTER COLUMN completion TYPE INTEGER
  USING CASE WHEN completion ~ '^[0-9]+$' THEN completion::INTEGER ELSE 0 END;

ALTER TABLE performance_goals ALTER COLUMN completion SET DEFAULT 0;
