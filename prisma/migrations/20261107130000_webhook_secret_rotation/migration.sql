ALTER TABLE "org_webhooks"
  ADD COLUMN "previous_secret" TEXT,
  ADD COLUMN "previous_secret_expires_at" TIMESTAMP(3);

ALTER TABLE "org_webhook_deliveries"
  ADD COLUMN "previous_signature" VARCHAR(64),
  ADD COLUMN "previous_signature_expires_at" TIMESTAMP(3);
