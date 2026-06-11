-- Doze-tolerant presence: configurable heartbeat expiry + gap forgiveness.
-- Screens turning off suppress mobile heartbeats (Android Doze); a longer
-- grace window plus forgiveness of short same-network reconnects prevents
-- phantom auto-checkouts and phantom "away" breaks.
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "heartbeat_grace_mins" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "gap_forgiveness_mins" INTEGER NOT NULL DEFAULT 15;
