CREATE TABLE IF NOT EXISTS "announcements" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT NOT NULL,
  "department_id" TEXT,
  "scheduled_for" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "announcements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "announcements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "announcements_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "announcements_org_id_published_at_idx" ON "announcements"("org_id", "published_at");

CREATE TABLE IF NOT EXISTS "announcement_receipts" (
  "id" TEXT NOT NULL,
  "announcement_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "announcement_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "announcement_receipts_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "announcement_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "announcement_receipts_announcement_id_user_id_key" ON "announcement_receipts"("announcement_id", "user_id");
