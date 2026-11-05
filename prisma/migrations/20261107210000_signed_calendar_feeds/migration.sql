CREATE TABLE "calendar_feeds" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_feeds_user_id_key" ON "calendar_feeds"("user_id");
CREATE UNIQUE INDEX "calendar_feeds_token_hash_key" ON "calendar_feeds"("token_hash");
CREATE INDEX "calendar_feeds_org_id_revoked_at_idx" ON "calendar_feeds"("org_id", "revoked_at");

ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
