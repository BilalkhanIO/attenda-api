CREATE INDEX "users_org_primary_location_active_deleted_at_idx"
  ON "users"("org_id", "primary_location_id", "is_active", "deleted_at");

CREATE INDEX "shift_assignments_date_user_id_idx"
  ON "shift_assignments"("date", "user_id");
