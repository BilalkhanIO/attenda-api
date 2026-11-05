CREATE TABLE "offboarding_settlements" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
  "items" JSONB NOT NULL,
  "total_amount" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
  "created_by" TEXT NOT NULL,
  "submitted_at" TIMESTAMP(3),
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reviewer_note" TEXT,
  "locked_by" TEXT,
  "locked_at" TIMESTAMP(3),
  "waiver_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offboarding_settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "offboarding_settlements_case_id_key" ON "offboarding_settlements"("case_id");
CREATE INDEX "offboarding_settlements_org_id_status_created_at_idx" ON "offboarding_settlements"("org_id", "status", "created_at");
ALTER TABLE "offboarding_settlements" ADD CONSTRAINT "offboarding_settlements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offboarding_settlements" ADD CONSTRAINT "offboarding_settlements_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "offboarding_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offboarding_settlements" ADD CONSTRAINT "offboarding_settlements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offboarding_settlements" ADD CONSTRAINT "offboarding_settlements_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offboarding_settlements" ADD CONSTRAINT "offboarding_settlements_locked_by_fkey" FOREIGN KEY ("locked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
