ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "leave_start_time" VARCHAR(10);
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "leave_end_time" VARCHAR(10);
