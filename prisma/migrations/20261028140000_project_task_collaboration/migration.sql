ALTER TABLE "project_tasks"
  ADD COLUMN IF NOT EXISTS "start_date" DATE,
  ADD COLUMN IF NOT EXISTS "parent_task_id" TEXT,
  ADD COLUMN IF NOT EXISTS "is_milestone" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_parent_task_id_fkey"
    FOREIGN KEY ("parent_task_id") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_task_dependencies" (
  "task_id" TEXT NOT NULL,
  "depends_on_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_task_dependencies_pkey" PRIMARY KEY ("task_id", "depends_on_id")
);
DO $$ BEGIN
  ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_depends_on_id_fkey"
    FOREIGN KEY ("depends_on_id") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_task_comments" (
  "id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_task_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "project_task_comments_task_id_created_at_idx" ON "project_task_comments"("task_id", "created_at");
DO $$ BEGIN
  ALTER TABLE "project_task_comments" ADD CONSTRAINT "project_task_comments_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "project_task_comments" ADD CONSTRAINT "project_task_comments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
