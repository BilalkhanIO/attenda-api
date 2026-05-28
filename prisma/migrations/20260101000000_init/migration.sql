-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";
-- CreateTable
CREATE TABLE "organisations" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "logo_url" TEXT,
    "timezone" VARCHAR(100) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "office_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "wa_phone_number_id" VARCHAR(255),
    "wa_access_token" TEXT,
    "wa_group_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wa_events" JSONB NOT NULL DEFAULT '{}',
    "wa_dept_groups" JSONB NOT NULL DEFAULT '{}',
    "payroll_day" INTEGER NOT NULL DEFAULT 28,
    "tax_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pension_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "late_threshold" INTEGER NOT NULL DEFAULT 15,
    "plan" VARCHAR(50) NOT NULL DEFAULT 'trial',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(50) NOT NULL,
    "department" VARCHAR(100),
    "job_title" VARCHAR(100),
    "phone" VARCHAR(30),
    "manager_id" TEXT,
    "hourly_rate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "avatar_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "setup_complete" BOOLEAN NOT NULL DEFAULT false,
    "invite_token" TEXT,
    "invite_expires" TIMESTAMP(3),
    "reset_token" TEXT,
    "reset_expires" TIMESTAMP(3),
    "login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "google_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "check_in_at" TIMESTAMP(3),
    "check_out_at" TIMESTAMP(3),
    "check_in_type" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "hours_worked" DECIMAL(5,2),
    "overtime_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ip_detected" VARCHAR(50),
    "is_overridden" BOOLEAN NOT NULL DEFAULT false,
    "override_by" TEXT,
    "override_reason" TEXT,
    "shift_id" TEXT,
    "ip_checkout_pending_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "remote_sessions" (
    "id" TEXT NOT NULL,
    "attendance_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "approved_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "duration_type" VARCHAR(20) NOT NULL,
    "morning_nudge_at" TIMESTAMP(3),
    "midday_nudge_at" TIMESTAMP(3),
    "end_nudge_at" TIMESTAMP(3),
    "ai_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "remote_sessions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "remote_checkin_logs" (
    "id" TEXT NOT NULL,
    "remote_session_id" TEXT NOT NULL,
    "nudge_type" VARCHAR(20) NOT NULL,
    "nudge_sent_at" TIMESTAMP(3) NOT NULL,
    "reply_text" TEXT,
    "reply_at" TIMESTAMP(3),
    "task_summary" TEXT,
    "blockers" TEXT,
    "sentiment" VARCHAR(20),
    "no_reply_alerted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "remote_checkin_logs_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "leave_type" VARCHAR(50) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "working_days" INTEGER NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "leave_balances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "leave_type" VARCHAR(50) NOT NULL,
    "year" INTEGER NOT NULL,
    "total_days" INTEGER NOT NULL,
    "used_days" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "start_time" VARCHAR(10) NOT NULL,
    "end_time" VARCHAR(10) NOT NULL,
    "color" VARCHAR(20) NOT NULL DEFAULT '#1D4ED8',
    "active_days" INTEGER[],
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "shift_swaps" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "requester_assign_id" TEXT NOT NULL,
    "target_assign_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "manager_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shift_swaps_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "payroll_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "regular_hours" DECIMAL(6,2) NOT NULL,
    "overtime_hours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "hourly_rate" DECIMAL(10,2) NOT NULL,
    "base_pay" DECIMAL(12,2) NOT NULL,
    "overtime_pay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unpaid_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "manual_adjustment" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adjustment_reason" TEXT,
    "gross_pay" DECIMAL(12,2) NOT NULL,
    "tax_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pension_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_pay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "is_incomplete" BOOLEAN NOT NULL DEFAULT false,
    "payslip_url" TEXT,
    "processed_at" TIMESTAMP(3),
    "processed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payroll_records_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "performance_reviews" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "org_id" TEXT NOT NULL,
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "manager_rating" INTEGER,
    "attendance_score" DECIMAL(5,2),
    "overall_score" DECIMAL(5,2),
    "notes" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "performance_reviews_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "performance_goals" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL,
    "target_date" DATE,
    "completion" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "performance_goals_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "whatsapp_notification_logs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "recipient_type" VARCHAR(20) NOT NULL,
    "recipient_id" VARCHAR(255) NOT NULL,
    "message_body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_notification_logs_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "token_blacklist" (
    "jti" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_blacklist_pkey" PRIMARY KEY ("jti")
);
-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
-- CreateIndex
CREATE UNIQUE INDEX "users_invite_token_key" ON "users"("invite_token");
-- CreateIndex
CREATE UNIQUE INDEX "users_reset_token_key" ON "users"("reset_token");
-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");
-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_user_id_date_key" ON "attendance_records"("user_id", "date");
-- CreateIndex
CREATE UNIQUE INDEX "remote_sessions_attendance_id_key" ON "remote_sessions"("attendance_id");
-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_user_id_leave_type_year_key" ON "leave_balances"("user_id", "leave_type", "year");
-- CreateIndex
CREATE UNIQUE INDEX "shift_assignments_user_id_date_key" ON "shift_assignments"("user_id", "date");
-- CreateIndex
CREATE UNIQUE INDEX "shift_swaps_requester_assign_id_key" ON "shift_swaps"("requester_assign_id");
-- CreateIndex
CREATE UNIQUE INDEX "shift_swaps_target_assign_id_key" ON "shift_swaps"("target_assign_id");
-- CreateIndex
CREATE UNIQUE INDEX "payroll_records_user_id_period_month_period_year_key" ON "payroll_records"("user_id", "period_month", "period_year");
-- CreateIndex
CREATE UNIQUE INDEX "performance_reviews_user_id_period_month_period_year_key" ON "performance_reviews"("user_id", "period_month", "period_year");
-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "remote_checkin_logs" ADD CONSTRAINT "remote_checkin_logs_remote_session_id_fkey" FOREIGN KEY ("remote_session_id") REFERENCES "remote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_requester_assign_id_fkey" FOREIGN KEY ("requester_assign_id") REFERENCES "shift_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_target_assign_id_fkey" FOREIGN KEY ("target_assign_id") REFERENCES "shift_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "performance_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "whatsapp_notification_logs" ADD CONSTRAINT "whatsapp_notification_logs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
