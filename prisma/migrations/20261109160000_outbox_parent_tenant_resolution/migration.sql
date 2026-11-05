-- Resolve tenant ownership from the domain parent before user fields on child
-- rows. This prevents malformed cross-tenant child relations from routing an
-- event into the child's user's organization.
CREATE OR REPLACE FUNCTION attenda_capture_outbox_event() RETURNS trigger AS $$
DECLARE
  row_data JSONB;
  tenant_id TEXT;
  entity TEXT;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  tenant_id := row_data->>'org_id';

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
  IF tenant_id IS NULL AND row_data ? 'user_id' THEN
    SELECT org_id INTO tenant_id FROM users WHERE id = row_data->>'user_id';
  END IF;
  IF tenant_id IS NULL AND row_data ? 'requester_id' THEN
    SELECT org_id INTO tenant_id FROM users WHERE id = row_data->>'requester_id';
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
