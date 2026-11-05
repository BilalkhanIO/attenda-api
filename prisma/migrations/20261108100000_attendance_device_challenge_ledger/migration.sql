ALTER TABLE "attendance_devices"
  DROP COLUMN "checkin_challenge_hash",
  DROP COLUMN "checkin_challenge_request_hash",
  DROP COLUMN "checkin_challenge_expires_at";

CREATE TABLE "attendance_device_challenges" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "challenge_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_device_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_device_challenges_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_device_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_device_challenges_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "attendance_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "attendance_device_challenges_challenge_hash_key"
  ON "attendance_device_challenges"("challenge_hash");
CREATE INDEX "attendance_device_challenges_org_user_device_expiry_idx"
  ON "attendance_device_challenges"("org_id", "user_id", "device_id", "expires_at");
CREATE INDEX "attendance_device_challenges_device_consumed_expiry_idx"
  ON "attendance_device_challenges"("device_id", "consumed_at", "expires_at");
