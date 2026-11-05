# Attenda Backend API and Logic

Implementation-oriented documentation for the Express API. It reflects the routes mounted in `src/app.ts` and the current Prisma model. Route handlers and Zod schemas are authoritative if older client documentation differs.

## Dashboard summary

`GET /api/v1/dashboard/summary` returns a compact home payload with the caller's local date/timezone and own attendance record. If `attendance.view_team` is granted, it also returns active team headcount and today's attendance records, scoped to organization, direct reports, and managed locations according to dynamic permissions. If the caller has an approval permission, it returns the five oldest eligible approval items using the shared `listPendingApprovals` service. If `shifts.view` and the organization `shifts` feature are enabled, it returns weekly schedule issues from the same `getScheduleIssues` service, up to five open offers, and a scoped manager queue of overdue acknowledgements plus employee conflict/help responses. The queue is limited to a recent/upcoming date window and includes employee, shift, note, and deadline details. The response omits inaccessible sections. Source feature APIs remain authoritative; open-shift claim eligibility stays in its source endpoint.

## Idempotency coverage

The shared optional `Idempotency-Key` middleware is applied to shared approval decisions, leave request/balance writes, overtime submit/review/rule administration, remote-work review, attendance-correction submit/review, attendance check-in/review/late-notice actions, expenses, employee profile/lifecycle/bulk-import/invite writes, notification read/delete actions, device enrollment/review, location/department/role administration, AI policy and shift proposal generation, compliance rules, shift templates/breaks/assignments/publish/checkpoints/availability/coverage/budgets/emergency offers, onboarding templates/assignments/tasks, document metadata, kudos, payroll adjustments/recalls, project/task and attachment writes, offboarding case/task/asset/settlement workflows, webhook administration, API-key administration, holiday writes, time tracking, and reports. The development-only local project-file upload hashes file bytes plus name, type and size before claiming its key; signed-URL creation is not replay-cached because its URLs expire. The middleware scopes keys to organization and actor, hashes the canonical request, rejects key reuse with changed input, replays stored successful responses (including empty 204 responses), and returns a conflict for concurrent or outcome-unknown retries. On 5xx responses it preserves an unknown outcome for reconciliation rather than rerunning a possibly committed action.

Web API writes persist operation keys in tab-scoped session storage, reusing them across reloads/uncertain transport retries and clearing them on success or definitive 4xx outcomes; FormData fingerprints include each file's SHA-256, filename, media type and length. The mobile Dio interceptor applies the same lifecycle using encrypted device storage, coalesces concurrent same-operation key resolution, preserves caller-owned offline attendance keys, and supports project local-file uploads using a SHA-256 fingerprint of original bytes; arbitrary multipart requests without a caller-provided content fingerprint remain excluded. Auth/token/session operations now opt into the same mechanism explicitly; attendance batch/heartbeat/IP and AI conversation paths remain excluded. Token-bearing replay bodies use AES-256-GCM, and public auth actor identifiers are hashed before storage. API/web and mobile tests cover response replay, payload collision rejection, canonical ordering, auth opt-in, retry reuse, secure persistence and upload fingerprints. The endpoint audit remains in progress; signed upload-URL responses are intentionally not replay-cached because their URLs expire. Requests without a server-supported idempotency key retain backward-compatible behavior.

## Transactional outbox operations

PostgreSQL triggers insert outbox rows in the same transaction as writes for attendance records, corrections and breaks; leave/overtime/remote requests; shift swaps, assignments, breaks, checkpoints/scans, emergency offers, availability and coverage rules; expenses; projects, tasks, members, comments, dependencies and attachments; time entries; and timesheets. Each event carries `schema_version` (currently version 1); the publisher passes this version into both Redis invalidation events and webhook delivery envelopes. The worker claims due events with `FOR UPDATE SKIP LOCKED`, retries with bounded exponential backoff, and moves exhausted rows to dead letters. `/metrics` exports `attenda_outbox_pending`, `attenda_outbox_oldest_pending_seconds`, `attenda_outbox_dead_letters`, `attenda_outbox_published_total`, and `attenda_outbox_publish_failures_total`; the depth/age gauges refresh on each worker batch, so expect up to one worker interval of staleness. Explicit payload-version migration tooling and production-like multi-instance verification remain open.

## Contents

- [Service and request lifecycle](#service-and-request-lifecycle)
- [Authentication and authorization](#authentication-and-authorization)
- [Response contract](#response-contract)
- [API catalogue](#api-catalogue)
- [Core business logic](#core-business-logic)
- [Background processing and notifications](#background-processing-and-notifications)
- [Database and migrations](#database-and-migrations)
- [Configuration and development](#configuration-and-development)
- [Change checklist](#change-checklist)

## Service and request lifecycle

| Concern | Implementation |
| --- | --- |
| Runtime | Node.js, TypeScript, Express 5 |
| Database | PostgreSQL using Prisma |
| Authentication | Signed access JWTs; rotating, persisted refresh tokens; optional TOTP and Google SSO |
| Authorization | Dynamic organization RBAC plus separate platform RBAC |
| Feature plans | Plan feature definitions merged with organization overrides |
| Cache/limits | Redis-backed token revocation and rate limiting |
| AI | Provider-neutral assistant with Gemini primary, optional OpenAI-compatible fallback, server-side permission-checked tools and stored conversations |
| Observability | Pino request logs, correlation IDs, metrics, health endpoint, domain audit/event history |
| Integrations | In-app notifications/SSE, optional email, push, WhatsApp, webhooks, object storage |

Base URL prefix: `/api/v1`. Process health: `GET /health`; dependency readiness: `GET /ready` (database and Redis). Prometheus metrics: `GET /metrics`. Generated OpenAPI JSON: `GET /api/v1/openapi.json`.

The Express stack in `src/app.ts` applies Helmet, CORS allowlisting (`FRONTEND_URL`, comma-separated), body/cookie parsing, request correlation, structured logging, a global Redis rate limit (100/minute), and an additional auth limit (20/15 minutes). The global limiter keys valid bearer-token requests by authenticated user ID, avoiding a shared office/NAT address throttling an entire workforce; invalid or unauthenticated traffic falls back to the normalized source IP. Webhook JSON raw bytes are preserved for signature validation. Routers mount in a deliberate order: corrections before general attendance, shift planning and field operations before general shifts, and outbound webhooks before generic organization routes. Route order prevents parameterized paths from swallowing specific endpoints.

### CSP report collector

`POST /csp-report` is an unversioned, unauthenticated endpoint used only by the same-origin Next.js rewrite at `/api/csp-report`. It accepts legacy `application/csp-report` and Reporting API `application/reports+json` payloads (plus `application/json`), caps bodies at 12 KiB, and returns 204 even for malformed/oversized reports or throttled requests. A Redis-backed limit allows 60 requests per trusted client IP per minute across API instances. The collector logs only bounded directive and origin/path summaries, never the raw report or query string. `app.set('trust proxy', 1)` must match the deployed ingress topology so IP limits use the real client IP.

`/health` only reports that the process responds. `/ready` returns 200 only when both PostgreSQL and Redis checks succeed, otherwise 503 with per-dependency results. Use readiness for traffic routing and health for process liveness.

## Authentication and authorization

Private routes require `Authorization: Bearer <access-token>`. `authenticate` verifies JWT signature/expiry, checks its token ID against Redis revocation keys, and attaches `req.user`. Required auth fails closed when Redis cannot check revocation.

### Middleware

- `authenticate`: validates the caller and populates identity (`sub`, `org_id`, legacy role, token ID).
- `requirePermission(...keys)`: resolves permissions and permits if any supplied key is present. Organization users resolve organization RBAC; platform admins resolve platform RBAC. It attaches `req.permissions`.
- `requireOrgFeature(...keys)`: every requested plan feature must be enabled. Platform admins are rejected from this org-feature gate.
- `requireRole`: legacy hierarchical role check. New feature gates should use dynamic permissions.
- `validate`: validates request body/query/params with the route's Zod schema.

### Dynamic access model

Effective organization permissions are:

```text
role permissions ∪ per-user allow grants − per-user deny grants
```

Platform roles and permissions are separate from organization roles. A platform administrator does not automatically receive organization permissions. Organization features are read from the organization's plan definition, then Boolean `features_override` values replace plan values.

`GET /api/v1/users/me/capabilities` is the client capability source: effective permission keys, plan features, assigned role metadata, platform permission keys, and organization timezone. Hiding UI controls is not authorization; each backend handler must still scope and enforce the action.

### Session and auth routes (`/auth`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/register` | Public | Create organization and first administrator |
| POST | `/login` | Public, rate limited | Authenticate; may return a pending 2FA challenge; supports encrypted idempotent replay |
| POST | `/logout` | Authenticated | End the current device session; legacy access tokens without session IDs fall back to revoking all sessions; idempotent retries return the stored generic result before re-authentication |
| GET | `/sessions` | Authenticated | List the caller's active device sessions, with current-session indicator |
| DELETE | `/sessions/:sessionId` | Authenticated + ownership | Revoke one of the caller's sessions, including its access and refresh tokens; safe idempotent replay |
| POST | `/refresh` | Refresh token | Rotate refresh token and issue new access token; encrypted replay prevents a lost response from reusing a rotated token |
| POST | `/forgot-password` | Public | Start password recovery; deduplicates retried email requests |
| POST | `/reset-password` | Public reset token | Set a password from recovery flow; replay-safe after session revocation |
| POST | `/setup-account` | Public invitation token | Finish invited employee setup; encrypted replay returns the issued session tokens safely |
| PUT | `/change-password` | Authenticated | Change own password and revoke sessions; retry can recover the generic success response |
| POST | `/2fa/authenticate` | Temporary challenge | Verify login second factor; encrypted replay returns the issued session tokens safely |
| POST | `/2fa/setup` | Authenticated | Start TOTP enrollment; encrypted replay protects the one-time secret and QR response |
| POST | `/2fa/verify` | Authenticated | Verify and enable TOTP with replay protection |
| DELETE | `/2fa` | Authenticated + verification | Disable TOTP with replay protection |
| GET | `/sso/google` | Public | Begin Google OAuth |
| GET | `/sso/google/callback` | Public provider callback | Validate OAuth callback and create exchange |
| POST | `/sso/exchange` | Public short-lived exchange | Exchange SSO result for application tokens |

Refresh tokens are stored in families, and each family maps to a durable `UserSession` with device label, user-agent, IP, creation/last-seen/expiry, and revocation metadata. New access tokens carry the session ID (`sid`); authentication checks a Redis revocation marker so revoking one device invalidates its remaining access tokens immediately. Each refresh invalidates the prior token and issues a successor in the same session. Rotation uses a conditional consume update to prevent two concurrent refresh requests from both succeeding. Reuse of a rotated token revokes the whole session. Tokens issued before database tracking can be adopted once into a new session. Expired/revoked session records are purged after a 30-day retention window; the Settings → Active sessions screen lists and revokes a user's own active devices.

Authentication and session mutations use explicit idempotency keys supplied by the web client and the mobile secure-storage interceptor. Public auth operations use a SHA-256 actor identifier (normalized email or a hashable one-time token) rather than storing that identifier as the actor row key. Responses containing access/refresh tokens, TOTP setup secrets, invitation setup tokens, or API credentials are encrypted with AES-256-GCM in the response cache. Logout and password-change retries are scoped to the presented bearer token and only replay their generic result; the first attempt still passes authentication. In production, `IDEMPOTENCY_RESPONSE_ENCRYPTION_KEY` must be at least 32 characters and remain stable for the 24-hour replay period.

## Response contract

Standard success:

```json
{ "success": true, "data": {} }
```

`created` responds 201; `paginated` adds `{ page, limit, total, pages }`; `noContent` responds 204. File downloads, SSE, ICS, webhooks and generated exports use protocol-specific responses.

Standard error:

```json
{ "success": false, "error": "Readable message", "code": "ERROR_CODE" }
```

Common mappings: 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 422 `VALIDATION_ERROR`, 429 `RATE_LIMITED`, 500 `INTERNAL_ERROR`. Validation errors may include `details`. Prisma unique errors map to 409 and missing-row errors to 404. Unexpected errors are logged with method/path/user; production masks internal messages.

## API catalogue

All paths below are appended to `/api/v1`. “Authenticated” implies a valid access token plus handler-level tenant/ownership checks where applicable. This guide summarizes endpoints and behavior; it does not enumerate every request/response property. Request fields and validation limits are defined by route schemas and handlers. Generated OpenAPI now derives bearer security and dynamic permission/feature metadata from tagged middleware, and includes validated query/body schemas where the shared `validate()` middleware is used. Manual handler validation and custom response payloads still require source inspection and are not fully described in OpenAPI.

### Employee accounts — `/users`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/me/capabilities` | Authenticated | Effective capabilities, features, role and timezone |
| GET, PUT | `/me` | Authenticated | Read/update own profile |
| PUT | `/me/device-token` | Authenticated | Register/remove push token |
| GET, PUT | `/me/notification-prefs` | Authenticated | Read/update notification preferences |
| GET, PUT | `/:id/permissions` | `org.permissions.grant` | Inspect/set user allow/deny permission overrides |
| GET | `/meta/departments` | Authenticated | Department metadata |
| GET | `/` | `employees.view` or `employees.view_team` | List visible employees |
| POST | `/` | `employees.create` | Create/invite employee |
| GET | `/:id` | Authenticated + scope | Read employee |
| PUT | `/:id` | `employees.update` | Update employee |
| PATCH | `/:id/deactivate`, `/:id/activate` | `employees.deactivate` | Change active state |
| POST | `/import` | `employees.import` | Import employees |
| POST | `/:id/resend-invite` | `employees.create` | Resend account invitation |

### Attendance and remote work — `/attendance`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/today` | `attendance.view_team` | Team attendance for today |
| GET | `/late-summary` | `attendance.view_team` | Late arrival summary |
| GET | `/me` | Authenticated | Own attendance history |
| GET | `/today-status` | Authenticated | Current shift, attendance, break state and server time |
| GET | `/leave-check` | Authenticated | Check leave/attendance conflicts |
| POST | `/checkin` | Authenticated + schema | Check in using configured attendance method; supports optional idempotency metadata |
| POST | `/sync` | Authenticated bearer token + schema | Ordered batch sync for offline check-in, checkout and break actions; returns one replay-safe outcome per event |
| GET | `/reviews` | `attendance.review_flags` | List offline check-ins requiring trust review |
| PUT | `/reviews/:id/resolve` | `attendance.review_flags` | Approve, reject, or request recheck with a required note; decision does not directly change wages |
| POST | `/checkout` | Authenticated + schema | Finalize attendance and hours/break calculations |
| POST | `/heartbeat` | Authenticated + schema | Report mobile presence heartbeat |
| POST | `/ip-event` | Authenticated + schema | Report network change for Wi-Fi policy evaluation |
| POST | `/break/start`, `/break/end` | Authenticated + schema | Start/end break |
| PUT | `/:id/override` | `attendance.override` | Correct attendance record |
| GET | `/report/export` | `attendance.export` | Export attendance |
| GET | `/:userId` | `attendance.view_team` | Read employee attendance |
| GET | `/remote/sessions` | `remote.approve` | Team remote sessions |
| GET | `/remote/sessions/me` | Authenticated | Own remote sessions |
| GET | `/remote/monitor` | `remote.approve` | Active remote session monitoring; “today” is resolved from each attendance record’s assignment/employee location timezone, with organization timezone fallback |
| GET | `/remote/sessions/:id/logs` | Authenticated + owner/reviewer scope | Remote activity logs |
| PUT | `/remote/sessions/:id/approve`, `/reject` | `remote.approve` | Decide remote request; rejection requires a 3–500 character reason, stored with reviewer/time and included in the employee notification. Both decision transitions are conditional on `pending` to prevent competing decisions. |
| GET | `/late-notice/me` | Authenticated | Own late notices |
| POST | `/late-notice` | Authenticated + schema | Submit late notice |
| GET | `/late-notices` | `attendance.late_notices.manage` | Review queue |
| PUT | `/late-notice/:id/acknowledge` | `attendance.late_notices.manage` | Acknowledge notice |
| DELETE | `/late-notice/:id` | Authenticated + scope | Cancel/delete eligible notice |

Organization attendance controls are under `/org` and require `org.office.update`: `GET/PUT /wifi-attendance` configures heartbeat-based auto attendance; `GET/PUT /attendance-security` reads and updates office geofence and location-evidence policy. Location policy defaults off. When enabled, manual and QR check-in can submit `latitude`, `longitude`, `accuracy_m` and client-reported `is_mocked`; `require_location` rejects missing evidence, `enforcement: block` rejects clearly outside or low-accuracy evidence, and warning mode records the result. Enabling any geofence routes network auto-check-in to manual check-in so location policy cannot be bypassed. This policy applies to office attendance; remote check-ins do not use the office geofence.

Attendance corrections mount at `/attendance/corrections` before generic attendance routes:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| POST | `/` | Authenticated | Submit own correction request |
| GET | `/me` | Authenticated | Own correction requests |
| GET | `/` | `attendance.override` | Reviewer queue |
| PUT | `/:id/approve`, `/:id/reject` | `attendance.override` + schema | Decide correction; approval applies requested timestamps |

Correction approval uses a pending-status compare-and-set. The attendance update, correction linkage, audit entry, and notification request are committed together; rejected corrections persist the review reason and notification request in the same transaction. This keeps retries from applying the correction twice and prevents a committed decision from losing its notification intent.

### Leave, overtime, expenses and shared approvals

Leave request dates are persisted as date-only values and capture the employee’s primary location when submitted. Future-date validation uses that location’s timezone (organization timezone is the legacy fallback), and working-day calculation includes global plus location-specific holidays. The location snapshot keeps holiday interpretation stable if the employee later transfers. On approval, attendance leave records skip weekends and the captured location’s holidays using UTC date-only arithmetic, independent of the API host timezone. The organization leave-accrual policy is applied using each active employee’s current location-local year/month; unique employee/type/period grant rows and balance/ledger updates commit in the same transaction. The organization-local daily 02:00 schedule checks employees during local days 1–2 to absorb inter-zone boundary differences. Per-location accrual policy values are not yet configurable.

`/leave`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/requests/me` | Authenticated | Own leave requests |
| GET | `/requests/team` | `leave.view_team` or `leave.approve` | Team requests |
| GET | `/requests` | `leave.view_all` | Organization requests |
| POST | `/requests` | Authenticated + schema | Submit leave request |
| DELETE | `/requests/:id` | Authenticated + own pending request | Cancel request |
| PUT | `/requests/:id/approve`, `/reject` | `leave.approve` | Decide request |
| GET | `/balance/me` | Authenticated | Own balances |
| GET | `/balance/me/ledger` | Authenticated | Own append-only balance history |
| GET | `/balance/:userId` | `leave.view_team` or `leave.balance.manage` | Read employee balance |
| GET | `/balance/:userId/ledger` | `leave.view_team` or `leave.balance.manage` | Read employee balance history; team access is limited to direct reports |
| PUT | `/balance/:userId` | `leave.balance.manage` | Adjust balance |
| GET | `/calendar` | `leave.view_team` or `leave.view_all` | Leave calendar |

`/overtime`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| POST | `/requests` | Authenticated + schema | Submit own overtime request |
| GET | `/requests/me` | Authenticated | Own requests |
| GET | `/requests` | `overtime.manage` | Reviewer queue |
| PUT | `/requests/:id/approve`, `/reject` | `overtime.manage` | Decide request |
| GET, POST | `/rules` | `overtime.manage` | List/create rules |
| PUT, DELETE | `/rules/:id` | `overtime.manage` | Update/delete rule |
| GET | `/summary` | `overtime.manage` | Summary |

`/expenses`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| POST | `/` | Authenticated + schema | Submit claim |
| GET | `/me` | Authenticated | Own claims |
| GET | `/` | `expenses.view` or `expenses.manage` | List/review claims; supports signed cursor mode (`cursor_mode=true`, optional `cursor`, `limit`, and `include_total`). `expenses.view` is limited to direct reports; `expenses.manage` can review org claims. |
| PUT | `/:id/approve`, `/reject` | `expenses.manage` | Decide claim |
| POST | `/:id/reimburse` | `expenses.manage` | Mark reimbursement |

`/approvals` combines source request records without copying their domain data:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | Authenticated; types filtered by permission and scope | Unified pending queue: leave, overtime, remote, swap, late notice, expense, correction, and timesheets. Add `cursor_mode=true` and optional `limit` (1–100), then pass the returned signed `next_cursor` to page through the union. Cursor filters bind the token to the organization, reviewer, and effective request types. Ordering is oldest submission first, then request type and ID. `countsByType` is page-local in cursor mode; the legacy overview response keeps a capped item sample but returns exact per-source counts. |
| POST | `/review` | Authenticated; source-type permission and reviewer scope | Approve/reject one request or acknowledge late notice |

`GET /api/v1/my-requests/me` returns the authenticated employee's own leave, remote-work, overtime, expense, attendance-correction, shift-swap, availability, and late-arrival-notice history. Each item links back to its source feature; the endpoint never changes source data. `limit` is 1–100 (default 25), `type` and `status` are optional filters (`waiting`/`decided` groups or an exact status), and `q` searches source titles/reasons/notes. The signed cursor carries an independent keyset position for each source and is bound to org, user, and filters; merging is newest-first. If a source query fails, its label is returned in `unavailable` while other sources still return. The employee web hub loads more with this cursor.

### Shifts and scheduling

`/shifts` general routes:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | shifts feature + `shifts.view` | Templates, break rules, assignment counts |
| POST | `/` | shifts feature + `shifts.manage` | Create shift template |
| POST | `/ai-template` | shifts feature + `shifts.manage` | Return validated, unsaved AI template proposal |
| PUT, DELETE | `/:id` | `shifts.manage` | Update/delete template |
| GET | `/:id` | `shifts.view` | Read template |
| GET | `/:id/breaks` | `shifts.view` | List break policies |
| POST | `/:id/breaks` | `shifts.breaks.manage` | Add fixed/flexible break policy |
| PUT, DELETE | `/:shiftId/breaks/:breakId` | `shifts.breaks.manage` | Update/delete break |
| GET | `/schedule` | `shifts.view` | Weekly schedule (`week_start=YYYY-MM-DD` optional) |
| GET | `/assignments` | `shifts.view` | Assignments filtered by week, department, employee, location (`unassigned` supported), publish state, and search; department/employee filters intersect rather than replace the caller’s manager/location visibility scope |
| GET | `/assignments/me` | Authenticated | Own future/recent assignments, breaks and active checkpoint metadata |
| GET | `/assignments/:id/detail` | Assignment owner or `shifts.view` | Assignment + attendance + break details |
| POST | `/assignments` | `shifts.assign` | Assign one employee/date |
| POST | `/assignments/bulk` | `shifts.assign` | Bulk assignment; row conflicts/warnings and dry run supported |
| DELETE | `/assignments/:id` | `shifts.assign` | Remove assignment |
| POST | `/schedule/publish` | `shifts.assign` | Publish up to one week and notify assigned employees |
| POST | `/ai-schedule` | `shifts.ai_schedule` | Create an unsaved staffing plan draft |
| GET | `/swaps/me` | Authenticated | Own shift swaps |
| GET | `/swaps` | `shifts.swaps.approve` | Review queue |
| POST | `/swaps` | Authenticated | Request a swap |
| PUT | `/swaps/:id/approve`, `/reject` | `shifts.swaps.approve` | Decide swap; rejection requires reason |

`/shifts/planning`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/availability/me` | Authenticated | Own availability requests |
| POST | `/availability` | Authenticated | Submit preferred/unavailable times |
| DELETE | `/availability/:id` | Authenticated + owner/pending check | Withdraw own request |
| GET | `/availability` | `shifts.availability.manage` | Team queue |
| PUT | `/availability/:id/review` | `shifts.availability.manage` | Review request (rejection requires reason) |
| GET | `/coverage` | `shifts.view` | Staffing coverage view/rules |
| PUT | `/coverage` | `shifts.coverage.manage` | Configure coverage rules |
| GET | `/issues` | `shifts.view` | Conflicts and coverage issues |
| GET | `/workload` | `shifts.view` | Employee scheduled workload |
| POST | `/copy-week` | `shifts.assign` | Copy schedule week with conflict handling |
| GET | `/history` | `shifts.view` | Schedule change history |
| GET | `/export.ics` | `shifts.view` | iCalendar export |

`/shifts` field operations (mounted before the general shifts router):

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/open-shifts` | shifts feature + authenticated | Open emergency shift offers and eligibility reasons |
| POST | `/open-shifts` | shifts feature + `shifts.assign` | Create offer and notify eligible employees |
| POST | `/open-shifts/:id/claim` | shifts feature + authenticated eligible employee | Claim offer, create assignment |
| POST | `/open-shifts/:id/cancel` | shifts feature + `shifts.assign` | Withdraw offer |
| GET | `/:shiftId/checkpoints` | shifts feature + `shifts.checkpoints.manage` | Checkpoints, QR data, scan counts |
| POST | `/:shiftId/checkpoints` | shifts feature + `shifts.checkpoints.manage` | Create ordered checkpoint and QR token |
| PUT | `/:shiftId/checkpoints/:checkpointId` | shifts feature + `shifts.checkpoints.manage` | Update point configuration |
| POST | `/:shiftId/checkpoints/:checkpointId/rotate-qr` | shifts feature + `shifts.checkpoints.manage` | Replace/expire prior QR token |
| DELETE | `/:shiftId/checkpoints/:checkpointId` | shifts feature + `shifts.checkpoints.manage` | Delete checkpoint |
| GET | `/assignments/:assignmentId/checkpoints` | Assignment owner or `shifts.view` | Employee progress and scan history |
| POST | `/checkpoints/scan` | shifts feature + own assignment | Validate and persist checkpoint scan |

### Projects and tasks — `/projects`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | `projects.view` | List visible projects and summaries |
| POST | `/` | `projects.manage` | Create project |
| PUT, DELETE | `/:id` | `projects.manage` | Update/delete project |
| POST | `/:id/members` | `projects.manage` | Add a member to the project |
| DELETE | `/:id/members/:userId` | `projects.manage` | Remove a member when they own no open tasks; project owner transfer is required before removing the owner |
| POST | `/:id/tasks` | `projects.tasks.manage` | Create task/milestone |
| PUT | `/tasks/:taskId` | Authorized project/task scope | Update task, assignment, status, dates, priority or dependencies |
| POST | `/tasks/:taskId/comments` | Authorized task participant/editor | Add comment and explicit `mention_ids`; mentioned users must be active project members. Comment, audit, and per-recipient notification requests commit together through the outbox |
| POST | `/:id/attachments/upload-url` | Authorized project scope | Request object-storage upload URL |
| POST | `/:id/attachments/upload-local` | Authorized project scope | Upload via local storage fallback |
| POST | `/:id/attachments` | Authorized project scope | Register attachment metadata |
| GET | `/attachments/:attachmentId/download`, `/file` | Authorized project scope | Download/stream attachment |
| GET | `/:id/activity` | Project-visible user | Project/task activity |
| GET | `/:id/calendar.ics` | Project-visible user | Project date export |

Project task assignees must be project members. Task edits record title, description, status, owner, priority, dates, and dependency changes in audit history. Dependency edits serialize per project and reject cycles. Web and mobile provide project search/status filtering and task search/status/priority/owner/due-date filters; web additionally provides board, list, calendar, and timeline views. Task details carry subtasks, files, dependencies, and discussion. The project file service uses signed object-storage URLs in configured deployments and a development-only local fallback.

### Payroll — `/payroll`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | `payroll.view` | List payroll records |
| GET | `/journal.csv?year=YYYY&month=1..12` | `payroll.view` | Download an account-aggregated, balanced journal for processed payroll; omit month for a year. Rows are separated by currency and include wages, tax/pension/statutory liabilities, net payroll payable, and employer contributions. An out-of-balance source period is rejected instead of producing an invalid journal. This is an accounting export only and never initiates a payment. |
| GET | `/rates/:userId` | `payroll.manage` | Read an employee's effective-dated hourly rate history |
| GET | `/statutory-parameter-sets` | `payroll.view` | List organization tax/contribution rule versions |
| POST | `/statutory-parameter-sets` | `payroll.manage` | Create a validated, immutable draft rule set |
| POST | `/statutory-parameter-sets/:id/activate` | `payroll.process` | Activate as a different user; closes prior effective range and marks affected drafts stale |
| POST | `/generate` | `payroll.manage` | Generate/refresh period draft, preserve manual adjustment amounts, attribute new/current drafts to the generating user, and mark calculated inputs current |
| GET | `/me` | Authenticated | Own payroll records |
| GET | `/:id` | `payroll.view` | Read payroll record |
| PUT | `/:id/adjust` | `payroll.manage` | Adjust payroll record |
| POST | `/:id/recall` | `payroll.process` | Recall eligible processed data |
| POST | `/process-full` | `payroll.process` | Finalize eligible period records, generate payslips and notify employees. Requires fresh complete drafts and a different processor from the recorded generator. A renewable Redis lease prevents concurrent processing for the same org and period; Redis unavailability fails closed. Already processed records are skipped on retry, while per-record failures are returned for review. |
| GET | `/payslips/:id`, `/payslips/:id/download` | Owner or payroll scope | Read/download payslip |

### Performance, announcements and analytics

`/performance`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET, POST | `/announcements` | Authenticated / `org.announcements.send` | List/create announcements |
| POST | `/announcements/:id/read` | Authenticated | Mark read |
| GET | `/announcements/:id/receipts` | `org.announcements.send` | Read acknowledgment receipts |
| GET | `/reviews` | `performance.view` | Team reviews |
| GET | `/reviews/me` | Authenticated | Own reviews |
| POST | `/reviews/:userId` | `performance.manage` | Create review |
| GET | `/goals` | Authenticated + scope | List visible goals |
| POST | `/goals` | `performance.manage` | Create goal |
| PUT | `/goals/:id` | `performance.manage` | Update goal/progress |
| GET | `/reviews/:userId/insights` | `performance.view` | AI review insights (provider/config dependent) |

`/analytics`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/overview` | Authenticated + handler scope | Workforce overview |
| GET | `/attendance-trend` | Authenticated + handler scope | Attendance trend |
| GET | `/late-arrivals` | Authenticated + handler scope | Late arrival analytics |
| GET | `/payroll-cost` | `analytics.advanced` | Payroll cost analytics |
| GET | `/anomalies` | `analytics.advanced` | Attendance anomalies |
| GET | `/payroll-anomalies` | `analytics.advanced` | Payroll anomalies |
| POST | `/chat` | Authenticated + analytics scope | Ask analytics follow-up questions |

### Organization, departments and holidays

`/org`:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET, PUT | `/settings` | `org.settings.view`, `org.settings.update` | Read/update org configuration and timezone |
| GET | `/whos-out` | Authenticated + scope | Employees out today |
| GET | `/audit-logs` | `org.audit.view` | Search audit history |
| GET | `/my-ip` | Authenticated | Report caller IP for setup |
| GET, PUT | `/office-ips`, `/office-ssids` | `org.office.update` | Read/update attendance network allowlists |
| GET, PUT | `/wifi-attendance` | `org.office.update` | Configure Wi-Fi attendance and grace behavior |
| GET, PUT | `/whatsapp` | `org.whatsapp.update` + WhatsApp feature | Read/update WhatsApp settings |
| GET | `/whatsapp/usage?month=YYYY-MM` | `whatsapp.logs.view` + WhatsApp feature | Organization-local usage, configured limit, remaining attempts, and estimated cost history |
| POST | `/whatsapp/test` | `whatsapp.test` + WhatsApp feature | Send test |
| GET | `/whatsapp/logs` | `whatsapp.logs.view` + WhatsApp feature | Delivery logs |
| GET | `/departments` | Authenticated | List departments |
| GET | `/qr-code` | `org.qr.manage` | Read org QR |
| POST | `/qr-code/regenerate` | `org.qr.manage` | Rotate org QR |

`/org/departments`: `GET /`, `GET /tree` (authenticated); `POST /`, `PUT /:id`, `DELETE /:id` (`org.departments.manage`).

`/org/holidays`: `GET /` (authenticated); `POST /`, `DELETE /:id` (`org.settings.update`).

### Documents, onboarding, kudos and notifications

`/documents`: `POST /upload-url`, `POST /`, `GET /me`, `GET /user/:userId` (`documents.view_team`), `GET /:id/download`, `DELETE /:id`. Ownership or reviewer scope applies to document access.

`/onboarding`: `GET/POST /templates`, `PUT/DELETE /templates/:id`, `POST /assign` (`onboarding.manage`); `GET /me`, `GET /user/:userId` (`onboarding.view_team`); `PUT /tasks/:id/complete`, `PUT /tasks/:id/skip` (authenticated with ownership checks).

`/kudos`: `POST /`, `GET /`, `GET /mine`, `DELETE /:id`; handlers scope records to the organization and sender/recipient permissions.

`/notifications`: `GET /stream` (authenticated SSE), `GET /`, `GET /count`, `PUT /read-all`, `PUT /:id/read`, `DELETE /:id`. Users can only access their own notification records. `GET /` keeps page-number pagination by default. Set `cursor_mode=true` for cursor pagination; response contains `items`, `next_cursor`, `has_more` and `unread_count`. Pass `next_cursor` as `cursor` for the next page. New cursors are versioned base64url payloads signed with HMAC and bound to the effective filters; altered cursors and changed filters are rejected. Bare UUID cursors remain temporarily supported for in-flight clients.

`GET/PUT /users/me/notification-prefs` uses the structured `categories`, `channels`, `quiet_hours`, and `digest` contract. A migration converts saved preference data to this schema; root-level category flags are rejected. Notification and channel-delivery queue records are committed together. In-app delivery is immediate; push and email use a retrying delivery worker, and WhatsApp is sent only after explicit, timestamped user consent. Quiet hours defer push/email/WhatsApp in the organization timezone. Daily and weekly email digests group due messages. Delivery attempts and terminal failures are stored in `NotificationDelivery`; invalid FCM tokens are removed. Terminal delivery history is retained for 90 days. Provider delivery still requires valid Firebase, transactional-email, and organization WhatsApp configuration.

WhatsApp organization settings include an optional monthly attempt limit (unset by default; `null` means no cap), an alert percentage, and an optional estimated cost per provider attempt in the organization's currency. `whatsapp_usage_periods` maintains an atomic monthly reservation counter in organization-local calendar months. A reservation is taken before every Cloud API request, including retries, because a timed-out request may still have reached the provider. Once an explicitly configured cap is reached, later WhatsApp sends are suppressed while their already-queued in-app/push channels continue; admins with WhatsApp settings or log access receive one in-app threshold alert and one cap alert. The usage API returns count history and a cost estimate only for attempts that had a configured rate. Each sent log stores Meta's message ID; signed status callbacks reconcile sent/delivered/read/failed state, event time, pricing category/model, and billable flag, ignoring duplicate, unknown, stale, and regressive callbacks. The web usage screen displays recent provider receipts. Configured rate totals remain estimates, not provider invoices; subscription-plan quota integration remains future work.

Cursor pagination is also available on `GET /org/audit-logs`, `GET /attendance/me`, and `GET /leave/requests`, `/leave/requests/me`, and `/leave/requests/team` using `cursor_mode=true`, optional `limit`, and `cursor` on subsequent requests. Their cursor-mode responses contain `items`, `next_cursor`, `has_more` and `limit`. Keyset ordering is `(created_at desc, id desc)` for notifications/audit/leave and `(date desc, id desc)` for attendance. Cursors are bound to the caller's organization or user scope and active filters. Existing response formats remain unchanged when cursor mode is omitted. Web organization/team leave queues and mobile personal and manager leave queues use cursor pages with explicit load-more controls. Migration `20261109110000_leave_cursor_scopes` adds user/date and org/status/date indexes for those paths.

### AI conversations — `/ai`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/conversations` | `analytics.ai_chat` | List up to 50 caller-owned conversations with first-message title, context label, update time and message count |
| GET | `/conversations/:id` | `analytics.ai_chat` + owner/org validation | Read the latest 100 messages, stored context, total count, and whether older messages were omitted |
| POST | `/chat` | `analytics.ai_chat` + AI configuration | Accept a message and optional new-thread context; reply, invoke authorized tools, persist history |

AI tools are defined/filtered in `src/routes/ai.ts` and executed in `src/services/ai/agent.ts`. User identity and effective permissions are loaded server-side. Read tools query only records in the caller's scope. Identity and project/task context are serialized into a separate session-data message, never interpolated into system instructions; the prompt directs the model to treat database/tool/context values as untrusted data. Before proposing a write, `src/services/ai/write-intent.ts` checks the latest user turn for an explicit field/action intent and rejects questions and common negations. Writes are then presented as pending actions; no write tool executes until the caller confirms. Confirmation claims the pending action once, and the executor still checks permissions and record scope. Prior chat history or an assistant statement never authorizes a new write. Regression tests cover hostile identity/context values, missing users, question/negation rejection and explicit write intents. Provider credentials, quota and timeout affect availability; AI responses must not invent records when a tool fails. These focused checks do not replace a provider-level adversarial/golden-conversation evaluation suite.

### Integrations, public and platform APIs

`/org/outbound-webhooks`: `GET/POST /`, `GET /catalogue`, `DELETE /:id`, `POST /:id/test`, `GET /:id/deliveries`, and `POST /:id/deliveries/:deliveryId/replay` (all require `org.settings.update`). The catalogue lists supported event names, descriptions, envelope fields, and the current schema version. Each delivery includes `id`, `event`, `schema_version`, `org_id`, and an ISO-8601 UTC `timestamp`; the payload is signed with HMAC-SHA256. Secrets are generated on create and returned only in that response. Event deliveries are persisted before sending, retried with exponential backoff up to eight attempts, then moved to `dead_letter`. The delivery log includes schema version, outcome, attempt count, HTTP status and last error. Administrators can replay only dead-letter deliveries; replay and failure history is retained independently of webhook removal. Webhooks auto-disable after 20 consecutive failures. `POST /webhooks/whatsapp` receives provider callbacks; `GET /webhooks/whatsapp` handles provider verification.

`/org/api-keys` is available to users with `org.settings.update` when the organization's `api_access` feature is enabled. `GET /` lists prefixes and metadata only; `GET /scopes` returns only supported scopes the current administrator has. `POST /` creates a key and returns the raw token once. `POST /:id/rotate` revokes the prior key atomically and returns its replacement once; `DELETE /:id` revokes immediately. Keys expire after the selected duration (maximum 365 days) or can be created without expiry through the API. Only a SHA-256 hash and public prefix are stored. Requests are throttled by key prefix, and last-use timestamps are written at most once every five minutes. Audit events cover creation, rotation, and revocation.

`/integrations/v1` is a separate read-only integration API authenticated with an API key. Key authentication is not accepted on the internal user API. Every request checks that the owner remains active, the key is not expired/revoked, the organization's API feature remains enabled, the owner still holds the current dynamic permissions, and the key includes the requested scope. Supported reads are `GET /employees` (`employees.view` or `employees.view_team`), `GET /attendance?from=YYYY-MM-DD&to=YYYY-MM-DD` (`attendance.view_team`, maximum 93 days), `GET /leave` (`leave.view_all` or `leave.view_team`), and `GET /projects` (`projects.view`). Team scopes are restricted to the key owner's direct reports; project reads are restricted to projects the owner can access. Every list uses a signed cursor and a maximum page size of 100. The first API release deliberately exposes no write operations. API-key create and rotate replay bodies are AES-256-GCM encrypted in the idempotency store so one-time credentials remain replayable without persisting plaintext. Production requires a stable `IDEMPOTENCY_RESPONSE_ENCRYPTION_KEY` of at least 32 characters; development can derive the key from `JWT_REFRESH_SECRET`. Keep the key stable for at least the 24-hour replay window. A cleanup migration redacts raw keys stored by the earlier implementation.

### Personal shift calendar feed (ICS)

- `GET /api/v1/users/me/calendar-feed` reports whether the signed-in user's feed is active and when it was last fetched.
- `POST /api/v1/users/me/calendar-feed` creates or replaces a feed and returns its secret URL once. Store only the SHA-256 token hash in `calendar_feeds`; replacement revokes the prior URL immediately.
- `DELETE /api/v1/users/me/calendar-feed` revokes the feed. `GET /api/v1/calendar/:token.ics` is the unauthenticated read-only subscription endpoint; the unguessable token is its credential.
- Feeds contain only the subscribing active employee's published shifts for a rolling window (45 days back and 370 days forward). Revoked feeds and deactivated/deleted accounts return 404. Responses are private and no-store.
- Shift wall times are converted using the organization's current timezone and emitted as UTC timestamps, including overnight shifts. ICS subscriptions are read-only and clients control refresh intervals.
- Configure `API_PUBLIC_URL` (or `API_URL`) to the externally reachable API origin so generated subscription URLs work outside local development.

`/public` (public): `POST /onboard`, `GET /plans`, `GET /blog`, `GET /blog/:slug`.

`/admin` uses platform permissions, independent of org roles:

- Organizations: `GET /stats`, `GET /orgs`, `GET /orgs/pending`, `GET /orgs/:id`, `GET /orgs/:id/users`, `POST /orgs`, `PATCH /orgs/:id`, `PATCH /orgs/:id/plan`, `PATCH /orgs/:id/suspend`, `PATCH /orgs/:id/subscription`, `POST /orgs/:id/extend-trial`, `POST /orgs/:id/activate`, `POST /orgs/:id/approve`, `POST /orgs/:id/reject`.
- Plans: `GET/POST /plans`, `PUT/DELETE /plans/:id`.
- Public blog management: `GET/POST /blog`, `GET/PUT/DELETE /blog/:id`, `PATCH /blog/:id/publish`.
- Operations: `POST /broadcast`, `GET /audit-logs`.

`/admin/users` and `/admin/roles` provide platform user and platform-role management under `platform.users.manage` and `platform.roles.manage` permissions. `/reports` exposes `POST /:type` for supported report generation using scoped input.

**OpenAPI limitation:** `src/services/openapi.ts` derives request schemas from `validate()` and success response schemas from the `documentResponse(zodSchema)` middleware. The shared dashboard summary is the first response route documented this way. Most handlers still use generic success data, manually validated request bodies remain undocumented, and custom response routes (downloads, SSE, ICS, 204 deletes) need explicit metadata. Typed web/mobile clients and compatibility checks are not yet generated, so this spec is an improving reference, not a complete external contract.

## Core business logic

### Attendance, timezone and breaks

The organization's IANA timezone defines local work dates and shift wall-clock times. Persisted event timestamps are instants. Overnight shift ends resolve to the following local date. `/attendance/today-status` is the canonical current-state response for clients; client-side timers are presentation only.

Effective shift resolution uses the dated employee assignment first, then applicable published organization-wide/default fallback. Attendance is unique per employee/date. `POST /checkin` accepts `idempotency_key`, `client_event_at` and `offline`; offline clients also provide a signed server-time anchor, process-monotonic elapsed time, and clock epoch. The server derives a plausible event time from the anchor and monotonic delta rather than trusting the device wall clock. A drift over two minutes, an expired anchor/sync delay over ten minutes, or a changed process epoch marks the record for manager review; missing or invalid proof falls back to server receipt time and review. The server separately records when it received the event. Reusing a key with the same request hash is idempotent; reusing it with different content returns `409 IDEMPOTENCY_KEY_REUSED`. Unique employee/date constraints also protect concurrent duplicate requests. The mobile client persists the original event time, proof and key, then retries on connectivity recovery. When location policy is enabled, the same endpoint stores location accuracy, mock-location signal, geofence decision and distance with the record. Approved leave is checked against the reconciled date; partial/timed leave follows its own interval rules. Remote check-in does not use the office geofence; shift checkpoint location behavior remains separate.

The mobile outbox queues manual check-in, check-out, break start and break end with signed server-clock proof, a unique idempotency key and a monotonically increasing local sequence. `POST /attendance/sync` accepts up to 20 actions (32 KiB per event) in strictly increasing sequence order and returns `applied`, `duplicate`, `parked_for_review`, `rejected`, `retry`, or `not_attempted` for each event. It serializes concurrent syncs per employee with a Redis lease and dispatches each event through its existing action endpoint so policy and business validation remain shared. A short `attendance_sync_watermarks` lease is active while the batch is being reconciled; late and absent detectors skip that employee until the sync finishes or the lease expires. The mobile client serializes local flush attempts, removes confirmed events, parks permanent/review outcomes, and preserves the same idempotency key for uncertain retries; later events are held when an earlier event is unresolved. Existing `attendance.review_flags` review records provide manager resolution for accepted events with uncertain time proof. Wi-Fi observations remain separate and are never treated as offline office-network evidence. When an actual check-in arrives for a work date, the API resolves matching in-app no-show notifications (late, absent and escalation), preserves their original content, and writes an audit entry. Previously delivered external messages cannot be recalled. Set `API_INTERNAL_ORIGIN` when the API's loopback origin is not `http://127.0.0.1:$PORT`.

All checkout paths use shared helpers in `src/utils/attendance.ts`. They close open breaks, compute paid/unpaid duration, update attendance summaries and calculate net hours. Paid break time counts as work; unpaid time is subtracted from gross time. Fixed breaks can be auto-started, and mandatory skipped unpaid breaks may be deducted when policy allows. Overtime is evaluated against persisted scheduled end, including overnight shifts. Heartbeat expiry is a distinct configurable auto-checkout path: when `wifi_auto_checkout_enabled` is on, the monitor checks out an active record after `heartbeat_grace_mins` without requiring an IP-change event. The default is disabled; teams should account for mobile OS background-network limits when enabling it. An IP/network event may also start its own grace behavior.

### Request and approval lifecycle

1. A domain route/service creates the source record (leave, overtime, remote, correction, expense, swap, availability) with validated owner, organization, dates and domain constraints.
2. Persistent notifications inform requester/reviewer where configured. Mutations emit organization invalidation events so clients refetch authoritative state.
3. The shared approvals route reads the original source records, applies permission and direct-report scope, computes age/urgency and links to the feature page. It does not copy business data.
4. Review checks permission, tenant, reviewer scope and pending state. Rejections require a reason. Late-arrival notices are acknowledge-only.
5. State/accounting side effects use transactions or conditional updates where required. Leave approval checks scheduled shift conflicts and updates request, balance and attendance together. Repeated or stale decisions are rejected.
6. Audit history records actor, action, reason, and before/after state where supported.

### Shift assignment and coverage

- Assignment handlers verify employee and shift organization scope, employee active state and one assignment per employee/date.
- Bulk assignment validates rows individually and can run as a dry-run, returning conflicts and warnings without writing.
- Availability is a request, not an assignment. Manager review is separate from schedule publication.
- Publishing is limited to one week, marks selected assignments published, creates a schedule event, and notifies assigned employees. WhatsApp reminders are optional side effects.
- Swap approval changes both assignment shift IDs in a database transaction. Rejection requires a reason.
- AI schedule generation returns a reviewable proposal; it does not save assignments. Managers apply accepted results using assignment APIs.

### Emergency open shifts

An authorized scheduler offers an existing shift for a date and expiry. Candidate employees must be active and not assigned that date, on approved overlapping leave, or unavailable for the interval. The service creates in-app notifications and a schedule event. Candidate eligibility is rechecked at claim time because schedules can change after an offer.

Claim conditionally transitions the offer and creates a published assignment in a transaction. It rejects stale/closed offers, same-day assignments, approved leave/unavailability, overlapping shifts or insufficient rest from adjacent shifts. A successful claim notifies the creator and remaining recipients. Expiration is processed when the open-offer list is read; a manager can cancel an offer.

### Safety checkpoint and QR scans

A manager configures ordered points with safety instructions, required/optional state and minimum scan interval. The server generates a random token and returns QR payload. Rotating a QR invalidates the previous token while preserving scan records. A scan verifies active token, organization, the signed-in employee's matching assignment/date, current date, active checked-in attendance and interval. Valid scans store employee, assignment, checkpoint, timestamp and optional GPS coordinates/accuracy. Employees read only their own assignment history; managers with `shifts.view` can inspect organizational assignment data.

### Projects and tasks

Projects contain shared outcomes; tasks/milestones capture actionable ownership, priority, dates, status and dependencies. Membership, visibility and assignment inform record access, while mutations still require their dynamic permissions. Comments, files, dependencies, activity and notifications remain attached to their source task/project. Attachments use signed object storage when configured and local storage where supported. The approval inbox does not become a duplicate source of project state.

### Payroll, reports and analytics

Payroll generation uses attendance totals, approved overtime and the hourly rate effective for that payroll month (rate changes take effect on the first of a month). Missing compensation inputs are surfaced as incomplete records for review. Payroll adjustment and processing require dedicated permissions; employees can only read their own payslips unless granted broader scope. Analytics and report handlers must constrain source rows to the caller's organization and visibility. These calculations do not file taxes or submit payroll to an external provider.

Regional payroll inputs are organization-managed and effective-dated in `StatutoryParameterSet`; no jurisdiction rate is shipped as a default. Payroll managers create drafts with progressive annual tax bands, employee/employer contribution percentages, optional monthly wage caps, and a source/review reference. A distinct `payroll.process` actor activates a draft. Activation serializes by organization and country, prevents overlapping future versions, closes a prior open-ended version immediately before the new version, updates the organization country, and marks affected payroll drafts stale. For each month, payroll selects the active parameter set effective at period end. Tax is calculated using the configured progressive bands and a calendar-year projection: recorded earlier monthly gross plus current gross annualized across the remaining months, less tax already withheld, spread over remaining months. The configured contribution rates apply to gross pay (capped where configured). The exact legal tax base, annualization method, rates and caps must be reviewed by a qualified local adviser; these outputs are calculation aids. The selected set ID and calculation method are stored on each record and included in the stale-input hash. Employee statutory deductions and employer contributions appear separately in payslips. `GET /payroll/me/annual-statement?year=` returns an employee’s own processed annual summary; `GET /payroll/annual-statement?year=&user_id=` requires `payroll.view` and is organization-scoped. CSV downloads are available through `/payroll/me/annual-statement.csv?year=` and `/payroll/annual-statement.csv?year=&user_id=`; they include monthly processed earnings, deductions, contribution detail, tax method and source references. These summaries are clearly labeled reference calculations, not government tax certificates. Employee compensation edits made through `PUT /users/:id` require `payroll.manage`; an optional `hourly_rate_effective_from` date records the effective month, defaulting to the next organization-local month. `GET /payroll/rates/:userId` returns the organization-scoped history to payroll managers. Historical rates are snapshotted on employee creation where available; legacy values are backfilled as `legacy_snapshot`, because older changes cannot be reconstructed. The selected `pay_rate_id` and rate are stored on each payroll record and included in the input hash. Draft payroll is marked stale when an effective rate changes. Schedule labor-cost estimates use the rate effective on each assignment date; only hourly rate basis is supported so far. With no active set, the pre-existing organization flat-rate calculation remains the compatibility fallback. Payroll statutory records are not yet included in an annual salary certificate or contribution export, and statutory rule packs are not yet joined to the schedule/attendance compliance evaluator.
The payroll page offers a `Journal CSV` download for a processed month. `GET /payroll/journal.csv?year=&month=` accepts a required year and optional month, reads only processed rows in the authenticated organization, aggregates by period and currency, and emits balanced debit/credit lines with stable generic account codes. The export excludes employee names and is audited. Accounting software can map the generic codes to its chart of accounts; no gateway or payment action is part of this endpoint.

### AI tool safety and conversation history

Conversations are owned by the authenticated user and organization. Identity and permissions are loaded server-side. Tool declarations are permission-filtered, and each executor checks permission and record scope again because model tool calls are untrusted input. Identity and project/task context are supplied separately from static system instructions as serialized session data. Reads use scoped queries. Writes require explicit intent in the latest user turn; the shared intent gate rejects question-form and common negated requests before a proposed action is persisted for caller confirmation. Confirmation is single-use; prior conversation, assistant text or an earlier request does not authorize a new write. Equivalent tool calls are deduplicated within a chat request. Tool/provider failures must be reported rather than represented as success.

`POST /api/v1/ai/chat` accepts `{ message, conversation_id?, context? }`; `context` is limited to 12,000 characters and is stored when a new conversation is created. For an existing conversation, the server-owned stored context is authoritative; a later request cannot silently replace it. Context is a page-data snapshot for resolving what the user means, not proof of current state. The system prompt directs the assistant to verify live state through tools before reporting it or making changes. Personal attendance totals use `getMyAttendanceSummary`, scoped to the authenticated user and organization, with date defaults in the organization timezone and incomplete hours reported as unavailable.

`GET /api/v1/ai/conversations` lists the authenticated user's 50 most recently updated conversations. Each item includes the first user message as its title, an optional safe context label (project/task name only, not the serialized context), update time, and total message count. `GET /api/v1/ai/conversations/:id` verifies ownership and returns the stored context, latest 100 messages, total count, and `has_older_messages`. This matches the 100-message history loaded by the chat agent; older messages remain stored but are not included in the model prompt or the conversation-detail response. Clients should disclose when a restored thread is partial. The web and mobile clients render stored choice metadata and keep previously selected choices disabled when restoring a thread.

Web integration includes the dashboard-wide chat widget, the dedicated `/ai` page, and contextual Ask AI actions on project/task pages. The Flutter app exposes AI from Home and contextual actions from attendance, leave, approvals, shift planning, project, and task screens when the caller has `analytics.ai_chat`. Project/task launchers pass compact record identifiers and a focused prompt rather than duplicating full page data; mobile sends context on the first request so it is stored with that new thread. The active context is shown in chat and clearing it starts a separate thread rather than continuing with stale context. History is kept separate per user and organization on web, and per user and organization in Flutter preferences.

When adding an AI entry point, gate its UI with `analytics.ai_chat`, use a focused prompt, and pass only the minimum page snapshot needed to identify the relevant records. Keep record lookup, date math, authorization, and mutations in server-side tools; never treat client context as authorization or current truth. Add a scoped tool and unit tests for any new computed answer instead of asking the model to calculate it from unbounded raw rows. Keep chat history, context ownership, detail ordering, and the model's history limit consistent across API and clients.

High-value contextual entry points still worth considering are payroll/payslips (employee-safe pay-period explanation), employee profiles (permission-scoped summaries), and shift/availability detail pages (coverage or personal schedule questions). The current global chat can already answer supported questions from those modules; add a page-specific launcher only when it can supply a precise focus and its server-side tools enforce the same visibility as the page.

## Background processing and notifications

`src/server.ts` calls `startAllJobs()` after the API server starts. Each job holds a renewable Redis lease for its full execution; when Redis is unavailable the tick is skipped. A `SchedulerJobState` row records the last start, last successful completion, and latest error for every job. `SchedulerJobMarker` claims durable `(organization, job, subject, local period)` deliveries; retries reuse the same marker ID. The notification transaction uses that ID for unique in-app records and channel deliveries, so a process crash after enqueue does not create duplicates. Shift reminders recover missed ticks until shift start, project deadline reminders catch up any time after local 08:00, and remote nudges retry the crossed local target briefly while preserving per-session sent timestamps. Markers older than 90 days are purged. `OrganizationJobSchedule` stores indexed per-organization `next_run_at` values for project deadline reminders, daily remote nudges, daily leave-accrual reconciliation, and payroll auto-generation. These jobs query only due rows; a startup reconciliation and 15-minute maintenance tick add new organizations and refresh timezone or payroll-day changes. Missed runs remain due and are retried instead of requiring an exact cron minute. Heartbeat expiry now queries only records at least the minimum 10-minute policy age; auto-checkout and break automation bound candidate attendance dates to the UTC day around the current instant. Attendance records have matching candidate indexes, and break automation uses the existing organization/date index. Late/absent detectors select only required employee fields and fetch HR escalation recipients once per organization; they still evaluate active employees for org-wide/default shifts. Other session scans need further indexed or due-candidate work. Leave grants are idempotent per `(org, employee, leave type, employee-local year, employee-local month)`; each grant and corresponding balance/ledger change share a transaction. An organization-period row is retained for scheduler history, but is not the grant idempotency gate. Payroll auto-generation is idempotent per employee and period: it creates only missing employee-period rows and preserves any existing manual draft or finalized record.

| Job | Cadence | Purpose |
| --- | --- | --- |
| Late arrival detector | Every minute | Evaluate published shifts in each org timezone, create/update late state and alert |
| Absent detector | Hourly | Mark eligible scheduled employees absent |
| Heartbeat expiry monitor | Every 5 minutes | Evaluate presence/network state and configured grace behavior |
| Stale record sweep | Daily at 06:00 | Repair/close stale attendance state safely |
| Shift reminder | Every minute | Send due shift reminders |
| Project task deadline | Every minute | Notify on approaching/overdue task deadlines without repeating the same alert |
| Remote nudge | Every minute | Send nudges near each assigned shift's start, midpoint and end in org-local time |
| Payroll auto-generate | Every minute; org-local payroll day at 08:00 | Generate or resume the prior period's payroll drafts |
| Shift auto-checkout | Every minute | Check configured shift auto-checkout deadlines and finalize using shared attendance logic |
| Break auto manager | Every minute | Start/end scheduled break policies where configured |
| Trial expiry monitor | Daily at 06:00 | Update expired trials/subscription state |
| Daily remote nudge | Every minute; org-local 08:00 | Send one daily remote-work prompt per approved session and local date |
| Late pattern scan | Daily at 02:30 | Find repeated lateness patterns and notify managers |
| Document expiry scan | Daily at 03:00 | Notify about expiring employee documents |
| Announcement publisher | Every 5 minutes | Publish due scheduled announcements |
| Leave accrual | Every minute; org-local 02:00 onward until run | Accrue balances once per organization-local month using organization leave policies; retry missed first-day runs |
| Refresh-token purge | Daily at 03:30 | Delete expired tokens and old revoked tokens |
| Webhook delivery retry | Every minute | Recover stale delivery claims and send due queued/retrying deliveries; bounded to 100 per tick |

Organization-local jobs use minute ticks plus explicit timezone checks, so organizations in different timezones run at their own local scheduled time. The runtime requires Redis for the distributed scheduler lock; when Redis is unavailable, a job tick is skipped rather than risk duplicate side effects. Heartbeat expiry checkout and explicit IP/network-change handling are separate paths. The former is enabled only by organization configuration and uses the configured grace period; the latter handles reported network changes. See the Wi-Fi settings and heartbeat monitor code for current policy details.

Late-arrival and absent detectors evaluate branch-local dates and weekdays. Each detector loads published shifts once per organization, then queries assignments for the branch/date and active users only when an active organization-wide/default shift applies. The `(date, user_id)` assignment index and `(org_id, primary_location_id, is_active, deleted_at)` user index support those candidate queries. Users with pending offline attendance sync remain excluded until reconciliation. This reduces broad employee scans when shifts are individually assigned; org-wide/default shifts still require loading the covered branch roster. Other frequent scheduler scans and due-organization selection remain under optimization.

`createNotification` writes persistent `InAppNotification` records and catches/logs notification failures so they do not roll back a successful primary action. `emitOrgEvent` immediately sends local invalidations and publishes events to the Redis channel `attenda:org-events:v1`. In addition, PostgreSQL triggers insert outbox rows in the same transaction as supported attendance, leave, overtime, remote, swap, expense, project/task, shift/assignment and timesheet mutations. The leased worker publishes SSE invalidations and creates webhook deliveries idempotently from these rows. Outbox failures use bounded exponential backoff and move to a dead-letter state after eight attempts; users with `org.events.replay` can inspect and replay organization-scoped events under audit. Webhook delivery has its own retry log and replay controls. Mutations without a database trigger still depend on their explicit `emitOrgEvent` call and are not covered by the durable outbox.

## Database and migrations

`prisma/schema.prisma` is the canonical model. Model domains include organizations/plans/users/departments/RBAC, refresh tokens, attendance/breaks/remote/corrections, leave/balances/append-only ledger/holidays, shifts/assignments/swaps/availability/coverage/checkpoints/emergency offers, payroll/overtime/expenses, projects/tasks/dependencies/comments/attachments, notifications/announcements, onboarding/documents/kudos, audit/webhooks and AI conversations/messages.

Schema changes must ship with reviewed additive migrations under `prisma/migrations/`. Regenerate Prisma after schema edits. Apply migrations before deploying code that queries new tables or columns. Checkpoint and emergency-offer tables are introduced in `20261030190000_shift_checkpoints_emergency_offers`.

`20261031190000_reliability_hardening` adds the unique leave accrual run ledger, the remote daily-nudge date marker, and the `org.audit.view` permission. The migration grants the new audit permission to existing organization roles that already had `org.settings.update`, preserving their prior audit access. `20261031200000_webhook_delivery_queue` adds the persistent signed webhook delivery queue and retry indexes. `20261031210000_per_device_sessions` backfills existing refresh-token families into user sessions and links future refresh tokens to their session.
`20261031220000_offline_checkin_idempotency` stores original client check-in time, server receipt time, replay key and offline reconciliation marker on attendance records.
`20261031230000_attendance_geofence` adds organization location policy and check-in location evidence fields.
`20261103120000_geofence_review_reasons` records why location evidence was sent to the manager review queue. `Location.geofence` is a branch override JSON policy: `{ enabled, shape: 'circle'|'polygon', latitude, longitude, radius_m, vertices: [{ latitude, longitude }], enforcement: 'warn'|'block', require_location, block_mock_location, max_accuracy_m }`. Enabled circles require a valid center and 25–5000 m radius; enabled polygons require 3–100 valid coordinate pairs. The web Settings → Locations editor validates input, and `POST/PUT /api/v1/locations` validates it again server-side. A null geofence inherits the legacy organization circle; an explicit disabled branch policy disables geofencing for that branch.
`20261031240000_offline_checkin_trust` stores payload hashes, trusted-time anchor metadata, offline source and review decisions, with an index for the review queue.
`20261102170000_offline_attendance_actions` adds replay keys and payload hashes for check-out and break start/end.
`20261031250000_transactional_outbox` creates durable outbox rows and database triggers for core attendance, leave, overtime, remote-work, swap, expense, project/task, shift and assignment mutations. `20261103150000_time_tracking_outbox` extends transaction-coupled triggers to time entries and timesheets and captures project budget changes. `20261109150000_outbox_related_entities` adds attendance corrections/breaks, project membership/comments/dependencies/attachments, and shift breaks/checkpoints/scans/emergency offers/availability/coverage rules. `20261109160000_outbox_parent_tenant_resolution` prioritizes project, shift, assignment, checkpoint, and attendance parents when resolving child-row tenant ownership, before falling back to user ownership. The worker claims rows with `FOR UPDATE SKIP LOCKED`, publishes SSE invalidations and creates webhook deliveries with a unique `(outbox_event_id, webhook_id)` key. Publication retries are durable; webhook delivery has its own retry lifecycle. Keep the webhook event catalogue and worker allowlist aligned with `OrgEventType`; do not create a second application outbox row for writes already captured by triggers. Payloads currently contain entity identifiers and event metadata, not a full before/after audit diff.
`20261102090000_general_idempotency` adds a 24-hour idempotency response store keyed by organisation, user and request key; wired to leave/expense submission, payroll generation/processing, shift assignments/bulk assignment and open-shift claims.
`20261102110000_payroll_draft_input_hash` records a stable hash for external payroll inputs. Migrations `20261110120000_attendance_payroll_input_integrity` and `20261110130000_lock_processed_payroll_periods` mark draft payroll stale for attendance writes from API routes, jobs, or imports and lock source changes against finalization. Attendance edits reconcile both the prior and new user/date period; an attendance correction affecting processed payroll is rejected until payroll is recalled. Finalization uses a conditional draft-and-fresh update so concurrent attendance changes cannot silently finalize a stale snapshot. Processing is blocked until a manager regenerates; manual adjustments are preserved.
`20261102120000_signed_cursor_indexes` adds composite indexes for the signed keyset ordering used by audit, attendance and notification feeds.
`20261102130000_leave_cursor_index` adds the organization/date keyset index for leave request feeds.
`20261102180000_employee_expense_cursors` adds org-scoped `(created_at DESC, id DESC)` indexes for employee and expense cursor feeds.
`20261102150000_leave_balance_ledger` backfills opening leave balances and adds an append-only ledger trigger. Balance reads and leave eligibility checks sum ledger deltas; accrual, usage, manual adjustment and reversal metadata are captured in the same transaction as the projection update.
`20261108110000_whatsapp_usage_metering` adds organization WhatsApp quota/rate settings and local-month usage counters. `20261108120000_whatsapp_limit_opt_in_default` makes hard limits opt-in and clears the initial default for existing organizations so delivery is not stopped without administrator configuration. `20261105120000_whatsapp_provider_reconciliation` adds provider message IDs, callback status timestamps, and pricing metadata for Meta status reconciliation. `20261105140000_employee_local_leave_accrual` adds unique employee-period accrual grants and lets the leave ledger trigger accept the employee-local effective date.
`20261107170000_scheduler_watermarks_and_markers` records scheduled job watermarks and durable retry markers and adds an idempotency key to in-app notifications so retried scheduled deliveries do not duplicate records or channel sends. `20261107180000_org_job_schedules` adds indexed per-organization due times for daily and monthly timezone-aware jobs.
`20261109130000_scheduler_attendance_candidates` adds branch/active-user and date/assignment indexes used by late-arrival and absent candidate selection.
`20261109140000_api_key_idempotency_redaction` redacts previously persisted plaintext API credentials from idempotency response bodies. API-key create/rotate now encrypts those response bodies with AES-256-GCM while retaining idempotent response replay.

Platform organization onboarding/review, platform-user and platform-role management, blog writes, and global broadcasts use the shared 24-hour idempotency store. The sensitive organization-approval response (which contains a setup invite token) is encrypted like API-key credentials. Plan and subscription administration remains outside this non-payment idempotency rollout.

```bash
npm run db:generate
npx prisma migrate deploy
npx prisma migrate status
```

`npm run db:migrate` is for local migration authoring. `npm run db:push` is development-only schema synchronization and must not replace migrations in shared environments. Do not edit an already-deployed migration to fix drift; add a corrective migration.

## Configuration and development

Copy `.env.example` to `.env`. Core settings include the database URL, JWT secrets, Redis and `FRONTEND_URL`. AI uses `AI_PRIMARY_PROVIDER=gemini` by default, `GEMINI_API_KEY`, and optional `GEMINI_MODEL`. An OpenAI-compatible fallback can be enabled by setting `AI_OPENAI_API_KEY`, `AI_OPENAI_BASE_URL`, and `AI_OPENAI_MODEL`; keys are server-only. Providers use a short circuit breaker and are attempted in configured order. Other optional integrations may require SMTP/Brevo, WhatsApp, Firebase push and S3-compatible object storage. Keep credentials out of source, docs and client apps. `FRONTEND_URL` accepts comma-separated browser origins.

```bash
npm install
npm run db:generate
npx prisma migrate deploy
npm run db:seed
npm run db:seed:demo
npm run dev
npm run build
```

Default API port is 5000 unless configured otherwise. `/health` confirms the process responds; `/ready` checks database and Redis readiness. Generated OpenAPI is served at `/api/v1/openapi.json`.

## Reliability roadmap status

| Item | Status | Notes |
| --- | --- | --- |
| Scheduler Redis safety | Partial | Redis job leases are held for the full execution, renewed, and released by token; Redis failure skips execution. Per-job watermarks, durable reminder markers, deduped notification outbox writes and delayed-tick recovery cover shift reminders, project deadlines and remote nudges. Per-organization due queues now cover project deadline reminders, daily remote nudges, leave accrual, and payroll auto-generation. Late/absent detectors now query branch/date assignments first, loading the branch roster only for active global/default shifts. Timezone-grouped selection for every frequent job, candidate-driven session scans and multi-instance validation still remain. |
| Organization-local scheduled payroll, nudges and leave accrual | Implemented | Indexed `OrganizationJobSchedule` rows carry each organization's timezone/config and due time. Due rows are retried after missed ticks, and successful jobs advance to the next local date or period. |
| Idempotent leave accrual and resumable payroll generation | Implemented | Leave uses a unique org-period transaction ledger; payroll creates missing employee-period rows and leaves existing records untouched. |
| Stale payroll draft detection | Implemented | Payroll drafts store a hash of attendance, unpaid leave, pay rate, overtime multipliers and organization rates. Database triggers mark affected drafts stale, the UI offers regeneration, and processing rejects stale drafts. Regeneration preserves manual adjustments. |
| General mutation idempotency | Partial | Optional `Idempotency-Key` middleware accepts matching header/body keys, rejects conflicting values and changed inputs, and replays completed JSON/204 responses. Coverage includes leave/balance, expenses/approvals, employee lifecycle/profile/import/invite, notification state, device enrollment/review, location/department/role administration, AI policy/shift-plan proposals, compliance, attendance, shifts, onboarding, document metadata, kudos, payroll adjustments, offboarding, API/webhook, holidays, project/task/attachment metadata and local uploads, time tracking/reports, API credential create/rotate, organization onboarding, platform-user/role management, blog writes, broadcasts, public auth/token flows, password recovery and authenticated session actions. Web/mobile clients persist auth operation keys and use hashed pre-auth actor IDs; token-bearing replay responses are encrypted with AES-256-GCM. Focused API/web and Dio tests cover replay, collisions, restart/concurrency, 5xx retry reuse, definite 4xx replacement and unknown-outcome retention. Server-error uncertainty returns `409 IDEMPOTENCY_OUTCOME_UNKNOWN`; 4xx releases the claim; keys are scoped to organization/actor for 24 hours. Sensitive replay bodies use a production-required stable key. Presigned upload URLs are deliberately not replay-cached because they expire. A full route-by-route audit remains; plan/subscription mutations are excluded with payment/billing. |
| Redis pub/sub for SSE invalidation | Partial | Outbox-backed changes fan across API instances; event IDs, reconnect-wide invalidation and 20-second SSE heartbeats are implemented. Redis replay after a disconnected interval is not retained; reconnect invalidates all client data. |
| Rate-limit keys for shared office networks | Partial | Authenticated global API requests use user ID. Login attempts use normalized email+IP buckets plus a higher per-IP ceiling, progressive delay and atomic failure counters. Monitor office-hour rejection rates and tune ceilings. |
| Database and Redis readiness probe | Implemented | `GET /ready`, separate from liveness `GET /health`. |
| Dedicated audit-history permission | Implemented | `org.audit.view`, with migration backfill for existing settings managers. |
| Transactional outbox replay controls | Implemented | `org.events.replay` grants HR Admin/Super Admin access to the dead-letter queue and audited replay. |
| Per-device refresh-token sessions | Implemented | Refresh tokens rotate per session; password reset/change, administrative credential changes, role downgrade and user deactivation revoke sessions; deactivation removes the push token. 2FA changes revoke other devices. Session creation records device metadata, `/auth/sessions` lists active devices, users can revoke one session, and `last_seen_at` writes are throttled to five minutes. Auth write retries are idempotent; token-bearing replay bodies are encrypted. |
| Complete OpenAPI schemas and generated typed clients | Partial | Request schemas come from `validate()`; `documentResponse()` now emits explicit success schemas and is applied to `/dashboard/summary`. Most response/request routes are still uncovered; no generated web/mobile client or compatibility CI yet. |
| Webhook delivery log, exponential retry, dead-letter and replay | Implemented | Persistent delivery records, bounded exponential retry, dead-letter status, scoped history, audited replay, SSRF protections, disable alerts, and 24-hour dual-secret rotation are available. Settings → Webhooks manages endpoints, one-time secret display/rotation, and delivery replay. `POST /org/outbound-webhooks/:id/rotate-secret` returns the new secret once; deliveries carry signatures for both secrets during grace and old secret material is purged after expiry. |
| Webhook event catalogue and versioning | Implemented | `GET /org/outbound-webhooks/catalogue` publishes supported event names, descriptions, envelope fields, and schema version 1. New deliveries persist and include the schema version; replays retain their original signed payload/version. |
| Cursor pagination for high-volume feeds | Partial | Notifications, organization audit logs, own attendance history, organization leave requests, employees and expense claims use signed, filter-bound keyset cursors over `(created_at/date desc, id desc)`; web/mobile API clients expose cursor methods. Legacy page mode and UUID anchors remain during transition. Remaining page-based feeds include approvals unions and additional reports. |
| AI provider abstraction/fallback | Partial | JSON and tool-call requests use a normalized provider adapter with Gemini primary, an optional OpenAI-compatible fallback, and per-provider circuit breakers. Tool writes retain the same permission and confirmation gates across providers. Per-org token quotas, usage metering, and golden conversation evaluations remain. |

### Value-feature rollout status

| Feature | Status | Scope in place / remaining |
| --- | --- | --- |
| Offline-first attendance | Implemented | Check-in, check-out and break start/end persist signed server-time proof, an idempotency key and local sequence; mobile sends ordered batches and handles each result independently. Server watermarks prevent late/absent detection racing an in-flight sync; uncertain proof creates manager review records, and pending mobile actions remain queued for retry. The home banner shows pending and parked counts. |
| Attendance anti-fraud | Partial | Branch-level circle/polygon evidence is enforced at check-in with configurable warn/block behavior, location requirements, mock-location rejection, and accuracy thresholds. Warn-mode missing/edge/outside/mocked/low-accuracy evidence is persisted with a reason and appears in the permission-gated manager review queue. The legacy organization circle remains the fallback. Android enrolled-device signing exists, but verified platform attestation, impossible-travel/behavioral signals and consent-based photo evidence remain. A flag alone never changes wages. |
| Transactional outbox and durable event delivery | Partial | Database triggers record supported domain mutations; a leased worker publishes Redis invalidations and idempotently enqueues webhook deliveries. Retries use exponential backoff and dead-letter after eight failures. `GET /org/outbox/dead-letters` and `POST /org/outbox/dead-letters/:id/replay` are audited and require `org.events.replay`. Payload schema versioning and operational lag/throughput metrics remain. |
| Labor-law compliance rules | Partial | Organizations can manage effective-dated rule versions for weekly hours, rest, shift length, spread-over and breaks. Schedule validation evaluates all configured rules; publish blocks any configured blocking finding unless a user has `compliance.override` and records a reason. Findings and overrides are persisted. Jurisdiction-specific legal review and broader compliance checks across payroll and attendance are still needed. |
| Labor cost/budget on schedules | Partial | Weekly cost estimates use effective-dated hourly/daily/monthly pay rates on each assignment date, with published/draft split, 48-hour overtime exposure warning, aggregate organization/department/location budget variance and `labor_cost.view/manage` permissions. Jurisdiction rule packs remain. |
| Billing/payment flow | Not implemented | Platform plan administration exists, but customer subscription checkout, invoices and dunning are not integrated. |
| Project/task time tracking | Partial | Project timers, manual entries, timesheet submission/review, attendance checkout timer stop, and project-level hours/budget reporting are available. Billing/export integration and richer utilization reporting remain. |
| Scheduled reports and exports | Partial | Owner-only daily/weekly/monthly schedules, run history, timezone execution, owner permission rechecks and expiring object-storage links are available for attendance/leave/payroll/performance CSVs. An on-demand custom CSV builder supports whitelisted employee, attendance and leave columns/filters, enforces dataset-specific RBAC, and caps synchronous exports at 5,000 rows. Saved custom definitions, async large exports, richer formats and multi-recipient permission scoping remain. |
| Payroll outputs and regional rules | Partial | Effective-dated hourly employee pay rates with an audited history view, payroll record rate snapshots and stale-draft invalidation are in place. Effective-dated org-entered tax/contribution sets with maker-checker activation, projected annual progressive-tax calculations, persisted employer/employee contribution breakdowns, stale-draft marking and payslip disclosure now exist. No jurisdiction values are seeded. Official/certified salary certificates, reviewed legal packs, bank-transfer file generation, multi-currency payroll and connecting statutory rule packs to attendance/compliance remain; payment execution is out of scope. |
| Leave depth | Partial | Opening balances are backfilled into an append-only ledger; balance reads/eligibility checks use ledger sums, and triggers record accrual, leave usage, manual adjustments and reversals atomically. Half-day/comp-off accrual, configurable expiry, and per-location holiday policies remain. |
| Offboarding | Implemented (manual settlement) | HR-only cases, checklist/assets, local-date access/session revocation, reassignment, audited cancellation, and maker-checker manual PKR settlement with lock/waive workflow. It records the approved settlement; it does not calculate statutory amounts or transfer funds. |
| Multi-branch support | Partial | `Location` and `LocationManager` are migrated, every existing organization receives a Main office with copied IP/SSID rules, employees receive a primary location, and new/edited employees plus shift assignments and attendance events retain their location. `/api/v1/locations` provides tenant-scoped list/create/update and manager assignment; creation of extra branches is gated by `multi_location`. Holidays can be global or location-specific. The web Settings → Locations screen manages branches and circle/polygon attendance geofences. Attendance check-in/today status and Wi-Fi auto-check-in gating use the employee's branch policy with organization fallback. Work-date scheduling, scheduler jobs, attendance team reports, cost/report filters, leave accrual, and full location-scoped access rules still need migration. Organization timezone/network fields remain compatibility mirrors for Main office. |
| Integrations | Partial | Email, WhatsApp, webhooks and object storage exist; chat/calendar/accounting/biometric/SAML/public API integrations remain. |
| Notification preferences | Implemented | Structured categories/channels, web/mobile controls, immediate in-app delivery, queued/retried push/email/WhatsApp, explicit timestamped WhatsApp consent, quiet-hour deferral, daily/weekly email digests, and delivery history are implemented. External sending requires configured Firebase, mail provider, and WhatsApp Cloud API credentials. |
| WhatsApp usage controls | Partial | Organization-configured monthly caps, atomic attempt reservations, threshold/cap alerts, usage history, rate-based estimates, provider message status/category reconciliation, and recent receipt UI are implemented. Subscription-plan quota integration remains. |

### Branch locations

`GET /api/v1/locations` requires `org.locations.view` or `org.locations.manage` and returns only the authenticated organization’s locations, manager summaries, employee counts, and assignment counts. `POST /api/v1/locations` and `PUT /api/v1/locations/:id` require `org.locations.manage`; creation of a second or subsequent location also requires the `multi_location` plan feature. Timezones are validated as IANA names, manager IDs must belong to the same active organization, and the Main office cannot be removed or deactivated. A null `geofence` inherits the legacy organization circle; an explicit `{ enabled: false }` branch override turns the fence off at that branch. Enabled branch circles require center coordinates and a 25–5000 m radius; polygons accept 3–100 `{ latitude, longitude }` vertices. Block mode rejects clear out-of-area positions and fixes above `max_accuracy_m`; warn mode accepts the check-in and queues missing, edge, outside, mocked, or low-accuracy evidence for `attendance.review_flags` review. Review decisions are audited, notify the employee, and never adjust pay. Editing the Main office timezone or office IP/SSID settings mirrors those values to the legacy organization fields; legacy organization settings screens also synchronize changes back to Main office. Employee creation defaults to Main office, and employee updates can set `primary_location_id`; shift assignment and emergency-claim paths snapshot that location. `employees.view_location` scopes employee directory and attendance views to locations managed by the viewer, with a reduced directory projection; `employees.view` remains the organization-wide employee profile permission. `GET /api/v1/org/holidays?location_id=...` combines global holidays with the selected location’s holidays; holiday creation accepts optional `location_id`. Existing records are backfilled to Main office. Scheduler attendance detectors, checkout and break jobs, shift reminders, the attendance “today” view, remote nudges, and attendance overview/trend/late-arrival analytics use location-local dates. Schedule display/filtering, leave accrual and broader report/cost filters remain incomplete.

### Scheduled report delivery

`POST /api/v1/reports/:type` creates a supported standard CSV export. `POST /api/v1/reports/custom` accepts `{dataset: employees|attendance|leave, columns: string[], filters: {date_from?, date_to?, department?, status?, employee_id?, is_active?}}`; its column and filter allowlists are compiled to scoped Prisma queries, it requires the dataset's corresponding view/export permission, and it rejects results over 5,000 rows. `GET/POST /api/v1/reports/custom/definitions` and `PUT/DELETE /api/v1/reports/custom/definitions/:id` manage private, owner-scoped saved setups. Definitions are revalidated and permissions rechecked whenever generated. Exports use object storage when configured, otherwise a CSV data URI. `GET/POST /api/v1/reports/schedules`, `PATCH/DELETE /api/v1/reports/schedules/:id`, and `GET /api/v1/reports/runs` manage owner-scoped schedules and run history. Custom schedules store a saved definition ID and use the preceding local day/week/month for date-based datasets; employee datasets are not date-limited. All schedules use the organization timezone, recheck the owner's current report and dataset permissions, pause on lost permissions or a deleted definition, and email generated links only to the schedule owner's account. `ReportRun` records row count and success or failure. Async large exports, more file formats, and recipient permission scoping are not included.

### Offboarding and final settlement

Offboarding is available at `GET/POST /api/v1/offboarding`, `GET/PATCH /api/v1/offboarding/:id`, `POST /api/v1/offboarding/:id/tasks`, `PATCH /api/v1/offboarding/tasks/:taskId`, `POST /api/v1/offboarding/:id/assets`, and `PATCH /api/v1/offboarding/assets/:assetId`; all routes require `offboarding.view_team` or `offboarding.manage` and scope every record to the current organization. Cancellation requires an audit reason. At the last working date in the organization timezone, a scheduled worker deactivates the employee, revokes refresh sessions and push registration, removes future shifts, reassigns direct reports and uncompleted project tasks to the employee's manager when available, and notifies HR. A retry marker prevents a session-revocation failure from being lost after deactivation.

Final settlement uses `PUT /api/v1/offboarding/:id/settlement` to save whole-PKR earning/deduction lines, then `POST .../settlement/submit`, `POST .../settlement/approve`, and `POST .../settlement/lock`. A reviewer must differ from the maker and leave a note. Where no settlement applies, `POST .../settlement/waive` requires a reason. Cases cannot close until access has been revoked, all tasks and assets are resolved, and the settlement is locked or waived. The ledger is a manual record and approval workflow; it does not calculate jurisdictional tax/gratuity or execute payment. Migration `20261107140000_offboarding`, `20261107150000_offboarding_settlement`, and `20261107160000_offboarding_cancellation_reason` add its tables/fields and dynamic RBAC permissions.

### Schedule labor planning

`GET /api/v1/shifts/planning/cost?week_start=YYYY-MM-DD` requires `labor_cost.view` and returns aggregate projected costs split into published and draft assignments, scheduled hours, and estimated weekly overtime exposure. Individual pay rates are never returned. The estimate uses the effective-dated pay rate for each assignment date (falling back to `User.hourly_rate`), converts daily rates to an 8-hour equivalent and monthly rates using the organization's `monthly_pay_divisor`, subtracts unpaid shift breaks, and applies a shift's configured overtime multiplier only when overtime is enabled. The 48-hour threshold is a planning warning baseline, not a legal or payroll calculation; replace it with an approved compliance rule pack before using it to make employment decisions. Budget rows compare only the assignment spend matching their scope: organization, department, location, or location+department. Scoped managers receive only location budgets represented by their visible assignments; organization-wide budget and cost totals require an unscoped `labor_cost.view` grant.

`PUT /api/v1/shifts/planning/budget` requires `labor_cost.manage` and upserts the selected Monday's budget for an organization, department, location, or location+department scope. `location_id` must refer to an active location in the same organization; currency must match the organization currency. The schedule page surfaces weekly projected, published and draft cost, overtime exposure and per-scope budget variance. The user rate remains confidential; managers see aggregate figures only. Migrations `20261102160000_labor_budgets` and `20261108230000_labor_budget_locations` create weekly budgets and add location scoping; dynamic permissions grant view access to built-in manager roles and manage access to HR Admin/Super Admin.

`GET /api/v1/payroll/rates/:userId` and `PUT /api/v1/payroll/rates/:userId` require `payroll.manage`. A rate has a positive amount, basis `hourly|daily|monthly`, organization currency, and an effective date on the first day of a payroll month. Inserting a new date closes the preceding interval, preserves later intervals, and same-day edits update that rate. Draft payroll periods intersecting the changed interval are marked stale. `monthly_pay_divisor` is configurable under organization settings (20–31 working days; default 26) and changing it marks draft payroll stale. Payroll snapshots basis, amount, divisor, and hourly equivalent; hourly rates are paid by hours, daily rates by attended 8-hour equivalents, monthly rates as the monthly base, unpaid leave uses the applicable daily equivalent, and overtime uses the hourly equivalent with each attendance shift's multiplier. Schedule planning converts all three bases for aggregate projection only. Migration `20261109090000_pay_rate_bases` adds the org setting and payroll snapshot fields.

### Configurable labor compliance

`GET /api/v1/compliance/rules?effective_on=YYYY-MM-DD` requires `compliance.view` or `compliance.manage`; omitting the date returns the rules active today. `PUT /api/v1/compliance/rules` requires `compliance.manage`, accepts an `effective_from` date (today or later), and creates effective-dated versions. Same-day draft edits replace that day's version, with before/after audit snapshots; earlier effective periods are retained. Rule codes currently supported are `max_weekly_hours` (`hours`), `min_rest_hours` (`hours`), `max_shift_hours` (`hours`), `max_spread_over_hours` (`hours`), and `mandatory_break` (`after_hours`, `break_minutes`). Each rule has `info`, `warn`, or `block` severity and an optional source reference. Values are organization-configurable and are not legal advice or a claim that one jurisdiction's rules apply everywhere.

`GET /api/v1/shifts/planning/issues?week_start=YYYY-MM-DD` uses active effective-dated rules to evaluate weekly hours, shift duration, rest between shifts (including overnight and week-boundary assignments), spread-over and planned breaks, alongside leave, availability, coverage and assignment conflicts. A `block` finding prevents publish. A permitted override must include `override_reason` with at least eight characters; both blocked attempts and successful overrides are persisted with the actor and timestamp. `GET /api/v1/compliance/violations?week_start=YYYY-MM-DD` returns findings with employee and reviewer names. Rule changes and pack identifiers are also written to organization audit history. Migration `20261104100000_compliance_rule_packs` adds the rules, findings and organization pack key. Shift break applicability uses each template break's configured weekday and exception dates. Rule packs remain configurable policy and require qualified local legal review before operational use; this evaluator does not yet calculate payroll compliance or attendance evidence.

### Project time tracking

Time entries allocate work to projects/tasks for timesheets, utilization, and budget burn. Attendance remains the source of truth for presence and net worked time; project time does not alter attendance or payroll totals. The `time_tracking` plan feature gates access. `time.view` covers personal entries/timesheets, `time.view_team` covers team entries and project reports, and `time.approve` covers review. A reviewer cannot approve their own timesheet. All project/task references are organization-scoped and additionally checked against project membership, task assignment, or `projects.manage`.

`TimeEntry` stores user, optional project/task/attendance references, server start/end timestamps, computed minutes, source (`timer|manual`), billable flag, description, and lifecycle status (`draft`, `submitted`, `approved`, `locked`, `rejected`). A partial unique index allows at most one running timer per employee. `Timesheet` is unique for organization/user/Monday week start and stores submit/reviewer data. Approval locks the submitted entries; rejection requires a reason and returns entries for correction/resubmission.

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/time/timer` | `time.view` | Current user's running timer |
| POST | `/time/timer/start` | `time.view` | Start a server-timed entry; optional project/task/description |
| POST | `/time/timer/stop` | `time.view` | Stop timer and calculate minutes on the server |
| GET | `/time/entries` | `time.view` | Own entries; team scope requires `time.view_team`; supports date/project/status filters |
| POST | `/time/entries` | `time.view` | Add a completed manual entry |
| PUT | `/time/entries/:id` | `time.view` | Edit own completed draft entry |
| GET | `/time/timesheets/me?week_start=YYYY-MM-DD` | `time.view` | Weekly entries and timesheet status |
| POST | `/time/timesheets/submit` | `time.view` | Submit a non-empty week with no running timer |
| GET | `/time/timesheets` | `time.approve` | Review queue |
| PUT | `/time/timesheets/:id/review` | `time.approve` | Approve/lock or reject with a reason |
| GET | `/time/reports/project/:id` | `time.view_team` | Project/task/employee totals, utilization warnings, budget and variance |

Submitted timesheets also appear as `type=timesheet` in the shared `/api/v1/approvals` queue. Timer start/stop timestamps are server-generated. Attendance checkout stops a running timer at the same server-resolved instant; failure to stop the timer does not undo checkout. Entries spanning midnight are attributed to their start date for week grouping. Allocation above net attendance is reported as a warning, not blocked. Reports accept `from` and `to` dates for up to 366 days and return at most 5,000 entries; individual pay rates are never exposed. Mutations use idempotency keys and conditional state updates. Migrations `20261103120000_project_time_tracking`, `20261103130000_time_tracking_rbac`, and `20261103150000_time_tracking_outbox` create the models, access rules, and durable event triggers.

### Trusted attendance device enrollment

`/api/v1/attendance/devices/me` lists the authenticated employee's device records. `POST /me/enroll/start` accepts a label and Android P-256 public key, creates a five-minute one-use challenge, and returns the new pending device and challenge. The Android app creates a distinct ECDSA key in Android Keystore, signs the challenge, and calls `POST /me/:id/enroll/confirm`; the API verifies the signature against the stored SPKI key, consumes the challenge conditionally, and records key proof. The private key never leaves Android Keystore. Employees can revoke their own records with `DELETE /me/:id`.

Organization reviewers with `attendance.devices.manage` (seeded to HR Admin and Super Admin) can list `GET /api/v1/attendance/devices?status=pending|approved|revoked`, approve only key-proven pending devices with `PUT /:id/approve`, and revoke devices with `DELETE /:id`. Mutations are organization-scoped and audited. Enrollment is limited to five active/pending records per employee. The web review queue is Settings → Trusted devices. The mobile entry is Settings → Trusted attendance devices.

Enrollment approval does not silently block check-ins. Approved Android clients attach monitor-mode signatures when they have a challenge; missing proof remains allowed for older clients, unsupported platforms, or challenges that could not be prefetched. Mobile key generation currently supports Android 6.0+; other platforms can view/revoke devices but cannot enroll until their secure-key implementation is added.

Approved devices may now provide monitor-mode check-in evidence. The mobile client obtains `POST /api/v1/attendance/devices/me/:id/checkin-challenge` while online, signs the exact check-in JSON payload plus the challenge context in Android Keystore, and submits `device_proof`. Each challenge is stored by hash, expires after 12 hours, and is consumed conditionally once; multiple outstanding challenges are supported so a later refresh does not invalidate an offline event already queued. A device is capped at 20 outstanding challenges. The server parses and canonicalizes the signed JSON before comparing it with the actual request, so field changes cannot be hidden by JSON key ordering. A cached challenge and signed proof are stored with an offline check-in in the mobile outbox and verified during batch sync; if no valid challenge was cached, the app is an older client, or the proof expires, sync still records the attendance and the event remains subject to the existing offline-time review rules. The attendance row records the device ID, proof status, and verification result. Invalid, expired, untrusted, or replayed supplied proof is reviewable and never automatically alters pay. Verified Play Integrity/App Attest, site polygons, impossible-travel and behavioral checks, and consent/retention-managed photo evidence remain outstanding.

## Change checklist

1. Put behavior in its domain route/service and keep that feature's records as source of truth.
2. For schema changes, update Prisma, add an additive migration, regenerate the client and apply migrations before dependent code runs.
3. Validate request input with Zod.
4. Enforce authentication, least privilege, plan features, tenant boundaries and object ownership. Never trust client-supplied identity or `org_id`.
5. Make accounting and state transitions transactional or conditional; stale/repeated actions must not duplicate side effects.
6. Write audit/history where required, persist notifications and emit the relevant invalidation event after success.
7. Update this guide and inspect `/api/v1/openapi.json` for generated route metadata.

| Area | Main files |
| --- | --- |
| Middleware, CORS, mounts, rate limits | `src/app.ts`, `src/middleware/auth.ts` |
| Startup and graceful shutdown | `src/server.ts` |
| Validation and error responses | `src/middleware/validate.ts`, `src/middleware/errorHandler.ts`, `src/utils/response.ts` |
| Permissions and plan features | `src/services/authorization.ts`, `src/constants/rbac.ts` |
| Attendance math and timezone helpers | `src/utils/attendance.ts`, `src/utils/shift.ts` |
| Approval queue/decisions | `src/services/approval-workflows.ts`, `src/routes/approvals.ts` |
| AI tools and conversations | `src/routes/ai.ts`, `src/services/ai/agent.ts` |
| Notifications/events | `src/services/notifications.ts` |
| Scheduled jobs | `src/jobs/scheduler.ts` |
| Schema/migrations | `prisma/schema.prisma`, `prisma/migrations/` |
# AI organization governance

AI chat remains permission-checked per user (`analytics.ai_chat`) and every tool executes using that authenticated user's organization and permissions. Organization administrators with `org.settings.update` can manage `GET/PUT /api/v1/ai/org-policy` (`enabled`, optional `monthly_request_limit`) and read `GET /api/v1/ai/org-usage`.

Chat requests are reserved atomically in `ai_usage_periods` by organization-local calendar month before provider calls. A configured request cap returns `429 AI_QUOTA_EXCEEDED`; disabled orgs return `403 AI_DISABLED`. Provider-reported prompt/completion/total token usage is accumulated. Usage history exposes the current and last twelve periods. A provider failure still consumes a request reservation, preventing repeated retries from bypassing the cap; token totals only include provider responses that return usage metadata.

Each executed tool call writes `ai_tool_audits` with actor, `on_behalf_of`, conversation, tool name, outcome, timestamp, and SHA-256 hash of canonicalized arguments. Raw arguments and model prompts are not copied to this audit table. Audit insertion failure is logged and does not convert an already executed business action into a user-visible failure. Audit retention/administrative browsing and prompt-injection/golden-conversation evaluations remain follow-up work. AI tool results and organization text must continue to be treated as untrusted input; tools must retain their own authorization checks.


### Recent migration

`20261108160000_statutory_payroll_config` adds organization country, effective-dated statutory tax/contribution parameter sets, and payroll-record references plus persisted deduction/contribution breakdowns. Payroll parameters are org-scoped and activated using maker-checker; no legal jurisdiction values are seeded.
`20261108170000_effective_pay_rates` adds effective-dated hourly rate history, backfills explicitly labeled legacy snapshots, links payroll records to the selected rate, and marks overlapping drafts stale when a rate changes.
`20261105120000_payroll_maker_checker` adds nullable `payroll_records.generated_by`. New or regenerated drafts store their generator, and the processing endpoint rejects self-finalization. Records created before this migration retain a null generator and remain processable for backward compatibility. Renewable per-org/period Redis leases serialize generation, adjustment, and finalization; a shared per-org payroll-configuration lease also serializes those operations against effective-rate changes, statutory-set activation, and organization payroll-rate/divisor changes. Lock loss fails closed and leases are released by owner token or TTL. The web payroll page guides admins through prepare, employee-level review, and finalization; it reports stale/incomplete counts and explains the second-person requirement. Crash recovery and replay-safe delivery of external PDF/email/WhatsApp side effects are not yet backed by a payroll-specific transactional outbox.

For each employee, PDF creation happens before finalization; the conditional `draft AND inputs_stale=false` status claim and a `payslip_ready` `notification_requested` outbox row then commit in one database transaction. A notification can no longer be lost between payroll finalization and queue insertion. The outbox retries notification delivery independently; a failed PDF or failed finalization leaves that record unprocessed for an explicit retry. If PDF upload succeeds but the database transition fails, the API attempts to delete that object; cleanup failures are logged with the object key for operator reconciliation.

### Employee shift acknowledgement

When a schedule is published, assigned shifts become acknowledgement-required with a 24-hour response deadline. Employees can read their upcoming assignments from `GET /api/v1/dashboard/summary` (`my_shifts`, when the shift feature is enabled) and submit `POST /api/v1/shifts/assignments/me/:id/acknowledgement` with `status: acknowledged|conflict|help_requested` and an optional note. Conflict/help notes require at least five characters. The endpoint is idempotent, verifies assignment ownership, organization and publication state, and rejects past shifts. A response is saved on the assignment, appended to shift schedule history, and emits `shift_changed`; conflict/help requests notify managers whose dynamic `shifts.manage` or `shifts.assign` permission scope includes the employee. Assignment edits on a published schedule reset the response and deadline and notify the employee. The web dashboard shows scoped overdue confirmations and conflict/help responses with a link to schedule management; mobile schedule cards provide employee actions. Migration `20261110100000_shift_acknowledgement` adds the persisted state and deadline. Full publish/response end-to-end tests remain open.
