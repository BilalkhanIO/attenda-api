ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "absent_alerted" BOOLEAN NOT NULL DEFAULT false;
