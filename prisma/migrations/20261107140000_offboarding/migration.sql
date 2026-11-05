CREATE TABLE "offboarding_cases" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "opened_by" TEXT NOT NULL,
  "case_type" VARCHAR(24) NOT NULL,
  "notice_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_working_day" DATE NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'planning',
  "confidential_reason" TEXT,
  "access_revoked_at" TIMESTAMP(3),
  "sessions_revoked_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offboarding_cases_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "offboarding_tasks" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" TEXT,
  "owner_id" TEXT,
  "due_date" DATE,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "completed_at" TIMESTAMP(3),
  "completed_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offboarding_tasks_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "offboarding_assets" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "asset_name" VARCHAR(200) NOT NULL,
  "serial_number" VARCHAR(120),
  "status" VARCHAR(20) NOT NULL DEFAULT 'outstanding',
  "due_date" DATE,
  "resolved_at" TIMESTAMP(3),
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offboarding_assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "offboarding_cases_one_active_per_employee" ON "offboarding_cases"("org_id", "user_id") WHERE "status" NOT IN ('completed', 'cancelled');
CREATE INDEX "offboarding_cases_org_id_status_last_working_day_idx" ON "offboarding_cases"("org_id", "status", "last_working_day");
CREATE INDEX "offboarding_cases_org_id_user_id_created_at_idx" ON "offboarding_cases"("org_id", "user_id", "created_at");
CREATE INDEX "offboarding_tasks_case_id_status_idx" ON "offboarding_tasks"("case_id", "status");
CREATE INDEX "offboarding_assets_case_id_status_idx" ON "offboarding_assets"("case_id", "status");
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "offboarding_tasks_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "offboarding_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "offboarding_tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "offboarding_tasks_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offboarding_assets" ADD CONSTRAINT "offboarding_assets_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "offboarding_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('offboarding.manage', 'offboarding', 'Manage employee exit cases and asset returns'),
  ('offboarding.view_team', 'offboarding', 'View organization offboarding cases')
ON CONFLICT ("key") DO UPDATE SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";
INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", p."key" FROM "org_roles" r CROSS JOIN "permissions" p
WHERE r."slug" IN ('hr_admin', 'super_admin') AND p."key" IN ('offboarding.manage', 'offboarding.view_team')
ON CONFLICT DO NOTHING;
