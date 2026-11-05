CREATE TABLE "report_definitions" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "definition" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "report_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_definitions_org_id_owner_id_name_key" ON "report_definitions"("org_id", "owner_id", "name");
CREATE INDEX "report_definitions_org_id_owner_id_updated_at_idx" ON "report_definitions"("org_id", "owner_id", "updated_at" DESC);
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
