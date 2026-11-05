CREATE TABLE "attendance_sync_watermarks" (
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "last_sequence" INTEGER NOT NULL DEFAULT 0,
  "pending_until" TIMESTAMP(3),
  "last_sync_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attendance_sync_watermarks_pkey" PRIMARY KEY ("org_id", "user_id")
);

CREATE INDEX "attendance_sync_watermarks_org_id_pending_until_idx" ON "attendance_sync_watermarks"("org_id", "pending_until");
ALTER TABLE "attendance_sync_watermarks" ADD CONSTRAINT "attendance_sync_watermarks_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_sync_watermarks" ADD CONSTRAINT "attendance_sync_watermarks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
