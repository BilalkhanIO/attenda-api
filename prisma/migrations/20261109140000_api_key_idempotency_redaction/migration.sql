-- Older create/rotate API-key requests stored the one-time raw credential in
-- the generic idempotency replay body. It has already been returned to the
-- original caller; remove the persisted copy. Future responses are encrypted.
UPDATE "idempotency_records"
SET "response_body" = jsonb_set("response_body", '{data,token}', '"[redacted; credential was previously returned]"'::jsonb)
WHERE left(COALESCE("response_body" #>> '{data,token}', ''), 8) = 'attenda_';
