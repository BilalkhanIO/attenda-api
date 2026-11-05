-- Reconcile both the old and new attendance period on edits, then serialize
-- source writes against payroll finalization by locking the payroll row.
CREATE OR REPLACE FUNCTION attenda_lock_attendance_payroll_period(
  target_org_id text,
  target_user_id text,
  target_date date
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  payroll_row RECORD;
BEGIN
  FOR payroll_row IN
    SELECT id, status
    FROM payroll_records
    WHERE org_id = target_org_id
      AND user_id = target_user_id
      AND period_year = EXTRACT(YEAR FROM target_date)::integer
      AND period_month = EXTRACT(MONTH FROM target_date)::integer
    FOR UPDATE
  LOOP
    IF payroll_row.status = 'processed' THEN
      RAISE EXCEPTION 'Attendance for a processed payroll period must be recalled before it can be changed'
        USING ERRCODE = '23514', CONSTRAINT = 'attendance_processed_payroll_locked';
    END IF;

    IF payroll_row.status = 'draft' THEN
      UPDATE payroll_records SET inputs_stale = true WHERE id = payroll_row.id AND status = 'draft';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_attendance_payroll_input_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM attenda_lock_attendance_payroll_period(OLD.org_id, OLD.user_id, OLD.date);
  END IF;
  PERFORM attenda_lock_attendance_payroll_period(NEW.org_id, NEW.user_id, NEW.date);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_payroll_input_integrity ON attendance_records;
CREATE TRIGGER attendance_payroll_input_integrity
BEFORE INSERT OR UPDATE OF org_id, user_id, date, status, shift_id, check_in_at,
  check_out_at, hours_worked, overtime_hours, net_hours_worked, break_minutes,
  paid_break_minutes
ON attendance_records
FOR EACH ROW
EXECUTE FUNCTION enforce_attendance_payroll_input_integrity();
