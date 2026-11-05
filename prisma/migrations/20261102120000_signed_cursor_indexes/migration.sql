CREATE INDEX "audit_logs_org_id_created_at_desc_id_idx"
  ON "audit_logs"("org_id", "created_at" DESC, "id");
CREATE INDEX "attendance_records_user_id_date_desc_id_idx"
  ON "attendance_records"("user_id", "date" DESC, "id");
CREATE INDEX "in_app_notifications_user_id_created_at_desc_id_idx"
  ON "in_app_notifications"("user_id", "created_at" DESC, "id");
