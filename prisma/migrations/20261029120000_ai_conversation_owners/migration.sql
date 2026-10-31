-- Persist conversation ownership so history is scoped to the authenticated user.
-- The schema reconciliation may already have applied these objects, so this
-- migration remains safe to deploy against either the old or current schema.
ALTER TABLE "ai_conversations"
  ADD COLUMN IF NOT EXISTS "user_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "ai_conversations"
    ADD CONSTRAINT "ai_conversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ai_conversations_user_id_updated_at_idx"
  ON "ai_conversations"("user_id", "updated_at");
