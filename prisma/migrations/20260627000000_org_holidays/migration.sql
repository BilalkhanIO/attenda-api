CREATE TABLE IF NOT EXISTS "org_holidays" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "recurring" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_holidays_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "org_holidays_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_holidays_org_id_date_key" ON "org_holidays"("org_id", "date");
