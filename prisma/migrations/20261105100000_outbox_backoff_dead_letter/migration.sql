ALTER TABLE "outbox_events"
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "dead_lettered_at" TIMESTAMP(3);

DROP INDEX IF EXISTS "outbox_events_published_at_claimed_at_created_at_idx";
CREATE INDEX "outbox_events_published_deadline_claimed_created_idx"
  ON "outbox_events"("published_at", "dead_lettered_at", "next_attempt_at", "claimed_at", "created_at");

INSERT INTO "permissions" ("key", "module", "description")
VALUES ('org.events.replay', 'org', 'Inspect and replay dead-lettered transactional events')
ON CONFLICT ("key") DO UPDATE SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";

INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT role."id", 'org.events.replay'
FROM "org_roles" role
WHERE role."is_system" = true AND role."slug" IN ('hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;
