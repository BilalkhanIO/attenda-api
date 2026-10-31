-- Durable exact-once key for monthly leave accrual per organization-local period.
CREATE TABLE "leave_accrual_runs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_accrual_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_accrual_runs_org_id_year_month_key"
ON "leave_accrual_runs"("org_id", "year", "month");

ALTER TABLE "leave_accrual_runs"
ADD CONSTRAINT "leave_accrual_runs_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Records the organization-local day a remote daily nudge was sent, preventing
-- duplicate WhatsApp nudges after a restart or overlapping scheduler tick.
ALTER TABLE "remote_sessions" ADD COLUMN "daily_nudge_at" TIMESTAMP(3);

-- Preserve audit access for roles that had access through org settings before
-- the permission was split out into its own key.
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('org.audit.view', 'org', 'View organization audit history')
ON CONFLICT ("key") DO UPDATE SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";

INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT DISTINCT role_settings."org_role_id", 'org.audit.view'
FROM "org_role_permissions" AS role_settings
WHERE role_settings."permission_key" = 'org.settings.update'
ON CONFLICT DO NOTHING;
