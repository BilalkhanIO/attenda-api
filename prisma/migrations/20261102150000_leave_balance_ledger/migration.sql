CREATE TABLE "leave_ledger_entries" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "leave_type" VARCHAR(50) NOT NULL,
  "year" INTEGER NOT NULL,
  "total_delta" DECIMAL(8,2) NOT NULL,
  "used_delta" DECIMAL(8,2) NOT NULL,
  "reason" VARCHAR(24) NOT NULL,
  "note" TEXT,
  "ref_id" TEXT,
  "actor_id" TEXT,
  "effective_date" DATE NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leave_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leave_ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leave_ledger_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leave_ledger_entries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "leave_ledger_entries_org_user_year_type_effective_idx"
  ON "leave_ledger_entries"("org_id", "user_id", "year", "leave_type", "effective_date");
CREATE INDEX "leave_ledger_entries_user_created_desc_id_idx"
  ON "leave_ledger_entries"("user_id", "created_at" DESC, "id");

INSERT INTO "leave_ledger_entries" (
  "id", "user_id", "org_id", "leave_type", "year", "total_delta", "used_delta",
  "reason", "note", "effective_date", "created_at"
)
SELECT gen_random_uuid()::text, "user_id", "org_id", "leave_type", "year", "total_days", "used_days",
       'opening_balance', 'Balance snapshot at ledger activation', make_date("year", 1, 1), "updated_at"
FROM "leave_balances";

CREATE OR REPLACE FUNCTION attenda_capture_leave_balance_delta()
RETURNS TRIGGER AS $$
DECLARE
  balance_row RECORD;
  delta_total DECIMAL(8,2);
  delta_used DECIMAL(8,2);
  operation_reason TEXT;
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

  INSERT INTO leave_ledger_entries (
    id, user_id, org_id, leave_type, year, total_delta, used_delta, reason, note, ref_id, actor_id, effective_date
  ) VALUES (
    gen_random_uuid()::text, balance_row.user_id, balance_row.org_id, balance_row.leave_type, balance_row.year,
    delta_total, delta_used, operation_reason,
    NULLIF(current_setting('app.leave_ledger_note', true), ''),
    NULLIF(current_setting('app.leave_ledger_ref_id', true), ''),
    NULLIF(current_setting('app.leave_ledger_actor_id', true), '')::text,
    CURRENT_DATE
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leave_balance_ledger_append
AFTER INSERT OR UPDATE OR DELETE ON "leave_balances"
FOR EACH ROW EXECUTE FUNCTION attenda_capture_leave_balance_delta();

CREATE OR REPLACE FUNCTION attenda_reject_leave_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'leave ledger entries are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leave_ledger_append_only
BEFORE UPDATE OR DELETE ON "leave_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION attenda_reject_leave_ledger_mutation();
