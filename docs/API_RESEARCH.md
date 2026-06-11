# attenda-api — 2026 Best-Practice Research & Improvement Roadmap

**Date:** 2026-06-11
**Scope:** `/home/user/attenda-api` — Node 20 / Express 5.2 / Prisma 7.8 (`@prisma/adapter-pg` driver adapter) / Postgres, ~100 endpoints across 15 route files (6,554 route LOC), Redis (ioredis), 11 in-process node-cron jobs, S3 payslips, SSE notification stream, WhatsApp + email side-channels, Jest 30 (8 unit-test suites / 67 tests).
**Out of scope:** attendance/check-in/breaks/shifts feature depth and Android reliability — already covered in `docs/ATTENDANCE_RESEARCH.md` (referenced below where decisions intersect).

---

## 1. Request validation (zod for Express 5)

### Current state
Every handler validates manually: `if (!email) throw new ValidationError('Email required')`, `parseInt(req.query.page || '1')`, etc. There is no schema library at all in `package.json`. Consequences observed in the code:

- Numeric/boolean query params are coerced ad-hoc (`req.query.unread === 'true'` in `src/routes/notifications.ts`); no bounds checking on most of them.
- Enum-ish fields (`status`, `leave_type`, `break_type`, `rule_type`) are free-text strings validated inconsistently or not at all — and the schema stores them as `VarChar`, so bad values reach the DB.
- Validation logic is duplicated across web/Flutter clients and the API with no shared contract.
- `ValidationError` returns 422 with a single message string — fine, but zod gives structured per-field issues for free.

### 2026 recommendation: Zod v4 + a thin typed middleware
Zod v4 (mid-2025) is the de-facto standard; valibot is a fine bundle-size-optimized alternative for *frontend* validation but the ecosystem leverage (zod-openapi, drizzle/prisma integrations, Next.js server actions, react-hook-form resolvers) is overwhelmingly on zod's side. For a server + Next.js web app pair, zod is the safe choice. Express 5's native async-handler support means the middleware can be a plain async function with no wrapper library needed.

Pattern (no dependency beyond `zod` required; `express-zod-safe` is an option but a 30-line in-house middleware keeps control of the error envelope):

```ts
// src/middleware/validate.ts
import { z, ZodType } from 'zod';
export function validate<B extends ZodType, Q extends ZodType, P extends ZodType>(
  schemas: { body?: B; query?: Q; params?: P }
) {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query)  res.locals.query = schemas.query.parse(req.query); // Express 5: req.query is a getter
      if (schemas.body)   req.body = schemas.body.parse(req.body);
      next();
    } catch (e) {
      if (e instanceof z.ZodError) return next(new ValidationError(z.prettifyError(e), e.issues));
      next(e);
    }
  };
}
```

Express-5-specific gotchas:
- `req.query` is a **getter** in Express 5 — you cannot reassign it. Stash parsed query on `res.locals` (or `req.validated`) instead of mutating.
- All query/param values arrive as strings → use `z.coerce.number()`, `z.coerce.date()`, `z.stringbool()` (zod v4) for booleans.
- Keep `ValidationError` extending the existing `AppError` so the `{success:false, error, code}` envelope in `src/middleware/errorHandler.ts` is preserved; add an optional `details` array to the envelope for field-level issues (additive, non-breaking for Flutter/Next clients).
- Add a dedicated `ZodError` branch in `errorHandler.ts` as a safety net for schemas invoked outside the middleware (jobs, webhook payloads).

### Shared schema package with the Next.js app
Options, in order of pragmatism for this two-repo setup (attenda-api and Attenda-web are sibling repos, not a monorepo):

1. **`@attenda/contracts` private package** (npm private registry, GitHub Packages, or even a git dependency): zod schemas + inferred TS types + the response-envelope generic `ApiResponse<T> = { success: true; data: T } | { success: false; error: string; code: string }`. The API imports it for validation; the Next app imports it for form validation (react-hook-form `zodResolver`) and typed fetch wrappers. Version it with changesets.
2. **Monorepo migration** (pnpm workspaces / turborepo) — cleaner long-term, but a bigger lift; not required to start.
3. Flutter cannot consume zod — it gets types via OpenAPI codegen instead (see §8); zod-openapi makes the zod schemas the single source for that too, so one schema feeds *both* clients.

Keep schemas **transport-shaped** (snake_case fields, ISO strings) — they describe the wire format, not Prisma models. Do not import Prisma types into the contracts package.

### Migration approach for ~100 endpoints (prioritized, not big-bang)
1. **Wave 0 (infrastructure, ~1 day):** add `validate()` middleware, `ZodError` handling in errorHandler, shared `paginationQuery`, `uuidParam`, `dateRangeQuery`, `monthYearQuery` schemas — those four cover a huge share of endpoints.
2. **Wave 1 — auth (`src/routes/auth.ts`, 541 lines):** highest abuse surface (login, register, refresh, reset-password, 2FA, SSO exchange). Strict schemas, `.strict()` to reject unknown keys.
3. **Wave 2 — pay-affecting writes:** `payroll.ts` (generate/adjust/process), `leave.ts` (request/review/balance PUT), `overtime.ts`. These mutate money and balances; bad input here is a financial bug. Half-day floats, HH:MM strings (`z.string().regex(/^\d{2}:\d{2}$/)`), month 1–12 / year ranges.
4. **Wave 3 — attendance write endpoints** (`check-in`, `ip-event`, `heartbeat`, `breaks`, overrides) — high traffic from the Flutter foreground service; strict schemas double as living documentation of the contract `docs/ATTENDANCE_RESEARCH.md` describes.
5. **Wave 4 — admin/org/users/shifts/departments CRUD.** Mostly mechanical.
6. **Wave 5 — read-only GETs** (query schemas only). Lowest risk, do opportunistically when a file is touched.

Rule of thumb: new endpoints MUST use `validate()` from day one (enforce via review/lint); existing ones migrate per the waves. Add one integration test per migrated route asserting the 422 shape so clients are protected.

Sources: [Type-safe REST with Zod + Express (2026 guide)](https://dev.to/young_gao/building-a-type-safe-rest-api-with-zod-express-and-typescript-from-validation-to-openapi-docs-3agj), [express-zod-safe](https://github.com/AngaBlue/express-zod-safe), [UserJot: Zod with Express](https://userjot.com/blog/zod-express-input-validation), [Steve Kinney: validation middleware](https://stevekinney.com/courses/full-stack-typescript/validating-schema-with-middleware)

---

## 2. Type-safety debt (@ts-nocheck, `any`)

### Current state
`// @ts-nocheck` on **10 production files**: `routes/attendance.ts` (1,525 lines), `routes/misc.ts` (759), `routes/leave.ts`, `routes/notifications.ts`, `jobs/scheduler.ts` (~660 lines, the most safety-critical file in the repo — it writes attendance status and payroll), and all 5 of `services/{qrcode,pdf,csvExport,email,s3}.ts`. Explicit `: any` is otherwise modest (≤4 per file in checked files). TypeScript is 6.0.3, so the compiler itself is current.

### Pragmatic elimination strategy
1. **Stop the bleeding:** add an ESLint rule (`@typescript-eslint/ban-ts-comment` with `ts-nocheck: true`) so no *new* file can opt out; allowlist the current 10 via per-file disable comments that double as a visible TODO list.
2. **Cheap wins first — the 5 services.** `qrcode`, `email`, `s3`, `csvExport`, `pdf` are small wrappers around well-typed SDKs (`@aws-sdk/client-s3`, `nodemailer`, `qrcode`, `pdfkit` all have types installed). Removing `@ts-nocheck` there is likely an afternoon each; errors will mostly be implicit-any params and `process.env` string|undefined.
3. **`jobs/scheduler.ts` next, with extraction.** Don't just type it — split each cron job into `src/jobs/handlers/<job>.ts` with a typed signature (`(now: Date) => Promise<JobResult>`). This is also the prerequisite for the BullMQ migration in §5, so the typing work and the queue work are the same refactor. The existing `resolveScheduledEnd(record: any, ...)` becomes `Pick<AttendanceRecord, 'scheduled_end'> & { shift: Shift | null }` — Prisma's generated types (`Prisma.AttendanceRecordGetPayload<{ include: { shift: true } }>`) eliminate most hand-written types.
4. **`routes/attendance.ts` last and incrementally.** 1,500 lines under `@ts-nocheck` is too risky to flip in one PR. Sequence:
   - Extract pure business logic (already partially done in `src/utils/attendance.ts` / `src/utils/shift.ts`, which are type-checked — good) until route handlers are thin.
   - Split the router into `attendance/checkin.ts`, `attendance/breaks.ts`, `attendance/admin.ts`, `attendance/reports.ts`, each type-checked as it is extracted; the residual file keeps `@ts-nocheck` until empty.
   - The zod migration (§1, Wave 3) supplies the request types (`z.infer`), which is where most of the `any` actually originates (`req.body` destructuring).
5. **Measure:** `type-coverage --strict` in CI with a ratchet (never decreases). Don't chase 100%; chase "no `@ts-nocheck` and no `any` on money/attendance paths".

### tRPC / OpenAPI codegen — does it make sense here?
**tRPC: no.** With two non-TypeScript-native consumers (Flutter is Dart; the Next.js app could use it, but Flutter can't), tRPC would give type safety to one client and nothing to the other while coupling the web app to the server runtime. 2026 consensus: tRPC for TS-only internal BFFs; OpenAPI when mobile or third parties consume the API ([tRPC vs OpenAPI](https://medium.com/@Modexa/ship-faster-with-type-safe-apis-trpc-vs-openapi-9aa977b4331b), [Type-driven HTTP comparison](https://medium.com/@2nick2patel2/type-driven-http-trpc-vs-openapi-vs-rpc-9714791e1855)).

**OpenAPI-from-zod: yes** — it's the only path that serves both clients:
- zod schemas (§1) → OpenAPI 3.1 doc via [`zod-openapi`](https://github.com/samchungy/zod-openapi) (uses zod v4 native metadata, no monkey-patching) or [`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi).
- Next.js client: `openapi-typescript` + `openapi-fetch` (types only, zero runtime cost) or direct import from the shared contracts package.
- Flutter client: `openapi-generator` (dart-dio) or `swagger_dart_code_generator` regenerates models — eliminating the hand-maintained `ApiService` response parsing drift risk noted in the mobile CLAUDE.md (`res.data['data']` unwrapping convention).
- (`oRPC` is the emerging "tRPC DX + OpenAPI output" option — [v1 in late 2025](https://www.infoq.com/news/2025/12/orpc-v1-typesafe/) — but adopting it means rewriting routing; not justified for an existing Express app.)

---

## 3. Observability

### Current state
- Logging: `morgan` (`combined` in prod) + raw `console.error` scattered everywhere (`[Webhook]`, `[Notifications]`, `[ERROR]` prefixes). No structure, no request IDs, no correlation between a request and its log lines.
- No error tracking, no metrics, no tracing. Prisma client logs only `error`/`warn` (`src/utils/prisma.ts`); no slow-query visibility.
- Health check exists (`GET /health`) but checks nothing (no DB/Redis ping).

### Minimal production setup (the 2026 "table stakes" stack)
1. **pino + pino-http** replacing morgan. JSON logs, ~10x cheaper than console, redaction built in (`redact: ['req.headers.authorization', 'req.body.password', 'req.body.refresh_token']` — important because tokens currently appear in SSO redirect URLs, see §7).
2. **Request ID + AsyncLocalStorage context.** Middleware: take `X-Request-Id` if present (Railway/most proxies inject one) else `crypto.randomUUID()`; store `{ requestId, userId, orgId }` in an `AsyncLocalStorage`; a pino `mixin()` reads it so every log line — including ones deep in services and even cron-spawned notification calls — carries the IDs without threading parameters. This is the canonical pattern ([Dash0 contextual logging guide](https://www.dash0.com/guides/contextual-logging-in-nodejs), [Maxim Orlov's pino+ALS walkthrough](https://maximorlov.com/logging-with-pino-and-asynclocalstorage-in-nodejs/)). Echo the ID in the error envelope (`code`, `request_id`) so Flutter/web bug reports are correlatable.
3. **Sentry** (`@sentry/node`): `Sentry.init` first in `server.ts`, `Sentry.setupExpressErrorHandler(app)` before the custom `errorHandler`, plus manual `captureException` in the cron job catch-blocks (currently `catch(() => {})` — silent swallowing of WhatsApp/notification failures in `scheduler.ts` is the single biggest blind spot; at minimum those become `catch(err => logger.warn(...))`). Sentry's Prisma + ioredis integrations come free with its OTel-based auto-instrumentation, and it has a [pino integration](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/pino/) to attach logs to events.
4. **prom-client** `/metrics` endpoint (protected or bound to an internal port): default Node metrics + a `http_request_duration_seconds` histogram labeled `{method, route, status}` (use `req.route?.path` to avoid label cardinality explosion from UUIDs) + business counters that matter for *this* app: `attendance_checkins_total{type}`, `heartbeats_total`, `cron_job_runs_total{job, outcome}`, `cron_job_duration_seconds{job}`, `whatsapp_sends_total{status}`, `sse_connections_gauge`. The cron metrics are the cheapest way to notice the scheduler silently failing.
5. **Prisma 7 slow queries:** two complementary mechanisms:
   - Cheap, immediate: enable `log: [{ emit: 'event', level: 'query' }]` and log queries with `duration > N ms` through pino (sampled in production).
   - Proper: Prisma 7 ships **OpenTelemetry tracing GA — no preview flag** ([Prisma docs](https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing)); note the old `metrics` preview API is deprecated in Prisma 7 in favor of OTel ([discussion #27898](https://github.com/prisma/prisma/discussions/27898)). With Sentry already initializing OTel, Prisma spans (operation, serialization, db query) appear inside request traces for free — this answers "is it the DB or the ORM" directly ([tracing Prisma with OTel](https://oneuptime.com/blog/post/2026-02-06-trace-prisma-client-database-calls-opentelemetry/view)).
   - Also enable `pg_stat_statements` on Postgres regardless — zero app changes, catches the scheduler's N+1s (the late-arrival detector runs 4+ queries **per org per minute**).
6. **Deep health check:** `/health/ready` doing `SELECT 1` + Redis `PING`, distinct from the liveness `/health`.

Skip for now: full OTel collector + Grafana stack, log aggregation infra changes (Railway captures stdout JSON; point a drain at Better Stack/Axiom when needed).

---

## 4. Multi-tenancy hardening

### Current pattern and its risks
Every tenant-scoped query manually adds `org_id: req.user!.org_id` (counted: 17 occurrences in attendance.ts, 30 in shifts.ts, 23 each in users.ts/misc.ts, etc. — well over 120 call sites). Auxiliary guard: `sameOrg()` helper in `src/middleware/auth.ts`, used inconsistently.

Risks observed:
1. **One forgotten `where` = cross-tenant leak**, and nothing structurally prevents it. Several models are only *indirectly* tenant-owned (`BreakRecord`, `ShiftBreak`, `ShiftAssignment`, `ShiftSwap`, `RemoteSession`, `RemoteCheckinLog`, `PerformanceGoal` have **no `org_id` column**) — these are scoped only through joins, so an endpoint that fetches them by `id` from a request param must remember to check the parent's org. `notifications.ts` `PUT /:id/read` correctly scopes by `user_id`; but the pattern relies on each author remembering.
2. **`@ts-nocheck` files are the highest-risk surface** — no compiler assistance there, and they include attendance.ts where most per-record lookups live.
3. **Cron jobs and webhooks run unscoped by design** (they iterate orgs) — correct, but they share the same `prisma` singleton, so any future "use the same helper as routes" refactor must keep an explicit escape hatch.
4. Missing **indexes on `org_id`** for several hot tables: `attendance_records` has `@@unique([user_id, date])` but no `@@index([org_id, date])` — the scheduler queries `{ org_id, date }` every minute. Same for `leave_requests`, `payroll_records` (org-wide listings).

### Postgres RLS vs Prisma client extensions — 2026 verdict
- **Prisma client extension (`$extends` with a `query.$allModels` hook injecting `org_id`)**: application-level, easy to adopt, works per-request by creating an extended client from the base singleton (cheap — extensions don't open new connections). But it's still app code: raw queries (`$queryRaw`), `groupBy` edge cases, and models without `org_id` bypass it. It's a guardrail, not a boundary.
- **Postgres RLS with a session GUC** (`SET LOCAL app.current_org_id = '<uuid>'` inside a transaction, policies `USING (org_id = current_setting('app.current_org_id')::uuid)`): the database enforces isolation even when app code forgets the WHERE clause. This is the 2026 recommended posture for B2B SaaS with compliance pressure ([Prisma's own RLS extension example](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security), [multi-tenant isolation strategies compared](https://dev.to/whoffagents/building-multi-tenant-saas-data-isolation-strategies-compared-299o), [RLS with Prisma guide](https://medium.com/@francolabuschagne90/securing-multi-tenant-applications-using-row-level-security-in-postgresql-with-prisma-orm-4237f4d4bd35)). Costs: every tenant query must run in a transaction that sets the GUC (the canonical pattern is a client extension that wraps queries in `$transaction([SET LOCAL…, query])`); a `BYPASSRLS` (or policy-exempt) role is needed for cron jobs, platform-admin endpoints, and migrations; the `Pool` in `src/utils/prisma.ts` must not leak GUCs across pooled connections (using `SET LOCAL` inside transactions solves this); and the child tables without `org_id` either get the column added (denormalize) or policies via `EXISTS` subqueries (slower).

### Recommended sequence (defense in depth, incremental)
1. **Now:** add `@@index([org_id, …])` to hot tables; add `org_id` columns to the indirect-child tables (`break_records`, `shift_assignments`, `remote_sessions`, `performance_goals`) — needed for both RLS and query performance anyway.
2. **Next:** introduce a per-request **tenant-scoped Prisma extension** (`getTenantClient(orgId)`) and migrate routes to it opportunistically (pairs naturally with the §1 zod waves and §2 file splits). Routes stop spelling `org_id` manually; platform-admin and job code keep the raw client explicitly (`prismaUnscoped`).
3. **Then:** enable **RLS policies on the 6–8 most sensitive tables first** (users, attendance_records, payroll_records, leave_requests, leave_balances, organisations) with the GUC-setting extension, run in *permissive/audit* mode (log would-be violations) before flipping to enforce. Full-schema RLS can follow.
4. **Always:** add a cross-tenant integration test suite — two seeded orgs, assert every list endpoint returns zero rows of the other org and every `GET /:id` of a foreign resource 404s. This catches regressions regardless of mechanism and is feasible *today* with supertest.

---

## 5. Jobs & scheduling

### Current state
- `src/jobs/scheduler.ts`: **11 `node-cron` jobs in-process** — two run **every minute** (late-arrival detector, shift auto-checkout, plus shift-reminder and break auto-manager also `* * * * *`), heartbeat-expiry every 5 min, daily jobs at 6/8 AM. The late detector loads *all orgs → all employees → shifts → assignments → records → notices* every minute.
- **`bull` 4.x is in `package.json` but never imported** — dead dependency (and it's legacy Bull, not BullMQ).
- Idempotency is partial: boolean flags (`late_alerted`, `hour_alerted`, `absent_alerted`, `auto_checked_out`) and upserts guard double-*notification*, but nothing guards double-*execution* of a whole job tick across processes.
- Rate limiter: `express-rate-limit` with the default **memory store**.
- SSE (`src/routes/notifications.ts` `/stream`): per-connection `setInterval` polling the unread **count from Postgres every 15 s per client** — not an in-process fan-out, so it is actually multi-instance-safe, but it's a DB-load time bomb (N connected clients × 1 count query / 15 s) and pushes no real-time payloads.

### What breaks at 2+ instances
| Component | Failure mode |
|---|---|
| node-cron jobs | **Every job double-fires.** Late/absent detectors double-send WhatsApp + notifications (flag updates race: both instances read `late_alerted=false` before either writes). Payroll auto-generate runs twice — `@@unique([user_id, period_month, period_year])` saves duplicates as P2002 errors, but half the writes throw. Auto-checkout races itself on `check_out_at`. |
| express-rate-limit | Memory store → each instance keeps its own counters → effective limit becomes `N × 100/min` and is inconsistent per user across sticky/non-sticky routing. |
| Redis jti blacklist | Already shared — OK. |
| SSE | Works (DB polling), but cost scales linearly and no instance can push an event created on another instance if true push is ever added. |
| In-process anything else | None found — good (no in-memory caches of permissions noted; `resolveUserPermissions` hits DB/Redis per request). |

### Recommendation
1. **Migrate scheduling to BullMQ** (not legacy Bull — remove the dead dep) **Job Schedulers / repeatable jobs**: Redis-coordinated, deduplicated by scheduler ID, so N API instances can all `upsertJobScheduler()` idempotently and exactly one worker processes each tick ([BullMQ repeatable docs](https://docs.bullmq.io/guide/jobs/repeatable), [Better Stack BullMQ guide](https://betterstack.com/community/guides/scaling-nodejs/bullmq-scheduled-tasks/), [cron in multi-instance NestJS with Bull — same pattern](https://dev.to/juan_castillo/handling-cron-jobs-in-nestjs-with-multiple-instances-using-bull-3pj2)). Run workers in-process initially (`new Worker(...)` in server.ts) — same deployment shape, but now scale-out-safe; later split a dedicated worker dyno without code changes. Retries/backoff replace the silent `catch(() => {})`.
2. **Restructure the minute-jobs to fan out per org:** the cron tick enqueues one job per active org (`jobId: 'late-check:{orgId}:{yyyy-mm-dd-hh-mm}'` → natural idempotency key), workers process orgs concurrently. Fixes both the double-fire problem and the single-threaded N×org loop latency.
3. **Idempotency inside handlers regardless of queue:** make the alert flags transactional with the send decision — `updateMany({ where: { …, late_alerted: false }, data: { late_alerted: true } })` and only send if `count === 1` (atomic claim). This is worth doing *now*, even before BullMQ, since it also fixes the race within one instance's overlapping ticks. Same conditional-update pattern for auto-checkout (`where: { check_out_at: null }`).
4. **Side-channel queues:** move WhatsApp/email sends into a BullMQ queue with retry/backoff and the existing `WhatsappLog.attempts` as the record — currently a Meta API hiccup at the wrong minute means the message is just lost.
5. **Rate limiter:** swap memory store for [`rate-limit-redis`](https://github.com/express-rate-limit/rate-limit-redis) against the existing ioredis client — ~10 lines.
6. **SSE:** short-term, lengthen the poll and add `Last-Event-ID` support; medium-term, publish notification events to Redis pub/sub in `createNotification()` and have each instance's SSE handlers subscribe — turns polling into push and drops the DB count queries. (Keep the count-poll as fallback.) Also: the SSE token-in-query-string issue belongs to §7.

---

## 6. Payroll / leave / overtime feature depth vs industry (Gusto / Rippling / Deputy patterns)

### What exists (schema audit)
- `PayrollRecord`: monthly only (`period_month/year`), flat org-level `tax_rate`/`pension_rate`, `manual_adjustment + adjustment_reason`, status `draft → processed`, partial lock (`Cannot adjust processed payroll` in `src/routes/payroll.ts:151`), payslip PDF → S3, `processed_by` recorded.
- `LeaveBalance`: `total_days Int` / `used_days Int` per `(user, leave_type, year)` — **integers**, yet `LeaveRequest.working_days` is a `Float` supporting half-days (0.5): half-day deductions are silently lossy or rely on increment-by-float into an Int column. Balances are set **manually** via `PUT /leave/balance/:userId`.
- `OvertimeRule` (daily/weekly/seventh_day thresholds + multipliers, priority) and per-shift `overtime_multiplier` + approval workflow (`OvertimeRequest`) — actually ahead of many small competitors.
- `calculateWorkingDays()` in `src/utils/auth.ts` hardcodes Sat/Sun as non-working.

### Gaps vs industry standard
1. **No leave accrual engine.** Industry baseline (Gusto/Rippling/Deputy/BambooHR): policies define accrual **rate + frequency** (per pay period / monthly / annually), **start rules** (day 1 vs after probation), **caps**, and **proration for mid-year joiners** ([Rippling PTO accrual guide](https://www.rippling.com/blog/pto-accrual), [Day Off: PTO accrual 101](https://day-off.app/paid-time-off-accrual/)). Missing models: `LeavePolicy` (org, leave_type, accrual_rate_days, accrual_frequency, max_balance, carryover_cap, carryover_expiry_months, waiting_period_days, allow_negative) and `LeaveLedgerEntry` (user, policy, delta_days `Decimal(5,2)`, kind: accrual|usage|carryover|expiry|manual_adjustment, effective_date, note, created_by). A ledger replaces the mutable `used_days` counter — balance = SUM(ledger), auditable by construction, and a monthly accrual job (BullMQ, §5) posts entries.
2. **No carry-over / year-end processing.** `year Int` partitions balances but nothing transfers or expires remainder days. Carryover caps and expiries are table stakes ([Mercans carryover glossary](https://mercans.com/glossary/carryover-paid-time-off-pto/)).
3. **No public-holiday calendar.** No `holiday` model anywhere (verified — zero hits in schema/src). Consequences: `working_days` over-counts leave spanning holidays; the late/absent detectors will flag everyone late on a national holiday; payroll "is_incomplete" logic can't distinguish holidays from absence. Add `HolidayCalendar` (org, name, country_code) + `Holiday` (calendar_id, date, name, is_half_day) with optional per-department/location assignment; seed from a library (e.g. `date-holidays`) but keep org-editable — every serious competitor lets HR edit the calendar. Update `calculateWorkingDays()` and scheduler day-guards to consult it. (Weekend definition should also become org-configurable — Fri/Sat weekends are common in the Gulf region, relevant given the product's market.)
4. **Payroll period locking is half-implemented.** `processed` blocks *adjustments to the payroll row*, but nothing locks the **inputs**: attendance overrides, break edits, retro leave approvals, and overtime approvals for a processed month silently de-sync source data from the issued payslip. Industry pattern (Gusto/Deputy): timesheet approval → period lock; changes after lock require an explicit **correction/off-cycle run**, never in-place mutation ([Gusto: change/cancel/reverse payroll](https://support.gusto.com/article/106621949100000/Change-cancel-or-reverse-a-payroll-or-payment-for-admins), [audit-ready payroll documentation](https://us.fitgap.com/stack-guides/producing-audit-ready-payroll-documentation-with-traceable-calculations-and-approvals)). Minimum viable: a `PayrollPeriod` model (org, month, year, status: open|review|locked, locked_by/at) checked by attendance-override, leave-review, overtime-review, and break-edit endpoints; rejections direct users to an adjustment flow that lands in the *next* period or an off-cycle record.
5. **No audit trail for pay-affecting mutations.** `is_overridden/override_by/override_reason` on attendance and `adjustment_reason` on payroll capture the *latest* state only — no before/after, no history of repeated edits. Add a generic `AuditLog` (id, org_id, actor_id, action, entity_type, entity_id, before Json, after Json, reason, request_id, created_at) written transactionally with the mutation for: payroll adjust/process, leave review/balance edit, attendance override, hourly-rate change (currently `users.ts` can change `hourly_rate` with **zero trace** — the single most audit-sensitive field in the system), overtime review, org tax/pension rate changes. This is also the §7 security audit log — one table serves both ([Employment Hero: why HR/payroll audit trails](https://employmenthero.com/blog/what-is-an-audit-trail/), [Rippling payroll audit](https://www.rippling.com/blog/payroll-audit)).
6. **Smaller deltas:** monthly-only pay frequency (weekly/bi-weekly/semi-monthly needs `PayrollPeriod` with start/end dates rather than month/year ints); flat org-wide tax/pension (fine for v1, but a `rate effective_from` history table prevents retroactive distortion when rates change); `hourly_rate` has no effective-dating (mid-month raises mis-pay the whole month); no payslip immutability guarantee (S3 object lock / versioning on the payslips bucket is a one-liner of infra).

---

## 7. Security hardening

### Refresh tokens — the biggest gap
Current (`src/utils/auth.ts`, `src/routes/auth.ts:229`): refresh token is a **stateless 30-day JWT, never stored, never rotated, never revocable**. `POST /auth/refresh` verifies the signature, checks the user is active, and mints a new access token — the same refresh token works indefinitely within 30 days. Logout blacklists only the *access* jti; a stolen refresh token survives logout, password change, and account lock. The Redis jti-blacklist infrastructure (fail-closed, nicely done) covers only access tokens.

2026 baseline ([RFC 9700, the OAuth Security BCP, Jan 2025](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html), [Auth0 rotation docs](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation), [refresh-token security practices](https://www.obsidiansecurity.com/blog/refresh-token-security-best-practices)):
1. **Rotate on every use**: `/auth/refresh` returns a *new* refresh token and invalidates the old one.
2. **Persist token families**: `RefreshToken` table (id=jti, user_id, family_id, token_hash, expires_at, used_at, revoked_at, device metadata: user_agent, ip, app_version, platform). Store only a SHA-256 hash.
3. **Reuse detection**: presenting an already-`used_at` token ⇒ revoke the entire family (rotation without reuse detection "gains minimal security benefit"), notify the user, log it.
4. **Sliding + absolute lifetimes**: e.g. 30-day sliding, 90-day absolute. Also shorten the **8-hour access token** — 15–60 min is the norm once refresh is cheap and rotating; both clients already auto-refresh on 401 (the Flutter interceptor explicitly does).
5. This table **is** session/device management for free: `GET /auth/sessions` (per-device list from family metadata), `DELETE /auth/sessions/:id` (revoke family), revoke-all on password change/2FA disable/account lock. The Flutter app's long-lived background service makes per-device revocation genuinely useful.

### Other findings (ordered by severity)
1. **Tokens in URL query strings.** SSO fallback redirect: `…/sso/callback?access_token=…&refresh_token=…` (auth.ts:506) — tokens enter browser history, proxy logs, Referer headers. The one-time-code path (60 s Redis `sso:` code) already exists right above it — make it the only path. Same class of issue: SSE `?token=` (notifications.ts) — acceptable trade-off for EventSource, but mint a short-lived (60 s) single-purpose stream token via an authenticated endpoint instead of the full 8-h access token; and ensure pino redacts `req.url` query on these routes.
2. **Secret fallbacks**: `JWT_SECRET || 'dev-secret'`, `VERIFY_TOKEN || 'attenda_webhook_verify'`. Add a boot-time env assertion (a small zod `envSchema.parse(process.env)` — same library as §1) that crashes in production if `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `REDIS_URL` are missing/weak. WhatsApp `wa_access_token` is stored **plaintext per-org in Postgres** — encrypt at rest (libsodium sealed box / AES-GCM with a KMS- or env-held key) since a DB dump currently leaks every tenant's Meta credentials.
3. **Audit logging**: covered by the §6 `AuditLog` — extend the action set with security events: login success/failure, password change/reset, 2FA enable/disable, role/permission changes (`org-rbac.ts` currently mutates permissions untraced), token-family revocations, account locks. Include `request_id` (§3) for correlation.
4. **Webhooks**: the WhatsApp HMAC implementation is solid (raw-body capture, constant-time compare, reject-on-missing-secret). Two notes: replying 200 *before* verification is fine for Meta retry semantics but means signature failures are invisible — count them in metrics; and if more webhook *producers* are ever added (e.g. notifying customer systems), sign outbound payloads the same way (`X-Attenda-Signature: sha256=…`, timestamped to prevent replay).
5. **CORS**: allowlist from `FRONTEND_URL` is correct; "no Origin ⇒ allow" is required for the Flutter app and fine since auth is bearer-token (not cookie) — CSRF risk is minimal. Cookie-parser is loaded but tokens travel in bodies/headers; if refresh tokens ever move to cookies for web (worth considering: `HttpOnly; Secure; SameSite=Strict` beats localStorage), revisit CSRF then. Tighten `Access-Control-Allow-Headers` explicitly and consider rejecting CORS errors with a clean 403 instead of a 500 (the current `cb(new Error(...))` falls through to the generic error handler).
6. **Rate limiting**: per-IP only; add per-account throttling on login/refresh (key by email/user) so a botnet can't brute-force one account from many IPs (login_attempts/locked_until partially covers login — refresh and forgot-password have nothing). Move to Redis store (§5).
7. **Postgres backup/PITR**: payroll data makes this non-optional. Managed-PG (Railway et al.): verify the plan's PITR window covers ≥7–30 days, document the restore runbook, and schedule a quarterly restore test. Self-managed: WAL archiving (pgBackRest/wal-g) to S3 with a separate IAM principal from the app's payslip bucket credentials. Also: `pg_dump` of pre-migration state before every `prisma migrate deploy` in CI, and S3 versioning + lifecycle on the payslip bucket.
8. **Misc**: `helmet()` defaults are fine for a JSON API; consider `app.disable('x-powered-by')` (helmet covers it); `express.json({ limit: '10mb' })` is generous — 1 mb suffices outside upload routes (multer handles files separately); dependency hygiene — `@types/otplib`, `@types/pg` belong in devDependencies, `bull` is unused (§5), and `uuid` can be replaced by Node 20's `crypto.randomUUID()`.

---

## 8. API versioning & docs

### Current state
`/api/v1` prefix exists (good — versioning posture is already correct for two mobile-release-lagged clients). Documentation is **three hand-written files** (`API_DOCUMENTATION.md`, `API_REFERENCE_DETAILED.md`, `TECHNICAL_API_SPEC.md`) with no mechanism keeping any of them honest.

### Recommendation
1. **Single source of truth = the zod schemas from §1.** Register each route's schemas + method/path with [`zod-openapi`](https://github.com/samchungy/zod-openapi) (zod v4-native) or [`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi)'s registry; generate `openapi.json` at build time; serve Scalar or Swagger UI at `/api/v1/docs` (non-production or auth-gated). Validation and documentation become the same artifact, so docs *cannot* drift ([zod → OpenAPI with Express](https://dev.to/young_gao/building-a-type-safe-rest-api-with-zod-express-and-typescript-from-validation-to-openapi-docs-3agj), [Speakeasy: OpenAPI from Zod v4](https://www.speakeasy.com/openapi/frameworks/zod)).
2. **Wrap the envelope once**: a helper that lifts any `dataSchema` into `{ success: true, data: dataSchema }` + the shared error response components, matching `src/utils/response.ts` exactly.
3. **Coverage ratchet in CI**: a script that diffs the Express route table (walk `app._router`/`router.stack`) against documented operations and fails when an undocumented route appears — endpoints become documented as they're zod-migrated, and new ones can't ship undocumented.
4. **Retire the three markdown docs** progressively: replace per-endpoint detail with links to the generated reference; keep only conceptual/flow documentation (auth flows, attendance state machine — the things `docs/ATTENDANCE_RESEARCH.md` and `PRESENCE_TRACKING.md` already do well) hand-written.
5. **Spec-diff for breaking changes**: run `oasdiff` (or `openapi-diff`) against the previous spec in CI and fail on breaking changes to `/v1` — this is what actually protects the Flutter app, whose users update slowly. Introduce `/v2` only for incompatible reshapes; prefer additive evolution within v1.
6. **Client generation** (closes the loop from §2): publish `openapi.json` as a build artifact → `openapi-typescript` for the Next app, `openapi-generator` (dart-dio) for Flutter.

---

## Ranked implementation roadmap (impact × effort, specific to this codebase)

### Tier 1 — do now (high impact, days-not-weeks each)
1. **Refresh-token rotation + reuse detection + RefreshToken table** (§7). Biggest single security gap; small surface (one route file + one model + Flutter/web already handle re-auth on 401). Includes shortening access TTL and killing the tokens-in-URL SSO fallback.
2. **Env validation + secrets hygiene** (§7): zod env schema crashing prod boot on missing `JWT_SECRET`/`JWT_REFRESH_SECRET`; encrypt `wa_access_token`. Half a day.
3. **Atomic claim pattern in scheduler alerts + auto-checkout** (§5 item 3): conditional `updateMany` before sending. Fixes real races even on one instance; prerequisite-free.
4. **pino + request IDs + Sentry** (§3 items 1–3). Replaces morgan/console wholesale; immediately makes every other workstream debuggable. ~2 days.
5. **`rate-limit-redis` store** (§5): ~10 lines against existing ioredis; removes a scale-out landmine early.
6. **Validation infrastructure + Wave 1 (auth) + Wave 2 (payroll/leave/overtime)** (§1): middleware, shared param schemas, the two highest-risk route files.

### Tier 2 — next (high impact, ~1–3 weeks each)
7. **BullMQ migration of the scheduler** (§5): per-org fan-out jobs, retries, removal of dead `bull` dep; do jointly with typing/splitting `scheduler.ts` (§2 item 3). Unblocks running 2+ instances at all.
8. **AuditLog table + writes on all pay-affecting and security mutations** (§6 item 5 / §7 item 3): payroll adjust/process, leave review/balance, attendance override, `hourly_rate` change, RBAC changes, auth events.
9. **Cross-tenant integration test suite + org_id indexes + org_id on child tables** (§4 items 1, 4): the cheapest 80% of tenant-isolation assurance, no architectural change.
10. **PayrollPeriod locking of inputs** (§6 item 4): block attendance/leave/overtime/break mutations in locked periods; correction-flow stub.
11. **Holiday calendar model + integration** (§6 item 3): fixes leave day-counts, scheduler false-positives on holidays, and payroll completeness in one feature; org-editable, library-seeded.
12. **prom-client metrics + deep health check + Prisma slow-query logging** (§3 items 4–6).

### Tier 3 — strategic (multi-week, schedule deliberately)
13. **Zod Waves 3–5 + attendance.ts split/de-`@ts-nocheck`** (§1, §2): ride along with feature work on those files; ratchet via type-coverage + ESLint ban on new `@ts-nocheck`.
14. **Leave accrual engine** (§6 items 1–2): LeavePolicy + ledger model, monthly accrual job (on BullMQ from #7), carryover/expiry year-end job, Decimal balances. The largest pure-product item; differentirates against Deputy-class competitors.
15. **Tenant-scoped Prisma client extension, then RLS on sensitive tables** (§4 items 2–3): extension first (app-level guardrail), RLS in audit-then-enforce mode after.
16. **OpenAPI generation + CI coverage/diff gates + client codegen for Next & Flutter** (§8): depends on zod coverage breadth; start emitting the spec once Waves 1–3 are done and ratchet from there.
17. **SSE → Redis pub/sub push** (§5 item 6) + short-lived stream tokens (§7 item 1): do when real-time UX or connection volume demands it.

### Explicitly deprioritized
- **tRPC / oRPC adoption** — wrong fit for a Flutter + Next two-client REST API (§2).
- **Full RLS across all tables / database-per-tenant** — staged RLS on sensitive tables gives most of the value (§4).
- **OTel collector + self-hosted Grafana stack** — Sentry tracing + prom-client + pg_stat_statements cover this app's scale (§3).
- **Big-bang validation or type-safety rewrites** — everything above is deliberately wave-based.

---

## Sources
- [Building a Type-Safe REST API with Zod, Express, and TypeScript (2026)](https://dev.to/young_gao/building-a-type-safe-rest-api-with-zod-express-and-typescript-from-validation-to-openapi-docs-3agj) · [express-zod-safe](https://github.com/AngaBlue/express-zod-safe) · [UserJot: Zod + Express](https://userjot.com/blog/zod-express-input-validation) · [Steve Kinney: validation middleware](https://stevekinney.com/courses/full-stack-typescript/validating-schema-with-middleware)
- [tRPC vs OpenAPI](https://medium.com/@Modexa/ship-faster-with-type-safe-apis-trpc-vs-openapi-9aa977b4331b) · [Type-Driven HTTP: tRPC vs OpenAPI vs RPC](https://medium.com/@2nick2patel2/type-driven-http-trpc-vs-openapi-vs-rpc-9714791e1855) · [oRPC v1 (InfoQ)](https://www.infoq.com/news/2025/12/orpc-v1-typesafe/)
- [Dash0: contextual logging with AsyncLocalStorage](https://www.dash0.com/guides/contextual-logging-in-nodejs) · [Maxim Orlov: pino + ALS](https://maximorlov.com/logging-with-pino-and-asynclocalstorage-in-nodejs/) · [Better Stack: pino guide](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/) · [Sentry pino integration](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/pino/)
- [Prisma OpenTelemetry tracing docs](https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing) · [Prisma 7 metrics deprecation discussion](https://github.com/prisma/prisma/discussions/27898) · [Tracing Prisma with OTel](https://oneuptime.com/blog/post/2026-02-06-trace-prisma-client-database-calls-opentelemetry/view)
- [Prisma RLS client-extension example](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security) · [RLS + Prisma for multi-tenant SaaS](https://medium.com/@francolabuschagne90/securing-multi-tenant-applications-using-row-level-security-in-postgresql-with-prisma-orm-4237f4d4bd35) · [Multi-tenant isolation strategies compared](https://dev.to/whoffagents/building-multi-tenant-saas-data-isolation-strategies-compared-299o) · [Atlas: RLS with Prisma](https://atlasgo.io/guides/orms/prisma/row-level-security)
- [BullMQ repeatable jobs docs](https://docs.bullmq.io/guide/jobs/repeatable) · [Better Stack: BullMQ scheduled tasks](https://betterstack.com/community/guides/scaling-nodejs/bullmq-scheduled-tasks/) · [Cron with multiple instances using Bull](https://dev.to/juan_castillo/handling-cron-jobs-in-nestjs-with-multiple-instances-using-bull-3pj2) · [BullMQ horizontal scaling](https://oneuptime.com/blog/post/2026-01-21-bullmq-horizontal-scaling/view)
- [rate-limit-redis](https://github.com/express-rate-limit/rate-limit-redis) · [Redis rate limiting under the hood](https://webdock.io/en/docs/how-guides/javascript-guides/rate-limiting-redis-and-nodejs-under-hood)
- [OWASP OAuth2 cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html) · [Auth0: refresh token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation) · [Auth0: detecting refresh-token hijacking](https://auth0.com/blog/refresh-token-security-detecting-hijacking-and-misuse-with-auth0/) · [Obsidian: refresh-token security practices](https://www.obsidiansecurity.com/blog/refresh-token-security-best-practices) · [Refresh token rotation explained](https://www.loginradius.com/blog/identity/secure-refresh-token-rotation)
- [Rippling: PTO accrual](https://www.rippling.com/blog/pto-accrual) · [Day Off: PTO accrual 101](https://day-off.app/paid-time-off-accrual/) · [Mercans: PTO carryover](https://mercans.com/glossary/carryover-paid-time-off-pto/) · [Gusto: change/cancel/reverse payroll](https://support.gusto.com/article/106621949100000/Change-cancel-or-reverse-a-payroll-or-payment-for-admins) · [Audit-ready payroll documentation](https://us.fitgap.com/stack-guides/producing-audit-ready-payroll-documentation-with-traceable-calculations-and-approvals) · [Employment Hero: HR/payroll audit trails](https://employmenthero.com/blog/what-is-an-audit-trail/) · [Rippling: payroll audit](https://www.rippling.com/blog/payroll-audit)
- [zod-openapi](https://github.com/samchungy/zod-openapi) · [zod-to-openapi](https://github.com/asteasolutions/zod-to-openapi) · [Speakeasy: OpenAPI from Zod v4](https://www.speakeasy.com/openapi/frameworks/zod)
