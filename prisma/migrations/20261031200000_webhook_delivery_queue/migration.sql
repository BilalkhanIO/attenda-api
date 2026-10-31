CREATE TABLE "org_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT,
    "org_id" TEXT NOT NULL,
    "event" VARCHAR(60) NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "signature" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "response_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "org_webhook_deliveries_status_next_attempt_at_idx"
ON "org_webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "org_webhook_deliveries_webhook_id_created_at_idx"
ON "org_webhook_deliveries"("webhook_id", "created_at" DESC);
CREATE INDEX "org_webhook_deliveries_org_id_created_at_idx"
ON "org_webhook_deliveries"("org_id", "created_at" DESC);

ALTER TABLE "org_webhook_deliveries"
ADD CONSTRAINT "org_webhook_deliveries_webhook_id_fkey"
FOREIGN KEY ("webhook_id") REFERENCES "org_webhooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "org_webhook_deliveries"
ADD CONSTRAINT "org_webhook_deliveries_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
