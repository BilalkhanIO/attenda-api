-- CreateTable
CREATE TABLE IF NOT EXISTS "in_app_notifications" (
    "id"          TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "org_id"      TEXT NOT NULL,
    "type"        VARCHAR(50) NOT NULL,
    "title"       VARCHAR(255) NOT NULL,
    "body"        TEXT NOT NULL,
    "action_type" VARCHAR(50),
    "action_id"   VARCHAR(36),
    "metadata"    JSONB DEFAULT '{}',
    "read_at"     TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "in_app_notifications"
    ADD CONSTRAINT "in_app_notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "in_app_notifications"
    ADD CONSTRAINT "in_app_notifications_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_notifications_user_read"
    ON "in_app_notifications"("user_id", "read_at");

CREATE INDEX IF NOT EXISTS "idx_notifications_user_created"
    ON "in_app_notifications"("user_id", "created_at" DESC);
