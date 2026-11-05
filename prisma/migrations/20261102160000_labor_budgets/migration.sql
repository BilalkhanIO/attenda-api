CREATE TABLE "labor_budgets" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "week_start" DATE NOT NULL,
  "department" VARCHAR(100) NOT NULL DEFAULT '',
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" VARCHAR(10) NOT NULL DEFAULT 'PKR',
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "labor_budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "labor_budgets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "labor_budgets_org_id_week_start_department_key"
  ON "labor_budgets"("org_id", "week_start", "department");
CREATE INDEX "labor_budgets_org_id_week_start_idx"
  ON "labor_budgets"("org_id", "week_start");

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('labor_cost.view', 'shifts', 'View aggregate schedule labor cost and overtime exposure'),
  ('labor_cost.manage', 'shifts', 'Manage weekly schedule labor budgets')
ON CONFLICT ("key") DO NOTHING;

-- Add least-privilege access to existing built-in org roles; custom roles remain unchanged.
INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", 'labor_cost.view' FROM "org_roles" r
WHERE r."slug" IN ('manager', 'hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;
INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", 'labor_cost.manage' FROM "org_roles" r
WHERE r."slug" IN ('hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;
