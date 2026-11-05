CREATE TABLE "public_api_keys" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "key_prefix" VARCHAR(16) NOT NULL,
  "key_hash" VARCHAR(64) NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "last_used_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "public_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_api_keys_key_prefix_key" ON "public_api_keys"("key_prefix");
CREATE UNIQUE INDEX "public_api_keys_key_hash_key" ON "public_api_keys"("key_hash");
CREATE INDEX "public_api_keys_org_id_created_at_idx" ON "public_api_keys"("org_id", "created_at" DESC);
CREATE INDEX "public_api_keys_org_id_revoked_at_expires_at_idx" ON "public_api_keys"("org_id", "revoked_at", "expires_at");
CREATE INDEX "public_api_keys_user_id_revoked_at_idx" ON "public_api_keys"("user_id", "revoked_at");

ALTER TABLE "public_api_keys" ADD CONSTRAINT "public_api_keys_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public_api_keys" ADD CONSTRAINT "public_api_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
