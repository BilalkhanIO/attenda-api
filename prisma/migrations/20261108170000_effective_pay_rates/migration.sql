CREATE TABLE "pay_rates" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "basis" VARCHAR(16) NOT NULL DEFAULT 'hourly',
  "currency" VARCHAR(10) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "source" VARCHAR(24) NOT NULL DEFAULT 'manual',
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pay_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pay_rates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pay_rates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pay_rates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pay_rates_effective_range_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "pay_rates_basis_check" CHECK ("basis" IN ('hourly'))
);
CREATE UNIQUE INDEX "pay_rates_user_id_effective_from_key" ON "pay_rates"("user_id", "effective_from");
CREATE INDEX "pay_rates_org_id_user_id_effective_from_effective_to_idx" ON "pay_rates"("org_id", "user_id", "effective_from", "effective_to");

-- Existing hourly_rate values are snapshots; past historical changes cannot
-- be reconstructed, so make the source explicit rather than invent history.
INSERT INTO "pay_rates" ("id", "org_id", "user_id", "amount", "basis", "currency", "effective_from", "source")
SELECT gen_random_uuid()::text, u."org_id", u."id", u."hourly_rate", 'hourly', COALESCE(o."currency", 'PKR'),
       COALESCE(u."joined_at", (u."created_at" AT TIME ZONE 'UTC')::date), 'legacy_snapshot'
FROM "users" u JOIN "organisations" o ON o."id" = u."org_id"
WHERE u."hourly_rate" > 0;

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_pay_rate() RETURNS trigger AS $$
DECLARE item RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    item := OLD;
    UPDATE "payroll_records" p SET "inputs_stale" = true
    WHERE p."org_id" = item."org_id" AND p."user_id" = item."user_id" AND p."status" = 'draft'
      AND make_date(p."period_year", p."period_month", 1) + interval '1 month - 1 day' >= item."effective_from"
      AND (item."effective_to" IS NULL OR make_date(p."period_year", p."period_month", 1) <= item."effective_to");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    item := NEW;
    UPDATE "payroll_records" p SET "inputs_stale" = true
    WHERE p."org_id" = item."org_id" AND p."user_id" = item."user_id" AND p."status" = 'draft'
      AND make_date(p."period_year", p."period_month", 1) + interval '1 month - 1 day' >= item."effective_from"
      AND (item."effective_to" IS NULL OR make_date(p."period_year", p."period_month", 1) <= item."effective_to");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pay_rate_marks_payroll_stale"
AFTER INSERT OR UPDATE OR DELETE ON "pay_rates"
FOR EACH ROW EXECUTE FUNCTION attenda_mark_payroll_stale_for_pay_rate();

ALTER TABLE "payroll_records" ADD COLUMN "pay_rate_id" TEXT;
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_pay_rate_id_fkey"
  FOREIGN KEY ("pay_rate_id") REFERENCES "pay_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "payroll_records_pay_rate_id_idx" ON "payroll_records"("pay_rate_id");
