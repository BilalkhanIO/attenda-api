CREATE TABLE "attendance_devices" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "label" VARCHAR(100) NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "public_key" TEXT NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "enrollment_challenge_hash" VARCHAR(64),
  "challenge_expires_at" TIMESTAMP(3),
  "key_proven_at" TIMESTAMP(3),
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attendance_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_devices_user_id_fingerprint_key" ON "attendance_devices"("user_id", "fingerprint");
CREATE INDEX "attendance_devices_org_id_status_created_at_idx" ON "attendance_devices"("org_id", "status", "created_at");
CREATE INDEX "attendance_devices_user_id_status_idx" ON "attendance_devices"("user_id", "status");
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
