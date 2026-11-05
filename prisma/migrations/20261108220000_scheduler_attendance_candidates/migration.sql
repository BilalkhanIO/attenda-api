CREATE INDEX "attendance_records_check_out_at_last_heartbeat_at_status_idx"
  ON "attendance_records"("check_out_at", "last_heartbeat_at", "status");

CREATE INDEX "attendance_records_check_out_at_date_status_idx"
  ON "attendance_records"("check_out_at", "date", "status");
