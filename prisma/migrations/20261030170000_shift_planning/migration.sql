CREATE TABLE "shift_availability" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "date" DATE,
  "weekday" INTEGER,
  "starts_on" DATE,
  "ends_on" DATE,
  "start_time" VARCHAR(5),
  "end_time" VARCHAR(5),
  "kind" VARCHAR(20) NOT NULL DEFAULT 'unavailable',
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "note" VARCHAR(500),
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_note" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shift_availability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_coverage_rules" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "shift_id" TEXT NOT NULL,
  "weekday" INTEGER NOT NULL,
  "required_count" INTEGER NOT NULL DEFAULT 1,
  "department" VARCHAR(100) NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shift_coverage_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_schedule_events" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "actor_id" TEXT,
  "event_type" VARCHAR(40) NOT NULL,
  "entity_type" VARCHAR(40) NOT NULL,
  "entity_id" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shift_schedule_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shift_availability_org_id_status_date_idx" ON "shift_availability"("org_id", "status", "date");
CREATE INDEX "shift_availability_user_id_status_weekday_idx" ON "shift_availability"("user_id", "status", "weekday");
CREATE UNIQUE INDEX "shift_coverage_rules_org_id_shift_id_weekday_department_key" ON "shift_coverage_rules"("org_id", "shift_id", "weekday", "department");
CREATE INDEX "shift_coverage_rules_org_id_weekday_idx" ON "shift_coverage_rules"("org_id", "weekday");
CREATE INDEX "shift_schedule_events_org_id_created_at_idx" ON "shift_schedule_events"("org_id", "created_at");
CREATE INDEX "shift_schedule_events_org_id_entity_type_entity_id_idx" ON "shift_schedule_events"("org_id", "entity_type", "entity_id");

ALTER TABLE "shift_availability" ADD CONSTRAINT "shift_availability_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_availability" ADD CONSTRAINT "shift_availability_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_coverage_rules" ADD CONSTRAINT "shift_coverage_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_coverage_rules" ADD CONSTRAINT "shift_coverage_rules_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_schedule_events" ADD CONSTRAINT "shift_schedule_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_schedule_events" ADD CONSTRAINT "shift_schedule_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
