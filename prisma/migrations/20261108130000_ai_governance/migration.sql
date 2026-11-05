ALTER TABLE "organisations"
  ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "ai_monthly_request_limit" INTEGER;

CREATE TABLE "ai_usage_periods" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "period_start" DATE NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "prompt_tokens" BIGINT NOT NULL DEFAULT 0,
  "completion_tokens" BIGINT NOT NULL DEFAULT 0,
  "total_tokens" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_usage_periods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_tool_audits" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "on_behalf_of" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "tool_name" VARCHAR(120) NOT NULL,
  "arguments_hash" CHAR(64) NOT NULL,
  "success" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_tool_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_usage_periods_org_id_period_start_key" ON "ai_usage_periods"("org_id", "period_start");
CREATE INDEX "ai_usage_periods_org_id_period_start_idx" ON "ai_usage_periods"("org_id", "period_start" DESC);
CREATE INDEX "ai_tool_audits_org_id_created_at_idx" ON "ai_tool_audits"("org_id", "created_at" DESC);
CREATE INDEX "ai_tool_audits_org_id_actor_user_id_created_at_idx" ON "ai_tool_audits"("org_id", "actor_user_id", "created_at" DESC);
ALTER TABLE "ai_usage_periods" ADD CONSTRAINT "ai_usage_periods_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_tool_audits" ADD CONSTRAINT "ai_tool_audits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
