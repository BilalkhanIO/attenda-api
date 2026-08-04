CREATE TABLE IF NOT EXISTS "org_webhooks" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_success_at" TIMESTAMP(3),
  "last_failure_at" TIMESTAMP(3),
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_webhooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "org_webhooks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "org_webhooks_org_id_idx" ON "org_webhooks"("org_id");
