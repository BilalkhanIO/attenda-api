ALTER TABLE "organisations" ADD COLUMN "country_code" CHAR(2);
ALTER TABLE "payroll_records"
  ADD COLUMN "statutory_parameter_set_id" TEXT,
  ADD COLUMN "tax_calculation_method" VARCHAR(30),
  ADD COLUMN "employee_statutory_deductions" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "employer_statutory_contributions" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "statutory_parameter_sets" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "country_code" CHAR(2) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
  "annual_tax_slabs" JSONB NOT NULL DEFAULT '[]',
  "contributions" JSONB NOT NULL DEFAULT '[]',
  "source_reference" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "activated_by" TEXT,
  "activated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "statutory_parameter_sets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "statutory_parameter_sets_org_id_country_code_status_effective_from_idx" ON "statutory_parameter_sets"("org_id", "country_code", "status", "effective_from");
CREATE INDEX "statutory_parameter_sets_org_id_created_at_idx" ON "statutory_parameter_sets"("org_id", "created_at" DESC);
ALTER TABLE "statutory_parameter_sets" ADD CONSTRAINT "statutory_parameter_sets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "statutory_parameter_sets" ADD CONSTRAINT "statutory_parameter_sets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "statutory_parameter_sets" ADD CONSTRAINT "statutory_parameter_sets_activated_by_fkey" FOREIGN KEY ("activated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_statutory_parameter_set_id_fkey" FOREIGN KEY ("statutory_parameter_set_id") REFERENCES "statutory_parameter_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
