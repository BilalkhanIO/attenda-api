-- Add new columns to shifts table
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "overtime_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.5;
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "min_rest_hours" INTEGER NOT NULL DEFAULT 11;
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "late_tolerance_mins" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "early_checkout_tolerance_mins" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "auto_checkout" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "auto_checkout_buffer_mins" INTEGER NOT NULL DEFAULT 30;

-- Create shift_breaks table
CREATE TABLE IF NOT EXISTS "shift_breaks" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "break_minutes" INTEGER NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "after_minutes" INTEGER NOT NULL,
    CONSTRAINT "shift_breaks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shift_breaks_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Add new columns to attendance_records table
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "scheduled_start" TIMESTAMP(3);
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "scheduled_end" TIMESTAMP(3);
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "break_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "paid_break_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "net_hours_worked" DECIMAL(5,2);
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "late_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "early_out_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "adherence_score" INTEGER;
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "auto_checked_out" BOOLEAN NOT NULL DEFAULT false;

-- Create break_records table
CREATE TABLE IF NOT EXISTS "break_records" (
    "id" TEXT NOT NULL,
    "attendance_id" TEXT NOT NULL,
    "break_start" TIMESTAMP(3) NOT NULL,
    "break_end" TIMESTAMP(3),
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "break_type" VARCHAR(50) NOT NULL,
    "duration_mins" INTEGER,
    "auto_ended" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "break_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "break_records_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create overtime_rules table
CREATE TABLE IF NOT EXISTS "overtime_rules" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "rule_type" VARCHAR(20) NOT NULL,
    "threshold_hours" DECIMAL(5,2) NOT NULL,
    "multiplier" DECIMAL(4,2) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "overtime_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "overtime_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
