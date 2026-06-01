-- Widen wa_phone_number_id from VARCHAR(255) to TEXT (Meta IDs and tokens can exceed 255 chars)
ALTER TABLE organisations ALTER COLUMN wa_phone_number_id TYPE TEXT;
