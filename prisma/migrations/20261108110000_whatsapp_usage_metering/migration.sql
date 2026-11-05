ALTER TABLE "organisations"
  ADD COLUMN "wa_monthly_message_limit" INTEGER DEFAULT 1000,
  ADD COLUMN "wa_alert_threshold_percent" INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN "wa_estimated_cost_per_message" DECIMAL(10,4);

CREATE TABLE "whatsapp_usage_periods" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "period_start" DATE NOT NULL,
  "messages_reserved" INTEGER NOT NULL DEFAULT 0,
  "priced_messages" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "threshold_alerted_at" TIMESTAMP(3),
  "quota_alerted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_usage_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_usage_periods_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "whatsapp_usage_periods_org_id_period_start_key"
  ON "whatsapp_usage_periods"("org_id", "period_start");
CREATE INDEX "whatsapp_usage_periods_org_id_period_start_idx"
  ON "whatsapp_usage_periods"("org_id", "period_start" DESC);
