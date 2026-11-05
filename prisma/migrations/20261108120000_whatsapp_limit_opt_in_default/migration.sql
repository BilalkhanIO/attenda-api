ALTER TABLE "organisations"
  ALTER COLUMN "wa_monthly_message_limit" DROP DEFAULT;

-- The usage meter is an opt-in delivery cap. Existing organizations should
-- continue delivering WhatsApp notifications until an administrator sets one.
UPDATE "organisations"
SET "wa_monthly_message_limit" = NULL
WHERE "wa_monthly_message_limit" = 1000;
