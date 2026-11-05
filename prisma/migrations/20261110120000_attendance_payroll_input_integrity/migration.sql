-- Keep draft payroll inputs fresh for every attendance write path, including
-- API routes, background jobs, imports, and administrative SQL operations.
-- A processed payroll period is immutable until it is explicitly recalled.
CREATE OR REPLACE FUNCTION enforce_attendance_payroll_input_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payroll_row RECORD;
  v_period_year integer;
  v_period_month integer;
BEGIN
  v_period_year := EXTRACT(YEAR FROM NEW.date)::integer;
  v_period_month := EXTRACT(MONTH FROM NEW.date)::integer;

  FOR payroll_row IN
    SELECT id, status
    FROM payroll_records
    WHERE org_id = NEW.org_id
      AND user_id = NEW.user_id
      AND payroll_records.period_year = v_period_year
      AND payroll_records.period_month = v_period_month
    FOR UPDATE
  LOOP
    IF payroll_row.status = 'processed' THEN
      RAISE EXCEPTION 'Attendance for a processed payroll period must be recalled before it can be changed'
        USING ERRCODE = '23514', CONSTRAINT = 'attendance_processed_payroll_locked';
    END IF;

    IF payroll_row.status = 'draft' THEN
      UPDATE payroll_records
      SET inputs_stale = true
      WHERE id = payroll_row.id AND status = 'draft';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER attendance_payroll_input_integrity
BEFORE INSERT OR UPDATE OF check_in_at, check_out_at, hours_worked, overtime_hours,
  net_hours_worked, break_minutes, paid_break_minutes
ON attendance_records
FOR EACH ROW
EXECUTE FUNCTION enforce_attendance_payroll_input_integrity();
