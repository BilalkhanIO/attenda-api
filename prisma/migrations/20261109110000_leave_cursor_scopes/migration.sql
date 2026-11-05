CREATE INDEX "leave_requests_user_id_created_at_desc_id_idx"
  ON "leave_requests"("user_id", "created_at" DESC, "id");

CREATE INDEX "leave_requests_org_status_created_at_desc_id_idx"
  ON "leave_requests"("org_id", "status", "created_at" DESC, "id");
