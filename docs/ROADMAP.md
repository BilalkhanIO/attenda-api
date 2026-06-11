# Attenda — Consolidated Implementation Roadmap

**Date:** 2026-06-11
**Sources:** `ATTENDANCE_RESEARCH.md` (features + Android reliability), `API_RESEARCH.md`,
`Attenda-web/docs/WEB_RESEARCH.md`, `Attenda-mobile/docs/MOBILE_RESEARCH.md`. Each report has the
detail and citations; this file is the single prioritized plan across all three apps.

Status legend: ☐ planned · ◐ partial · ☑ done (recently shipped items noted for context)

## Already shipped (this branch)
- ☑ Dynamic RBAC end-to-end (permission-gated routes, permission-driven UI, legacy column as mirror only)
- ☑ Doze-tolerant presence: configurable grace (20m default), gap forgiveness, `location`-only FGS type
- ☑ Departments/sub-departments + user/org profile details (schema, API, web UI)
- ☑ Platform admin hardening (SYSTEM org, per-permission gates, assistant role)
- ☑ Web↔API contract reconciliation (~25 broken endpoints), role-aware dashboard, 2FA fixes (mobile flow, web QR)
- ☑ Within-major dependency updates (API + web); 67 API tests green

---

## Tier 1 — Foundations (days each; no interdependencies; start in parallel)

### Cross-cutting
1. ☐ **CI for all three repos** (none exists): API `tsc + jest`, web `eslint --max-warnings 0 + vitest + next build`, mobile `flutter analyze + flutter test`. Forcing function for every other item.

### API
2. ☐ **Zod v4 validation middleware** + wave-1 adoption (auth, leave, users routes); structured 422 field errors in the existing envelope.
3. ☐ **pino structured logging + request IDs** (AsyncLocalStorage correlation); replace console.*.
4. ☐ **Rate limiter → Redis store** (`rate-limit-redis`) — memory store breaks at 2+ instances.

### Web
5. ☐ **Fix the SSE stream**: reconnect with capped backoff, auth via header (`@microsoft/fetch-event-source`) instead of `?token=` in the URL (leaks to logs), re-subscribe on token refresh, heartbeat timeout.
6. ☐ **TanStack Query bootstrap** (already in package.json, unused) + migrate Dashboard & Leave as templates (optimistic approve/reject).
7. ☐ **Refresh-interceptor mutex** (concurrent 401s race today) + cookie hardening (SameSite=Strict refresh token).
8. ☐ **Burn down 55 react-hooks/compiler lint errors** (prereq for React Compiler; many die with #6).
9. ☐ **Vitest bootstrap** + first units (utils, zod schemas, navItemVisible, proxy decision logic).

### Mobile
10. ☐ **hive → hive_ce** (unmaintained storage under the offline queue).
11. ☐ **Sealed Dio failure hierarchy** in one place; remove string-matching error checks.
12. ☐ **Reliability-check screen** (battery exemption, permissions, service status, last heartbeat) — existing deps only.

## Tier 2 — Core upgrades (2–6 weeks)

### API
13. ☐ **Cron → BullMQ repeatable jobs** with idempotent handlers (in-process cron double-fires at 2+ instances; SSE fan-out needs Redis pub/sub at the same point).
14. ☐ **Refresh-token rotation + revocation family** (tokens are reusable for 30 days today); device/session list endpoint.
15. ☐ **Audit trail for pay-affecting mutations** (payroll adjust/process, leave balance edits, attendance overrides — append-only table; overrides partially covered today).
16. ☐ **@ts-nocheck burn-down** (attendance.ts first) + OpenAPI generation from zod schemas (replaces hand-maintained API docs).
17. ☐ **Sentry + minimal metrics** (prom-client), Prisma slow-query logging.

### Web
18. ☐ **Finish Query migration** (overtime/remote/swaps/attendance/employees/notifications); filters into URL params.
19. ☐ **Server-side pagination/sort/search** on employees, attendance, leave, admin orgs (DataTable props exist; small API contract addition: `sort`, `q`, `{items,total}`).
20. ☐ **Unified Approvals inbox** — one queue for leave/overtime/remote/swaps/late-notices with keyboard nav + mobile card layout. Flagship UX change.
21. ☐ **A11y retrofit** of ui/index.tsx (Radix internals for Modal/Dropdown/Menu/Tabs, aria sweep, contrast audit).
22. ☐ **CSP (report-only → enforce) via proxy.ts** + security headers; dependency audit in CI.
23. ☐ **Playwright E2E** (6 money paths) + `reactCompiler: true` once lint is clean.

### Mobile
24. ☐ **FCM wiring** (needs Firebase project credentials from owner) → device-token endpoint → **presence-challenge before auto-checkout** (server pings through Doze; unanswered challenge ⇒ checkout). Completes the screen-off story.
25. ☐ **Repository + typed models** (home/attendance/leave), Result returns, cache consolidation.
26. ☐ **home_screen.dart decomposition** (2,600 lines → section widgets + view-models).
27. ☐ **Upgrade train**: Flutter 3.38 + go_router 17 + network_info_plus 8 + permission_handler 12 (one PR, behind CI).

## Tier 3 — Differentiators (quarter horizon)

28. ☐ **Late/absence policy engine** (org-configurable grace/tiers/points/pattern rules, provisional auto-absent + nightly finalization, "Running late" quick actions both clients).
29. ☐ **Leave accrual engine** (accrual rates, carry-over with caps/expiry, public-holiday calendars per org; balances are static per-year rows today).
30. ☐ **Payroll period locking + recall workflow** (processed payroll is mutable today via adjust).
31. ☐ **Break compliance packs** (CA/EU rule templates, attestation-based deduction, pre-deadline reminders) — break-state must suspend auto-checkout.
32. ☐ **Tenancy hardening**: Prisma client extension auto-scoping org_id (or Postgres RLS) replacing ~100 hand-written filters.
33. ☐ Web: avatar upload (presigned), bulk actions + filtered CSV/XLSX exports (async via SSE notify), SSE-driven dashboard invalidation, command palette, i18n groundwork (Intl-based formatting first).
34. ☐ Mobile: Riverpod 3 for new state, widget/golden tests, certificate pinning + root detection, AlarmManager heartbeat floor + `setAlarmClock` escalation.
35. ☐ **Shift scheduling depth**: open shifts, availability constraints, rest-period validation at publish, no-show alerts.

## Tier 4 — Strategic projects

36. ☐ **Web BFF auth migration** (httpOnly cookies, server-side token attach) — definitive XSS-exfiltration fix; unblocks RSC/Server Actions/instant navigation for authed routes.
37. ☐ **Deliberate-punch layer** (rotating-QR kiosk mode + geofenced manual punch + optional selfie attestation) so passive WiFi is convenience, not the sole legal time record.
38. ☐ **iOS product decision** (geofence + punch model; persistent WiFi presence is not portable to iOS).
39. ☐ Demand-based auto-scheduling; BLE beacon option for room-level presence.

---

## Suggested execution order (first three sprints)
- **Sprint 1:** #1 CI everywhere · #5 SSE fix · #10 hive_ce · #2 zod wave 1 · #7 refresh mutex · #12 reliability screen
- **Sprint 2:** #6→#18 Query migration · #3 pino · #13 BullMQ · #11 Dio failures · #8 lint burn-down · #9 Vitest
- **Sprint 3:** #20 Approvals inbox · #14 token rotation · #19 server-side pagination · #24 FCM presence challenge (if Firebase creds available) · #15 audit trail
