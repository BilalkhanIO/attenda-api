CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "report_type" VARCHAR(32) NOT NULL,
    "params" JSONB NOT NULL,
    "frequency" VARCHAR(16) NOT NULL,
    "local_time" VARCHAR(5) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "recipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "report_runs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "schedule_id" TEXT,
    "report_type" VARCHAR(32) NOT NULL,
    "params" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "scheduled_for" TIMESTAMP(3),
    "download_url" TEXT,
    "row_count" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_schedules_status_next_run_at_idx" ON "report_schedules"("status", "next_run_at");
CREATE INDEX "report_schedules_org_id_owner_id_created_at_idx" ON "report_schedules"("org_id", "owner_id", "created_at");
CREATE UNIQUE INDEX "report_runs_schedule_id_scheduled_for_key" ON "report_runs"("schedule_id", "scheduled_for");
CREATE INDEX "report_runs_org_id_owner_id_created_at_idx" ON "report_runs"("org_id", "owner_id", "created_at");

ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "report_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
