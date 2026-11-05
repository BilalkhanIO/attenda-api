ALTER TABLE "whatsapp_notification_logs"
  ADD COLUMN "provider_message_id" VARCHAR(255),
  ADD COLUMN "provider_status" VARCHAR(20),
  ADD COLUMN "provider_status_at" TIMESTAMP(3),
  ADD COLUMN "pricing_category" VARCHAR(40),
  ADD COLUMN "pricing_model" VARCHAR(40),
  ADD COLUMN "pricing_billable" BOOLEAN;

CREATE UNIQUE INDEX "whatsapp_notification_logs_provider_message_id_key"
  ON "whatsapp_notification_logs"("provider_message_id");
