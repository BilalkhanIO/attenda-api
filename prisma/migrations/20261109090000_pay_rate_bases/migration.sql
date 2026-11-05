ALTER TABLE "organisations"
  ADD COLUMN "monthly_pay_divisor" INTEGER NOT NULL DEFAULT 26;

ALTER TABLE "payroll_records"
  ADD COLUMN "pay_basis" VARCHAR(16) NOT NULL DEFAULT 'hourly',
  ADD COLUMN "pay_rate_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "pay_monthly_divisor" INTEGER NOT NULL DEFAULT 26;

UPDATE "payroll_records"
SET "pay_basis" = 'hourly', "pay_rate_amount" = "hourly_rate";
