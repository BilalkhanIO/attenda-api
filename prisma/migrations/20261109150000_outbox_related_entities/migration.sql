-- Extend transactional event capture to related attendance, project, and shift
-- records that can change user-visible screens without updating their parent.
CREATE OR REPLACE FUNCTION attenda_capture_outbox_event() RETURNS trigger AS $$
DECLARE
  row_data JSONB;
  tenant_id TEXT;
  entity TEXT;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  tenant_id := row_data->>'org_id';

  IF tenant_id IS NULL AND row_data ? 'user_id' THEN
    SELECT org_id INTO tenant_id FROM users WHERE id = row_data->>'user_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'requester_id' THEN
    SELECT org_id INTO tenant_id FROM users WHERE id = row_data->>'requester_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'project_id' THEN
    SELECT org_id INTO tenant_id FROM projects WHERE id = row_data->>'project_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'task_id' THEN
    SELECT p.org_id INTO tenant_id
    FROM project_tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = row_data->>'task_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'shift_id' THEN
    SELECT org_id INTO tenant_id FROM shifts WHERE id = row_data->>'shift_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'checkpoint_id' THEN
    SELECT org_id INTO tenant_id FROM shift_checkpoints WHERE id = row_data->>'checkpoint_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'assignment_id' THEN
    SELECT s.org_id INTO tenant_id
    FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
    WHERE a.id = row_data->>'assignment_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'attendance_id' THEN
    SELECT org_id INTO tenant_id FROM attendance_records WHERE id = row_data->>'attendance_id';
  END IF;

  IF tenant_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  entity := COALESCE(
    row_data->>'id', row_data->>'project_id', row_data->>'task_id',
    row_data->>'shift_id', row_data->>'assignment_id', row_data->>'checkpoint_id',
    row_data->>'attendance_id', row_data->>'user_id',
    concat_ws(':', TG_TABLE_NAME, row_data->>'project_id', row_data->>'user_id',
              row_data->>'task_id', row_data->>'depends_on_id')
  );

  INSERT INTO outbox_events (id, org_id, event_type, entity_type, entity_id, payload)
  VALUES (gen_random_uuid()::text, tenant_id, TG_ARGV[0], TG_TABLE_NAME, entity,
          jsonb_build_object('entity_type', TG_TABLE_NAME, 'entity_id', entity));
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_attendance_corrections
AFTER INSERT OR DELETE OR UPDATE OF status, requested_check_in, requested_check_out, reviewed_by, review_note, reviewed_at
ON attendance_corrections FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('attendance_changed');

CREATE TRIGGER outbox_break_records
AFTER INSERT OR DELETE OR UPDATE OF break_start, break_end, duration_mins, auto_ended, source, late_return_minutes
ON break_records FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('attendance_changed');

CREATE TRIGGER outbox_project_members
AFTER INSERT OR DELETE OR UPDATE OF role
ON project_members FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');

CREATE TRIGGER outbox_project_task_dependencies
AFTER INSERT OR DELETE OR UPDATE OF task_id, depends_on_id
ON project_task_dependencies FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');

CREATE TRIGGER outbox_project_task_comments
AFTER INSERT OR DELETE OR UPDATE OF body
ON project_task_comments FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');

CREATE TRIGGER outbox_project_attachments
AFTER INSERT OR DELETE OR UPDATE OF file_key, file_name, file_size, mime_type, task_id
ON project_attachments FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');

CREATE TRIGGER outbox_shift_breaks
AFTER INSERT OR DELETE OR UPDATE OF name, break_kind, break_minutes, is_paid, after_minutes,
  break_start_time, break_end_time, allowed_count_per_shift, paid_within_limit,
  deduct_extra_time, allow_extra_breaks, applies_days, exception_dates, auto_start,
  reminder_after_mins, deduct_if_skipped
ON shift_breaks FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');

CREATE TRIGGER outbox_shift_checkpoints
AFTER INSERT OR DELETE OR UPDATE OF name, instructions, sort_order, required, minimum_interval_mins, active
ON shift_checkpoints FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');

CREATE TRIGGER outbox_shift_checkpoint_scans
AFTER INSERT OR DELETE
ON shift_checkpoint_scans FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');

CREATE TRIGGER outbox_emergency_shift_offers
AFTER INSERT OR DELETE OR UPDATE OF status, date, note, expires_at, claimed_by, claimed_at, assignment_id
ON emergency_shift_offers FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');

CREATE TRIGGER outbox_shift_availability
AFTER INSERT OR DELETE OR UPDATE OF date, weekday, starts_on, ends_on, start_time, end_time, kind, status, note, reviewed_by, reviewed_at, review_note
ON shift_availability FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');

CREATE TRIGGER outbox_shift_coverage_rules
AFTER INSERT OR DELETE OR UPDATE OF weekday, required_count, department
ON shift_coverage_rules FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');
