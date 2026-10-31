ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "performance_goal_id" TEXT;
DO $$ BEGIN
  ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_performance_goal_id_fkey" FOREIGN KEY ("performance_goal_id") REFERENCES "performance_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_attachments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "task_id" TEXT,
  "uploaded_by" TEXT NOT NULL,
  "file_key" TEXT NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "file_size" INTEGER NOT NULL,
  "mime_type" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_attachments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "project_attachments_project_id_created_at_idx" ON "project_attachments"("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "project_attachments_task_id_idx" ON "project_attachments"("task_id");
DO $$ BEGIN
  ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
