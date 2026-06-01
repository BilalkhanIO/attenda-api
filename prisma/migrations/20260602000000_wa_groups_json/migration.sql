-- Convert wa_group_ids (String[]) → wa_groups (JSONB) — fully idempotent
DO $$
BEGIN
  -- 1. Add wa_groups column if it doesn't exist yet
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organisations' AND column_name = 'wa_groups'
  ) THEN
    ALTER TABLE organisations ADD COLUMN wa_groups JSONB NOT NULL DEFAULT '[]';
  END IF;

  -- 2. Migrate data from wa_group_ids (if that column still exists)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organisations' AND column_name = 'wa_group_ids'
  ) THEN
    -- Convert each phone string to a {id, name, phone} object; rows with empty arrays keep '[]'
    UPDATE organisations
    SET wa_groups = COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id', val, 'name', val, 'phone', val))
       FROM unnest(wa_group_ids) AS val),
      '[]'::jsonb
    )
    WHERE wa_groups = '[]'::jsonb;

    ALTER TABLE organisations DROP COLUMN wa_group_ids;
  END IF;
END $$;
