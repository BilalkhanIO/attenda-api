-- Departments (with sub-department hierarchy)
CREATE TABLE IF NOT EXISTS "departments" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "parent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "departments_org_id_idx" ON "departments"("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "departments_org_id_name_parent_id_key" ON "departments"("org_id", "name", "parent_id");

ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- User: structured department + personal/employment details
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "department_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "date_of_birth" DATE;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" VARCHAR(20);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "city" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "country" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emergency_contact_name" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emergency_contact_phone" VARCHAR(50);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employment_type" VARCHAR(30);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "joined_at" DATE;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "national_id" VARCHAR(100);

ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Organisation: company profile details
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(50);
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "website" VARCHAR(255);
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "industry" VARCHAR(100);
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "registration_number" VARCHAR(100);

-- Backfill: create departments from existing legacy department strings and link users
INSERT INTO "departments" ("id", "org_id", "name")
SELECT gen_random_uuid(), u."org_id", u."department"
FROM "users" u
WHERE u."department" IS NOT NULL AND u."department" <> ''
GROUP BY u."org_id", u."department"
ON CONFLICT DO NOTHING;

UPDATE "users" u
SET "department_id" = d."id"
FROM "departments" d
WHERE u."department_id" IS NULL
  AND u."department" IS NOT NULL
  AND d."org_id" = u."org_id"
  AND d."name" = u."department"
  AND d."parent_id" IS NULL;
