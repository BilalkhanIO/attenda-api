CREATE TABLE "locations" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "address" TEXT,
  "timezone" VARCHAR(100) NOT NULL,
  "office_ips" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "office_ssids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "geofence" JSONB,
  "is_main" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "locations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "locations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "locations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "locations_org_id_name_key" ON "locations"("org_id", "name");
CREATE UNIQUE INDEX "locations_one_main_per_org_key" ON "locations"("org_id") WHERE "is_main";
CREATE INDEX "locations_org_id_is_active_name_idx" ON "locations"("org_id", "is_active", "name");

-- Preserve the existing organization-level attendance policy as the Main office.
INSERT INTO "locations" ("id", "org_id", "name", "timezone", "office_ips", "office_ssids", "is_main", "updated_at")
SELECT gen_random_uuid()::text, o."id", 'Main office', o."timezone", o."office_ips", o."office_ssids", true, CURRENT_TIMESTAMP
FROM "organisations" o;

CREATE TABLE "location_managers" (
  "location_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "location_managers_pkey" PRIMARY KEY ("location_id", "user_id"),
  CONSTRAINT "location_managers_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "location_managers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "location_managers_user_id_location_id_idx" ON "location_managers"("user_id", "location_id");

ALTER TABLE "users" ADD COLUMN "primary_location_id" TEXT;
UPDATE "users" u SET "primary_location_id" = l."id"
FROM "locations" l WHERE l."org_id" = u."org_id" AND l."is_main";
ALTER TABLE "users" ADD CONSTRAINT "users_primary_location_id_fkey"
  FOREIGN KEY ("primary_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "users_primary_location_id_idx" ON "users"("primary_location_id");

ALTER TABLE "attendance_records" ADD COLUMN "location_id" TEXT;
UPDATE "attendance_records" a SET "location_id" = u."primary_location_id"
FROM "users" u WHERE u."id" = a."user_id" AND u."org_id" = a."org_id";
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "attendance_records_location_id_date_idx" ON "attendance_records"("location_id", "date");

ALTER TABLE "shift_assignments" ADD COLUMN "location_id" TEXT;
UPDATE "shift_assignments" a SET "location_id" = u."primary_location_id"
FROM "users" u WHERE u."id" = a."user_id";
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "shift_assignments_location_id_date_idx" ON "shift_assignments"("location_id", "date");

ALTER TABLE "org_holidays" ADD COLUMN "location_id" TEXT;
ALTER TABLE "org_holidays" DROP CONSTRAINT IF EXISTS "org_holidays_org_id_date_key";
ALTER TABLE "org_holidays" ADD CONSTRAINT "org_holidays_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "org_holidays_org_date_global_key" ON "org_holidays"("org_id", "date") WHERE "location_id" IS NULL;
CREATE UNIQUE INDEX "org_holidays_org_location_date_key" ON "org_holidays"("org_id", "location_id", "date") WHERE "location_id" IS NOT NULL;
CREATE INDEX "org_holidays_location_date_idx" ON "org_holidays"("location_id", "date");

INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('org.locations.view', 'org', 'View organization locations'),
  ('org.locations.manage', 'org', 'Manage organization locations and managers')
ON CONFLICT ("key") DO UPDATE SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";

INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", p."key" FROM "org_roles" r JOIN "permissions" p ON p."key" = 'org.locations.view'
WHERE r."slug" IN ('manager', 'hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;
INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", p."key" FROM "org_roles" r JOIN "permissions" p ON p."key" = 'org.locations.manage'
WHERE r."slug" = 'super_admin'
ON CONFLICT DO NOTHING;
