CREATE TABLE "organization_job_schedules" (
  "org_id" TEXT NOT NULL,
  "job_key" VARCHAR(100) NOT NULL,
  "timezone" VARCHAR(100) NOT NULL,
  "schedule_config" VARCHAR(160) NOT NULL,
  "next_run_at" TIMESTAMP(3) NOT NULL,
  "last_run_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_job_schedules_pkey" PRIMARY KEY ("org_id", "job_key")
);
CREATE INDEX "organization_job_schedules_job_key_next_run_at_org_id_idx" ON "organization_job_schedules"("job_key", "next_run_at", "org_id");
ALTER TABLE "organization_job_schedules" ADD CONSTRAINT "organization_job_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
