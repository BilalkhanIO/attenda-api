ALTER TABLE "attendance_devices"
  ADD COLUMN "checkin_challenge_hash" VARCHAR(64),
  ADD COLUMN "checkin_challenge_request_hash" VARCHAR(64),
  ADD COLUMN "checkin_challenge_expires_at" TIMESTAMP(3);

ALTER TABLE "attendance_records"
  ADD COLUMN "attendance_device_id" TEXT,
  ADD COLUMN "device_proof_status" VARCHAR(20),
  ADD COLUMN "device_signature_verified" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "attendance_records_org_device_checkin_idx"
  ON "attendance_records"("org_id", "attendance_device_id", "check_in_at");
