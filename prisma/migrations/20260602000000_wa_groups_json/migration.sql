-- Convert wa_group_ids (String[]) to wa_groups (JSONB array of {id,name,phone} objects)
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS wa_groups JSONB NOT NULL DEFAULT '[]';

-- Migrate existing phone-string rows to object format
UPDATE organisations
SET wa_groups = COALESCE(
  (SELECT jsonb_agg(
     jsonb_build_object('id', val, 'name', val, 'phone', val)
   )
   FROM unnest(wa_group_ids) AS val),
  '[]'::jsonb
)
WHERE array_length(wa_group_ids, 1) IS NOT NULL;

-- Drop old column (idempotent: no-op if already removed)
ALTER TABLE organisations DROP COLUMN IF EXISTS wa_group_ids;
