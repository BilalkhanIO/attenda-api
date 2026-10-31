ALTER TABLE "attendance_records"
ADD COLUMN "checkin_request_hash" VARCHAR(64),
ADD COLUMN "checkin_source" VARCHAR(20),
ADD COLUMN "checkin_requires_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "device_uptime_ms" DOUBLE PRECISION,
ADD COLUMN "server_anchor_at" TIMESTAMP(3),
ADD COLUMN "server_anchor_uptime_ms" DOUBLE PRECISION,
ADD COLUMN "clock_epoch" VARCHAR(80),
ADD COLUMN "checkin_reviewed_at" TIMESTAMP(3),
ADD COLUMN "checkin_reviewed_by" TEXT,
ADD COLUMN "checkin_review_decision" VARCHAR(20),
ADD COLUMN "checkin_review_note" TEXT;

CREATE INDEX "attendance_records_org_id_checkin_requires_review_checkin_received_at_idx"
ON "attendance_records"("org_id", "checkin_requires_review", "checkin_received_at");
