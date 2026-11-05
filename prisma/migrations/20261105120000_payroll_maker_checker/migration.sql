ALTER TABLE "payroll_records" ADD COLUMN "generated_by" TEXT;

ALTER TABLE "payroll_records"
ADD CONSTRAINT "payroll_records_generated_by_fkey"
FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "payroll_records_generated_by_idx" ON "payroll_records"("generated_by");
