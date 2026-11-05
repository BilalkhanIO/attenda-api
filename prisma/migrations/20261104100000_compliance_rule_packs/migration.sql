ALTER TABLE "organisations"
ADD COLUMN "compliance_pack_key" VARCHAR(80) NOT NULL DEFAULT 'unconfigured';

CREATE TABLE "compliance_rules" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "params" JSONB NOT NULL,
  "severity" VARCHAR(10) NOT NULL,
  "source_ref" VARCHAR(500),
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "compliance_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "compliance_violations" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "rule_id" TEXT,
  "rule_code" VARCHAR(80) NOT NULL,
  "dedupe_key" VARCHAR(200) NOT NULL,
  "week_start" DATE NOT NULL,
  "assignment_id" TEXT,
  "user_id" TEXT,
  "severity" VARCHAR(10) NOT NULL,
  "details" JSONB NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "override_reason" VARCHAR(1000),
  "override_by" TEXT,
  "override_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "compliance_violations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "compliance_rules_org_id_code_effective_from_effective_to_idx" ON "compliance_rules"("org_id", "code", "effective_from", "effective_to");
CREATE INDEX "compliance_violations_org_id_week_start_status_idx" ON "compliance_violations"("org_id", "week_start", "status");
CREATE INDEX "compliance_violations_org_id_user_id_week_start_idx" ON "compliance_violations"("org_id", "user_id", "week_start");
CREATE UNIQUE INDEX "compliance_violations_org_id_dedupe_key_key" ON "compliance_violations"("org_id", "dedupe_key");

ALTER TABLE "compliance_rules" ADD CONSTRAINT "compliance_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "compliance_violations" ADD CONSTRAINT "compliance_violations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "compliance_violations" ADD CONSTRAINT "compliance_violations_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "compliance_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
