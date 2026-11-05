ALTER TABLE "shift_assignments"
  ADD COLUMN "acknowledgement_status" VARCHAR(20) NOT NULL DEFAULT 'not_required',
  ADD COLUMN "acknowledgement_due_at" TIMESTAMP(3),
  ADD COLUMN "acknowledged_at" TIMESTAMP(3),
  ADD COLUMN "acknowledgement_note" VARCHAR(1000);

-- Existing, recently published assignments receive a one-time acknowledgement
-- window from migration time. Historical assignments remain outside the flow.
UPDATE "shift_assignments"
SET "acknowledgement_status" = 'pending',
    "acknowledgement_due_at" = CURRENT_TIMESTAMP + INTERVAL '24 hours'
WHERE "is_published" = TRUE
  AND "date" >= CURRENT_DATE - INTERVAL '1 day';

CREATE INDEX "shift_assignments_user_id_is_published_acknowledgement_status_date_idx"
  ON "shift_assignments"("user_id", "is_published", "acknowledgement_status", "date");
