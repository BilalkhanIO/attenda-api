-- FCM presence challenge (roadmap #24, server half).
-- users.fcm_token: last registered device push token (PUT /users/me/device-token).
-- attendance_records.challenge_sent_at: when the heartbeat-expiry job sent a
-- high-priority FCM data message asking the device to prove presence before
-- being auto-checked-out.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "fcm_token" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "fcm_token_updated_at" TIMESTAMP(3);
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "challenge_sent_at" TIMESTAMP(3);
