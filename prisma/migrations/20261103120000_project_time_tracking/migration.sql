ALTER TABLE "projects" ADD COLUMN "budget_hours" DECIMAL(10,2);

CREATE TABLE "time_entries" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "project_id" TEXT,
  "task_id" TEXT,
  "attendance_id" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "minutes" INTEGER NOT NULL DEFAULT 0,
  "source" VARCHAR(20) NOT NULL DEFAULT 'manual',
  "billable" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "description" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "time_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "time_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "time_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "time_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "project_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "time_entries_org_user_started_id_idx" ON "time_entries"("org_id", "user_id", "started_at" DESC, "id");
CREATE INDEX "time_entries_org_project_started_idx" ON "time_entries"("org_id", "project_id", "started_at");
CREATE INDEX "time_entries_org_status_started_idx" ON "time_entries"("org_id", "status", "started_at");
CREATE UNIQUE INDEX "time_entries_one_running_timer_per_user" ON "time_entries"("org_id", "user_id") WHERE "ended_at" IS NULL;

CREATE TABLE "timesheets" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "week_start" DATE NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "submitted_at" TIMESTAMP(3),
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_note" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "timesheets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "timesheets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "timesheets_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "timesheets_org_user_week_start_key" ON "timesheets"("org_id", "user_id", "week_start");
CREATE INDEX "timesheets_org_status_submitted_idx" ON "timesheets"("org_id", "status", "submitted_at");
