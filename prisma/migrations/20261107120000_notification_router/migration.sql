UPDATE "users"
SET "notification_prefs" = jsonb_build_object(
  'categories', jsonb_build_object(
    'attendance', COALESCE(("notification_prefs" -> 'categories' ->> 'attendance')::boolean, COALESCE(("notification_prefs" ->> 'check_in')::boolean, true) OR COALESCE(("notification_prefs" ->> 'late_alerts')::boolean, true)),
    'requests', COALESCE(("notification_prefs" -> 'categories' ->> 'requests')::boolean, COALESCE(("notification_prefs" ->> 'leave_updates')::boolean, true)),
    'shifts', COALESCE(("notification_prefs" -> 'categories' ->> 'shifts')::boolean, COALESCE(("notification_prefs" ->> 'shift_reminders')::boolean, true)),
    'projects', COALESCE(("notification_prefs" -> 'categories' ->> 'projects')::boolean, true),
    'payroll', COALESCE(("notification_prefs" -> 'categories' ->> 'payroll')::boolean, true),
    'announcements', COALESCE(("notification_prefs" -> 'categories' ->> 'announcements')::boolean, true),
    'documents', COALESCE(("notification_prefs" -> 'categories' ->> 'documents')::boolean, true),
    'security', COALESCE(("notification_prefs" -> 'categories' ->> 'security')::boolean, true)
  ),
  'channels', jsonb_build_object(
    'in_app', COALESCE(("notification_prefs" -> 'channels' ->> 'in_app')::boolean, true),
    'push', COALESCE(("notification_prefs" -> 'channels' ->> 'push')::boolean, true),
    'email', COALESCE(("notification_prefs" -> 'channels' ->> 'email')::boolean, COALESCE(("notification_prefs" ->> 'email')::boolean, false)),
    'whatsapp', false
  ),
  'quiet_hours', jsonb_build_object(
    'enabled', COALESCE(("notification_prefs" -> 'quiet_hours' ->> 'enabled')::boolean, false),
    'start', COALESCE("notification_prefs" -> 'quiet_hours' ->> 'start', '22:00'),
    'end', COALESCE("notification_prefs" -> 'quiet_hours' ->> 'end', '08:00')
  ),
  'digest', CASE WHEN "notification_prefs" ->> 'digest' IN ('daily', 'weekly') THEN "notification_prefs" ->> 'digest' ELSE 'off' END
)
WHERE "notification_prefs" IS NOT NULL;

ALTER TABLE "users"
  ALTER COLUMN "notification_prefs" SET DEFAULT '{"categories":{"attendance":true,"requests":true,"shifts":true,"projects":true,"payroll":true,"announcements":true,"documents":true,"security":true},"channels":{"in_app":true,"push":true,"email":false,"whatsapp":false},"quiet_hours":{"enabled":false,"start":"22:00","end":"08:00"},"digest":"off"}'::jsonb;

ALTER TABLE "users" ADD COLUMN "whatsapp_opted_in_at" TIMESTAMP(3);

CREATE TABLE "notification_deliveries" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "event_id" VARCHAR(36) NOT NULL,
  "event_type" VARCHAR(60) NOT NULL,
  "channel" VARCHAR(16) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT NOT NULL,
  "action_type" VARCHAR(60),
  "action_id" TEXT,
  "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "provider_ref" VARCHAR(255),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_deliveries_event_id_channel_key" ON "notification_deliveries"("event_id", "channel");
CREATE INDEX "notification_deliveries_status_available_at_idx" ON "notification_deliveries"("status", "available_at");
CREATE INDEX "notification_deliveries_org_id_user_id_created_at_idx" ON "notification_deliveries"("org_id", "user_id", "created_at");
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
