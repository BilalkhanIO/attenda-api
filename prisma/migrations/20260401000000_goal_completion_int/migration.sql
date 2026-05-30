-- Change performance_goals.completion from TEXT to INTEGER (idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'performance_goals'
      AND column_name  = 'completion'
      AND data_type    IN ('text', 'character varying')
  ) THEN
    -- Sanitise non-numeric values before casting
    UPDATE performance_goals
       SET completion = '0'
     WHERE completion !~ '^[0-9]+$';

    ALTER TABLE performance_goals
      ALTER COLUMN completion TYPE INTEGER
      USING completion::INTEGER;

    ALTER TABLE performance_goals
      ALTER COLUMN completion SET DEFAULT 0;
  END IF;
END $$;
