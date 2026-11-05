ALTER TABLE "labor_budgets" ADD COLUMN "location_id" TEXT;

ALTER TABLE "labor_budgets"
  ADD CONSTRAINT "labor_budgets_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "labor_budgets_org_id_week_start_department_location_id_key"
  ON "labor_budgets"("org_id", "week_start", "department", "location_id");

CREATE INDEX "labor_budgets_location_id_week_start_idx"
  ON "labor_budgets"("location_id", "week_start");
