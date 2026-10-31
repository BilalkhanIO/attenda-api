ALTER TABLE "attendance_records"
ADD COLUMN "client_checkin_at" TIMESTAMP(3),
ADD COLUMN "checkin_received_at" TIMESTAMP(3),
ADD COLUMN "checkin_idempotency_key" VARCHAR(100),
ADD COLUMN "offline_reconciled" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "attendance_records_user_id_checkin_idempotency_key_key"
ON "attendance_records"("user_id", "checkin_idempotency_key");
