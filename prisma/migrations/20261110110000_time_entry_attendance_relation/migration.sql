ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_attendance_id_fkey"
  FOREIGN KEY ("attendance_id") REFERENCES "attendance_records"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "time_entries_attendance_id_idx" ON "time_entries"("attendance_id");
