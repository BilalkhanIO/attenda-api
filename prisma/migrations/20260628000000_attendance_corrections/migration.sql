CREATE TABLE IF NOT EXISTS "attendance_corrections" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "attendance_id" TEXT,
  "date" DATE NOT NULL,
  "requested_check_in" TIMESTAMP(3),
  "requested_check_out" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reviewed_by" TEXT,
  "review_note" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_corrections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "attendance_corrections_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "attendance_corrections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "attendance_corrections_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "attendance_corrections_org_id_status_idx" ON "attendance_corrections"("org_id", "status");
