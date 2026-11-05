UPDATE "users"
SET "notification_prefs" = jsonb_build_object(
  'categories', jsonb_build_object(
    'attendance', COALESCE(("notification_prefs" ->> 'attendance')::boolean, COALESCE(("notification_prefs" ->> 'check_in')::boolean, true) OR COALESCE(("notification_prefs" ->> 'late_alerts')::boolean, true)),
    'requests', COALESCE(("notification_prefs" -> 'categories' ->> 'requests')::boolean, COALESCE(("notification_prefs" ->> 'leave_updates')::boolean, true)),
    'shifts', COALESCE(("notification_prefs" -> 'categories' ->> 'shifts')::boolean, COALESCE(("notification_prefs" ->> 'shift_reminders')::boolean, true)),
    'projects', COALESCE(("notification_prefs" -> 'categories' ->> 'projects')::boolean, true),
    'payroll', COALESCE(("notification_prefs" -> 'categories' ->> 'payroll')::boolean, COALESCE(("notification_prefs" ->> 'payroll')::boolean, true)),
    'announcements', COALESCE(("notification_prefs" -> 'categories' ->> 'announcements')::boolean, COALESCE(("notification_prefs" ->> 'announcements')::boolean, true)),
    'documents', COALESCE(("notification_prefs" -> 'categories' ->> 'documents')::boolean, true),
    'security', COALESCE(("notification_prefs" -> 'categories' ->> 'security')::boolean, true)
  ),
  'channels', jsonb_build_object(
    'in_app', COALESCE(("notification_prefs" -> 'channels' ->> 'in_app')::boolean, true),
    'push', COALESCE(("notification_prefs" -> 'channels' ->> 'push')::boolean, true),
    'email', COALESCE(("notification_prefs" -> 'channels' ->> 'email')::boolean, false),
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
