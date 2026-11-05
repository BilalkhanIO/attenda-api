ALTER TABLE "attendance_records"
  ADD COLUMN "checkout_idempotency_key" VARCHAR(100),
  ADD COLUMN "checkout_request_hash" VARCHAR(64);

CREATE UNIQUE INDEX "attendance_records_user_id_checkout_idempotency_key_key"
  ON "attendance_records"("user_id", "checkout_idempotency_key");

ALTER TABLE "break_records"
  ADD COLUMN "start_idempotency_key" VARCHAR(100),
  ADD COLUMN "start_request_hash" VARCHAR(64),
  ADD COLUMN "end_idempotency_key" VARCHAR(100),
  ADD COLUMN "end_request_hash" VARCHAR(64);

CREATE UNIQUE INDEX "break_records_start_idempotency_key_key"
  ON "break_records"("start_idempotency_key");
CREATE UNIQUE INDEX "break_records_end_idempotency_key_key"
  ON "break_records"("end_idempotency_key");
