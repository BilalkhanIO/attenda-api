CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "event_type" VARCHAR(60) NOT NULL,
  "entity_type" VARCHAR(60) NOT NULL,
  "entity_id" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "claimed_at" TIMESTAMP(3),
  "claim_token" VARCHAR(80),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "outbox_events_published_at_claimed_at_created_at_idx" ON "outbox_events"("published_at", "claimed_at", "created_at");
CREATE INDEX "outbox_events_org_id_created_at_idx" ON "outbox_events"("org_id", "created_at");

ALTER TABLE "org_webhook_deliveries" ADD COLUMN "outbox_event_id" TEXT;
ALTER TABLE "org_webhook_deliveries" ADD CONSTRAINT "org_webhook_deliveries_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "org_webhook_deliveries_outbox_event_id_webhook_id_key" ON "org_webhook_deliveries"("outbox_event_id", "webhook_id");

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
  IF tenant_id IS NULL AND row_data ? 'shift_id' THEN
    SELECT org_id INTO tenant_id FROM shifts WHERE id = row_data->>'shift_id';
  END IF;
  IF tenant_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  entity := COALESCE(row_data->>'id', row_data->>'project_id', row_data->>'user_id', row_data->>'requester_id', 'unknown');
  INSERT INTO outbox_events (id, org_id, event_type, entity_type, entity_id, payload)
  VALUES (gen_random_uuid()::text, tenant_id, TG_ARGV[0], TG_TABLE_NAME, entity,
          jsonb_build_object('entity_type', TG_TABLE_NAME, 'entity_id', entity));
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_attendance_records AFTER INSERT OR DELETE OR UPDATE OF check_in_at, check_out_at, status, late_minutes, checkin_requires_review ON attendance_records FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('attendance_changed');
CREATE TRIGGER outbox_leave_requests AFTER INSERT OR DELETE OR UPDATE OF status, start_date, end_date, leave_type, reason, reviewed_by, rejection_reason ON leave_requests FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('leave_changed');
CREATE TRIGGER outbox_overtime_requests AFTER INSERT OR DELETE OR UPDATE OF status, requested_minutes, reviewed_by, rejection_reason ON overtime_requests FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('overtime_changed');
CREATE TRIGGER outbox_remote_sessions AFTER INSERT OR DELETE OR UPDATE OF status, reviewed_at, review_note ON remote_sessions FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('remote_changed');
CREATE TRIGGER outbox_shift_swaps AFTER INSERT OR DELETE OR UPDATE OF status, manager_id, rejection_reason ON shift_swaps FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('swap_changed');
CREATE TRIGGER outbox_expense_claims AFTER INSERT OR DELETE OR UPDATE OF status, amount, category, review_note, reimbursed_in_payroll_id ON expense_claims FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('expense_changed');
CREATE TRIGGER outbox_projects AFTER INSERT OR DELETE OR UPDATE OF status, priority, name, due_date ON projects FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');
CREATE TRIGGER outbox_project_tasks AFTER INSERT OR DELETE OR UPDATE OF status, priority, title, due_date, assignee_id, completed_at ON project_tasks FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');
CREATE TRIGGER outbox_shifts AFTER INSERT OR DELETE OR UPDATE OF name, start_time, end_time, is_published ON shifts FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');
CREATE TRIGGER outbox_shift_assignments AFTER INSERT OR DELETE OR UPDATE OF shift_id, user_id, date, is_published ON shift_assignments FOR EACH ROW EXECUTE FUNCTION attenda_capture_outbox_event('shift_changed');
