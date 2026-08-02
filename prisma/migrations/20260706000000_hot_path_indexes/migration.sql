-- Indexes for the hottest query patterns (2026-08 audit #10):
-- - attendance_records(org_id, date): scheduler ticks (late/absent detectors,
--   heartbeat monitor, auto-checkout), /attendance/today, analytics loops
-- - leave_requests(user_id, status, start_date, end_date): probed on every
--   check-in / checkout / heartbeat and by payroll's unpaid-leave lookup
-- - users(org_id): org-wide user scans in jobs and list endpoints
-- - payroll_records(org_id, period_year, period_month): period listings/gen
-- - refresh_tokens(expires_at): rotation checks + the daily purge job
CREATE INDEX IF NOT EXISTS "attendance_records_org_id_date_idx" ON "attendance_records"("org_id", "date");
CREATE INDEX IF NOT EXISTS "leave_requests_user_id_status_start_date_end_date_idx" ON "leave_requests"("user_id", "status", "start_date", "end_date");
CREATE INDEX IF NOT EXISTS "users_org_id_idx" ON "users"("org_id");
CREATE INDEX IF NOT EXISTS "payroll_records_org_id_period_year_period_month_idx" ON "payroll_records"("org_id", "period_year", "period_month");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");
