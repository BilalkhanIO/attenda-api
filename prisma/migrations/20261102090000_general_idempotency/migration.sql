CREATE TABLE "idempotency_records" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "state" VARCHAR(20) NOT NULL DEFAULT 'processing',
  "status_code" INTEGER,
  "response_body" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_org_id_user_id_key_key"
  ON "idempotency_records"("org_id", "user_id", "key");
CREATE INDEX "idempotency_records_expires_at_idx"
  ON "idempotency_records"("expires_at");
