CREATE TABLE "scheduler_job_states" (
  "job_key" VARCHAR(100) NOT NULL,
  "last_started_at" TIMESTAMP(3),
  "last_success_at" TIMESTAMP(3),
  "last_error" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "scheduler_job_states_pkey" PRIMARY KEY ("job_key")
);

CREATE TABLE "scheduler_job_markers" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "job_key" VARCHAR(100) NOT NULL,
  "subject_id" VARCHAR(100) NOT NULL,
  "period_key" VARCHAR(80) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'processing',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "scheduler_job_markers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scheduler_job_markers_org_job_subject_period_key" ON "scheduler_job_markers"("org_id", "job_key", "subject_id", "period_key");
CREATE INDEX "scheduler_job_markers_status_locked_at_idx" ON "scheduler_job_markers"("status", "locked_at");
CREATE INDEX "scheduler_job_markers_created_at_idx" ON "scheduler_job_markers"("created_at");
ALTER TABLE "in_app_notifications" ADD COLUMN "dedupe_key" VARCHAR(120);
CREATE UNIQUE INDEX "in_app_notifications_org_user_dedupe_key" ON "in_app_notifications"("org_id", "user_id", "dedupe_key");
ALTER TABLE "scheduler_job_markers" ADD CONSTRAINT "scheduler_job_markers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
