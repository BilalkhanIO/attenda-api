CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_name" VARCHAR(160),
    "user_agent" TEXT,
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- Preserve existing token families as sessions so deployment does not sign
-- out users or lose the ability to revoke their existing refresh chains.
INSERT INTO "user_sessions" ("id", "user_id", "created_at", "last_seen_at", "expires_at", "revoked_at")
SELECT "family_id", MIN("user_id"), MIN("created_at"), MAX("created_at"), MAX("expires_at"),
       CASE WHEN BOOL_OR("revoked_at" IS NULL) THEN NULL ELSE MAX("revoked_at") END
FROM "refresh_tokens"
GROUP BY "family_id"
ON CONFLICT ("id") DO NOTHING;

CREATE INDEX "user_sessions_user_id_revoked_at_last_seen_at_idx"
ON "user_sessions"("user_id", "revoked_at", "last_seen_at" DESC);
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

ALTER TABLE "user_sessions"
ADD CONSTRAINT "user_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens"
ADD CONSTRAINT "refresh_tokens_family_id_fkey"
FOREIGN KEY ("family_id") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
