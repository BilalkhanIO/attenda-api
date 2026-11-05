-- Extend the existing trigger-based transactional outbox to project time
-- records and capture changes to the new project budget field.
DROP TRIGGER IF EXISTS outbox_projects ON "projects";
CREATE TRIGGER outbox_projects
AFTER INSERT OR DELETE OR UPDATE OF status, priority, name, due_date, budget_hours
ON "projects" FOR EACH ROW
EXECUTE FUNCTION attenda_capture_outbox_event('project_changed');

CREATE TRIGGER outbox_time_entries
AFTER INSERT OR DELETE OR UPDATE OF status, project_id, task_id, started_at, ended_at, minutes, description, billable, attendance_id
ON "time_entries" FOR EACH ROW
EXECUTE FUNCTION attenda_capture_outbox_event('timesheet_changed');

CREATE TRIGGER outbox_timesheets
AFTER INSERT OR DELETE OR UPDATE OF status, submitted_at, reviewed_by, reviewed_at, review_note
ON "timesheets" FOR EACH ROW
EXECUTE FUNCTION attenda_capture_outbox_event('timesheet_changed');
