# Attenda — System Expansion Research

**Date:** 2026-07-30 · **Scope:** new features to enrich the platform beyond the shipped roadmap, plus the mobile completeness/design mandate. Ranked by (user value × implementation leverage on the existing architecture).

## How competitors are richer (gap analysis)

Deel/Rippling/BambooHR/Deputy/Connecteam converge on the same additions once
attendance + leave + payroll exist: holiday calendars, employee-initiated
timesheet corrections, a who's-out team view, expense claims, document
management, onboarding checklists, and messaging/engagement layers. The first
three interlock directly with engines Attenda already has (accrual, absent
detector, approvals inbox) — highest leverage. The rest are standalone modules.

## Tier A — implement now (this cycle)

### A1. Public-holiday calendars per org
The accrual engine, absent detector, late-pattern scan and leave working-days
math all treat every weekday as a workday. One `org_holidays` table
(org_id, date, name, recurring) fixes four engines at once:
- `calculateWorkingDays` skips holidays → leave requests stop charging balance
  for holidays inside the range.
- Absent detector skips holiday dates → no false "absent" on national holidays.
- Web: settings card (list, add, delete; permission `org.settings.update`).
- Mobile: holiday chip on home/attendance calendar (read-only).
Endpoints: `GET/POST/DELETE /org/holidays` (+ `GET` open to all org users so
clients can render them).

### A2. Attendance correction requests
Industry-standard flow (Deputy "timesheet edit request", Rippling "correction"):
employee submits a fix ("forgot to check out", wrong times) → manager approves →
record is updated with full audit. Attenda already has: manual override endpoint
(manager-only), audit trail, approvals inbox, notification fan-out. Missing: the
employee-initiated request object + approve/reject transitions.
- Model `AttendanceCorrection` (user, org, attendance date, requested
  check_in/check_out, reason, status, reviewer, review_note).
- Endpoints: `POST /attendance/corrections` (employee),
  `GET /attendance/corrections/me`, `GET /attendance/corrections`
  (manager/HR, permission `attendance.override`),
  `PUT /attendance/corrections/:id/approve|reject`.
- Approve applies the times to the attendance record (recomputing
  hours/late the same way the override endpoint does), audits, notifies.
- Web: new tab in the unified Approvals inbox. Mobile: request form from the
  attendance history detail sheet + status chips.

### A3. Who's-out today / team calendar (read model only)
One endpoint `GET /org/whos-out?date=` aggregating approved leave, remote
sessions and holidays for a date range. Zero new tables. Web dashboard widget +
mobile home section. (Ship API now; clients can follow.)

## Tier B — next cycle (documented, not started)

- **Expense claims**: submit → approve → payroll adjustment hook (the recall/
  adjust machinery already exists). Medium.
- **Document vault**: S3 presigned upload (payslip pipeline already uses S3),
  per-user folders, expiry reminders (visa/contract). Medium.
- **Onboarding checklists**: templates per org, tasks auto-assigned on user
  creation. Medium.
- **Announcements 2.0**: read receipts, scheduling, audience targeting by
  department. Small–medium (announcements exist).
- **Slack/Teams webhooks**: reuse the WhatsApp notification fan-out shape for
  generic outbound webhooks per org. Small.
- **i18n groundwork**: Intl-based formatting first (already roadmapped #33).
- **Engagement**: kudos/recognition feed, pulse surveys. Larger; product call.

## Mobile completeness + minimal design mandate

### Completeness gaps (audit 2026-07-30)
1. No UI for the new engines: leave **accrual info** (balance now grows monthly
   — show accrual rate on the leave screen), **late points** (manager view),
   corrections (A2), holidays (A1).
2. Manager-side approvals on mobile are scattered (leave exists; overtime/
   swaps/remote/late-notices vary) — needs an approvals hub screen fed by the
   same endpoints as the web inbox.
3. FCM presence challenge — still blocked on Firebase artifacts (owner).

### Minimal design system (the restyle contract)
Current UI leans on heavy glassmorphism (blur, translucency, layered
gradients). Target: **standard minimal** — flat surfaces, one accent, strong
typography, whitespace as the primary structure. Concretely:
- Surfaces: solid `surface`/`background` tokens, 1px hairline borders
  (`gray200`), radius 12–16, **no blur/translucency** outside overlays; at most
  one soft shadow level for raised cards.
- Color: neutral gray scale + single `primary` accent + semantic
  status colors (existing `StatusColors` mapping stays). Kill decorative
  gradients; status tints at ≤10% alpha backgrounds.
- Typography: DM Sans stays; enforce a 5-step scale (11/13/15/18/24) with
  two weights (500/700); numbers in tabular figures for timers.
- Spacing: 4-pt grid; screen padding 16; card padding 16; section gap 24.
- Components: all buttons/badges/cards route through `lib/widgets/common.dart`
  variants — zero inline one-off styles; banners become single-line rows with
  a leading icon, tinted background, no borders-within-borders.
- Motion: 150–200 ms ease-out only; remove decorative animations.
- Every screen keeps behavior identical: this is a reskin + dead-style purge,
  validated by `flutter analyze` + the 43 widget tests + CI.

## Delivery status (2026-07-31)
Tier A shipped end-to-end and CI-verified on all three repos: A1 holidays
(API f46a736 + web HolidaysCard c8e930e + mobile banner 46b6642), A2
corrections (API ae9eb48 + web approvals tab f180781 + mobile sheet 7aa839b
+ hub 626d04a), A3 who's-out (API a76e05c + web widget 5b853ae + mobile
card 46b6642). Accrual visibility: API 483b6be + mobile 1dc0121. Mobile
minimal-design restyle: 10 commits (b93c0da…12a7582), all screens, zero
glass remnants. Widget tests: af09b1d. Tier B remains the next cycle's menu.

## Execution order (this cycle)
1. Docs (this file) → commit.
2. A1 holidays: schema + API + engine wiring + tests → commit(s).
3. A2 corrections: schema + API + transitions + tests → commit(s).
4. A3 who's-out endpoint → commit.
5. Mobile agent: minimal design pass (theme + shared widgets first, then
   screen-by-screen), plus accrual/late-points/corrections/holidays UI as
   API pieces land. Incremental commits, CI-gated.
6. Web agent: holidays settings card, corrections tab in Approvals, who's-out
   dashboard widget. Incremental commits, CI-gated.

## Tier B delivery status (2026-08-02) — API

Two Tier B items shipped on attenda-api (branch claude/zealous-sagan-8aa4gb):
- **Expense claims** end-to-end on the API: schema + `expenses.view`/
  `expenses.manage` RBAC + shared payroll recalc util (82bcc12), the
  `/api/v1/expenses` router — submit → approve/reject → reimburse into the
  claimant's payroll `manual_adjustment` via the exact `/payroll/:id/adjust`
  math, audited both sides (7e9d497), recalc unit tests (719038a).
  Note: 82bcc12 briefly referenced the then-unadded OrgWebhook model;
  fixed in 7e9d497 (CI red only on that intermediate push).
- **Outbound org webhooks** (the "Slack/Teams webhooks" item, generalised):
  `org_webhooks` model + HMAC-SHA256-signed fire-and-forget delivery with
  5s timeout, failure-streak bookkeeping and auto-disable at 20 (44670e8);
  `/api/v1/org/outbound-webhooks` management router (secret returned once),
  boot wiring via `registerWebhookFanout()`, delivery unit tests (this
  commit). Events: attendance/leave/overtime/remote/swap/expense `_changed`.

Remaining UI work (next agents):
- **Web**: expenses approvals tab (list + approve/reject + reimburse dialog
  choosing period, recall hint on LOCKED), employee "My expenses" submit
  form; Settings card for outbound webhooks (create shows secret once,
  list/delete/test, failure badges); subscribe TanStack invalidation to the
  new `expense_changed` SSE scope.
- **Mobile**: expense submission (amount/category/receipt photo upload —
  needs an S3 presign endpoint, not yet built) + "my claims" list; approvals
  hub entry for managers with `expenses.manage`.
- **API follow-ups** (small): receipt upload presign route reusing
  services/s3.ts; optional Redis pub/sub upgrade of the org bus would give
  multi-instance webhook fanout for free.
