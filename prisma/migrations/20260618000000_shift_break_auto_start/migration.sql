-- AlterTable
ALTER TABLE "shift_breaks" ADD COLUMN "auto_start" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "shift_breaks" ADD COLUMN "reminder_after_mins" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "shift_breaks" ADD COLUMN "deduct_if_skipped" BOOLEAN NOT NULL DEFAULT true;
