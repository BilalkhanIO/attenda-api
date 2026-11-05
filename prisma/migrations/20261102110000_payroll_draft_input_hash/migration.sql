ALTER TABLE "payroll_records"
  ADD COLUMN "inputs_hash" VARCHAR(64),
  ADD COLUMN "inputs_stale" BOOLEAN NOT NULL DEFAULT false;

UPDATE "payroll_records" SET "inputs_stale" = true WHERE "status" = 'draft';

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_user(target_user_id TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE payroll_records SET inputs_stale = true
  WHERE user_id = target_user_id AND status = 'draft';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_attendance()
RETURNS TRIGGER AS $$
DECLARE
  item JSONB;
  attendance_date DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    item := to_jsonb(OLD);
    attendance_date := (item->>'date')::date;
    UPDATE payroll_records SET inputs_stale = true
    WHERE user_id = item->>'user_id' AND period_month = EXTRACT(MONTH FROM attendance_date)::int
      AND period_year = EXTRACT(YEAR FROM attendance_date)::int AND status = 'draft';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    item := to_jsonb(NEW);
    attendance_date := (item->>'date')::date;
    UPDATE payroll_records SET inputs_stale = true
    WHERE user_id = item->>'user_id' AND period_month = EXTRACT(MONTH FROM attendance_date)::int
      AND period_year = EXTRACT(YEAR FROM attendance_date)::int AND status = 'draft';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_stale_attendance
AFTER INSERT OR DELETE OR UPDATE OF date, status, hours_worked, net_hours_worked, overtime_hours, shift_id
ON attendance_records FOR EACH ROW EXECUTE FUNCTION attenda_mark_payroll_stale_for_attendance();

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_leave()
RETURNS TRIGGER AS $$
DECLARE
  item JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    item := to_jsonb(OLD);
    IF item->>'status' = 'approved' AND item->>'leave_type' = 'unpaid' THEN
      PERFORM attenda_mark_payroll_stale_for_user(item->>'user_id');
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    item := to_jsonb(NEW);
    IF item->>'status' = 'approved' AND item->>'leave_type' = 'unpaid' THEN
      PERFORM attenda_mark_payroll_stale_for_user(item->>'user_id');
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_stale_unpaid_leave
AFTER INSERT OR DELETE OR UPDATE OF status, leave_type, working_days, start_date, end_date
ON leave_requests FOR EACH ROW EXECUTE FUNCTION attenda_mark_payroll_stale_for_leave();

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_user_rate()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM attenda_mark_payroll_stale_for_user(OLD.id);
  IF NEW.id <> OLD.id THEN PERFORM attenda_mark_payroll_stale_for_user(NEW.id); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_stale_hourly_rate
AFTER UPDATE OF hourly_rate ON users FOR EACH ROW EXECUTE FUNCTION attenda_mark_payroll_stale_for_user_rate();

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_org()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE payroll_records SET inputs_stale = true WHERE org_id = NEW.id AND status = 'draft';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_stale_org_rates
AFTER UPDATE OF tax_rate, pension_rate ON organisations FOR EACH ROW
WHEN (OLD.tax_rate IS DISTINCT FROM NEW.tax_rate OR OLD.pension_rate IS DISTINCT FROM NEW.pension_rate)
EXECUTE FUNCTION attenda_mark_payroll_stale_for_org();

CREATE OR REPLACE FUNCTION attenda_mark_payroll_stale_for_shift()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE payroll_records pr SET inputs_stale = true
  WHERE pr.status = 'draft' AND EXISTS (
    SELECT 1 FROM attendance_records ar
    WHERE ar.user_id = pr.user_id AND ar.shift_id IN (OLD.id, NEW.id)
      AND EXTRACT(MONTH FROM ar.date) = pr.period_month
      AND EXTRACT(YEAR FROM ar.date) = pr.period_year
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_stale_shift_multiplier
AFTER UPDATE OF overtime_multiplier ON shifts FOR EACH ROW
WHEN (OLD.overtime_multiplier IS DISTINCT FROM NEW.overtime_multiplier)
EXECUTE FUNCTION attenda_mark_payroll_stale_for_shift();
