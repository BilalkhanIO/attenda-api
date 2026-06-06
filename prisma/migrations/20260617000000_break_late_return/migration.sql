-- Add late_return_minutes and wifi_on_at_end to break_records
ALTER TABLE "break_records" ADD COLUMN "late_return_minutes" INTEGER;
ALTER TABLE "break_records" ADD COLUMN "wifi_on_at_end" BOOLEAN NOT NULL DEFAULT false;
