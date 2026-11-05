CREATE INDEX IF NOT EXISTS "users_org_id_created_at_id_idx"
  ON "users"("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "expense_claims_org_id_created_at_id_idx"
  ON "expense_claims"("org_id", "created_at" DESC, "id" DESC);
