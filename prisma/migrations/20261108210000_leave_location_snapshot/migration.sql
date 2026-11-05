ALTER TABLE "leave_requests" ADD COLUMN "location_id" TEXT;

UPDATE "leave_requests" AS leave_request
SET "location_id" = app_user."primary_location_id"
FROM "users" AS app_user
WHERE leave_request."user_id" = app_user."id"
  AND leave_request."location_id" IS NULL
  AND app_user."primary_location_id" IS NOT NULL;

CREATE INDEX "leave_requests_location_id_start_date_end_date_idx"
  ON "leave_requests"("location_id", "start_date", "end_date");

ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
