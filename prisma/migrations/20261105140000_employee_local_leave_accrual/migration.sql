CREATE TABLE "leave_accrual_grants" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "leave_type" VARCHAR(50) NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "days" DECIMAL(6,2) NOT NULL,
  "location_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leave_accrual_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leave_accrual_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leave_accrual_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "leave_accrual_grants_org_id_user_id_leave_type_year_month_key"
  ON "leave_accrual_grants"("org_id", "user_id", "leave_type", "year", "month");
CREATE INDEX "leave_accrual_grants_org_id_year_month_idx"
  ON "leave_accrual_grants"("org_id", "year", "month");
CREATE INDEX "leave_accrual_grants_user_id_year_month_idx"
  ON "leave_accrual_grants"("user_id", "year", "month");

CREATE OR REPLACE FUNCTION attenda_capture_leave_balance_delta()
RETURNS TRIGGER AS $$
DECLARE
  balance_row RECORD;
  delta_total DECIMAL(8,2);
  delta_used DECIMAL(8,2);
  operation_reason TEXT;
  operation_effective_date DATE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    balance_row := NEW;
    delta_total := NEW.total_days;
    delta_used := NEW.used_days;
  ELSIF TG_OP = 'UPDATE' THEN
    delta_total := NEW.total_days - OLD.total_days;
    delta_used := NEW.used_days - OLD.used_days;
    IF delta_total = 0 AND delta_used = 0 THEN RETURN NEW; END IF;
    balance_row := NEW;
  ELSE
    balance_row := OLD;
    delta_total := -OLD.total_days;
    delta_used := -OLD.used_days;
  END IF;

  operation_reason := NULLIF(current_setting('app.leave_ledger_reason', true), '');
  IF operation_reason IS NULL THEN
    operation_reason := CASE WHEN TG_OP = 'INSERT' THEN 'opening_balance' WHEN TG_OP = 'DELETE' THEN 'reversal' ELSE 'adjustment' END;
  END IF;
  operation_effective_date := COALESCE(NULLIF(current_setting('app.leave_ledger_effective_date', true), '')::date, CURRENT_DATE);

  INSERT INTO leave_ledger_entries (
    id, user_id, org_id, leave_type, year, total_delta, used_delta, reason, note, ref_id, actor_id, effective_date
  ) VALUES (
    gen_random_uuid()::text, balance_row.user_id, balance_row.org_id, balance_row.leave_type, balance_row.year,
    delta_total, delta_used, operation_reason,
    NULLIF(current_setting('app.leave_ledger_note', true), ''),
    NULLIF(current_setting('app.leave_ledger_ref_id', true), ''),
    NULLIF(current_setting('app.leave_ledger_actor_id', true), '')::text,
    operation_effective_date
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
