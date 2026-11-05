CREATE INDEX "leave_requests_org_id_created_at_desc_id_idx"
  ON "leave_requests"("org_id", "created_at" DESC, "id");
