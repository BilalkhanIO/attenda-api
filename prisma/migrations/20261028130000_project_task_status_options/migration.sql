ALTER TABLE "projects"
ADD COLUMN IF NOT EXISTS "status_options" TEXT[] NOT NULL DEFAULT ARRAY['todo', 'in_progress', 'blocked', 'done']::TEXT[];
