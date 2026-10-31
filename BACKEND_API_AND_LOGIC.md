# Attenda Backend API and Logic

Implementation-oriented documentation for the Express API. It reflects the routes mounted in `src/app.ts` and the current Prisma model. Route handlers and Zod schemas are authoritative if older client documentation differs.

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
| AI | Gemini-backed assistant with server-side, permission-checked tools and stored conversations |
| Observability | Pino request logs, correlation IDs, metrics, health endpoint, domain audit/event history |
| Integrations | In-app notifications/SSE, optional email, push, WhatsApp, webhooks, object storage |

Base URL prefix: `/api/v1`. Process health: `GET /health`; dependency readiness: `GET /ready` (database and Redis). Prometheus metrics: `GET /metrics`. Generated OpenAPI JSON: `GET /api/v1/openapi.json`.

The Express stack in `src/app.ts` applies Helmet, CORS allowlisting (`FRONTEND_URL`, comma-separated), body/cookie parsing, request correlation, structured logging, a global Redis rate limit (100/minute), and an additional auth limit (20/15 minutes). The global limiter keys valid bearer-token requests by authenticated user ID, avoiding a shared office/NAT address throttling an entire workforce; invalid or unauthenticated traffic falls back to the normalized source IP. Webhook JSON raw bytes are preserved for signature validation. Routers mount in a deliberate order: corrections before general attendance, shift planning and field operations before general shifts, and outbound webhooks before generic organization routes. Route order prevents parameterized paths from swallowing specific endpoints.

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
| POST | `/login` | Public, rate limited | Authenticate; may return a pending 2FA challenge |
| POST | `/logout` | Authenticated | End the current device session; legacy access tokens without session IDs fall back to revoking all sessions |
| GET | `/sessions` | Authenticated | List the caller's active device sessions, with current-session indicator |
| DELETE | `/sessions/:sessionId` | Authenticated + ownership | Revoke one of the caller's sessions, including its access and refresh tokens |
| POST | `/refresh` | Refresh token | Rotate refresh token and issue new access token |
| POST | `/forgot-password` | Public | Start password recovery |
| POST | `/reset-password` | Public reset token | Set a password from recovery flow |
| POST | `/setup-account` | Public invitation token | Finish invited employee setup |
| PUT | `/change-password` | Authenticated | Change own password |
| POST | `/2fa/authenticate` | Temporary challenge | Verify login second factor |
| POST | `/2fa/setup` | Authenticated | Start TOTP enrollment |
| POST | `/2fa/verify` | Authenticated | Verify and enable TOTP |
| DELETE | `/2fa` | Authenticated + verification | Disable TOTP |
| GET | `/sso/google` | Public | Begin Google OAuth |
| GET | `/sso/google/callback` | Public provider callback | Validate OAuth callback and create exchange |
| POST | `/sso/exchange` | Public short-lived exchange | Exchange SSO result for application tokens |

Refresh tokens are stored in families, and each family maps to a durable `UserSession` with device label, user-agent, IP, creation/last-seen/expiry, and revocation metadata. New access tokens carry the session ID (`sid`); authentication checks a Redis revocation marker so revoking one device invalidates its remaining access tokens immediately. Each refresh invalidates the prior token and issues a successor in the same session. Rotation uses a conditional consume update to prevent two concurrent refresh requests from both succeeding. Reuse of a rotated token revokes the whole session. Tokens issued before database tracking can be adopted once into a new session. Expired/revoked session records are purged after a 30-day retention window; the Settings → Active sessions screen lists and revokes a user's own active devices.

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
| GET | `/remote/monitor` | `remote.approve` | Active remote session monitoring |
| GET | `/remote/sessions/:id/logs` | Authenticated + owner/reviewer scope | Remote activity logs |
| PUT | `/remote/sessions/:id/approve`, `/reject` | `remote.approve` | Decide remote request |
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

### Leave, overtime, expenses and shared approvals

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
| GET | `/balance/:userId` | `leave.view_team` or `leave.balance.manage` | Read employee balance |
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
| GET | `/` | `expenses.view` or `expenses.manage` | List/review claims |
| PUT | `/:id/approve`, `/reject` | `expenses.manage` | Decide claim |
| POST | `/:id/reimburse` | `expenses.manage` | Mark reimbursement |

`/approvals` combines source request records without copying their domain data:

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | Authenticated; types filtered by permission and scope | Unified pending queue: leave, overtime, remote, swap, late notice, expense, correction |
| POST | `/review` | Authenticated; source-type permission and reviewer scope | Approve/reject one request or acknowledge late notice |

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
| GET | `/assignments` | `shifts.view` | Assignments filtered by week, department, employee, publish state, search |
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
| POST | `/:id/members` | `projects.manage` | Add/remove project member |
| POST | `/:id/tasks` | `projects.tasks.manage` | Create task/milestone |
| PUT | `/tasks/:taskId` | Authorized project/task scope | Update task, assignment, status, dates, priority or dependencies |
| POST | `/tasks/:taskId/comments` | Authorized task participant/editor | Add comment and mentions |
| POST | `/:id/attachments/upload-url` | Authorized project scope | Request object-storage upload URL |
| POST | `/:id/attachments/upload-local` | Authorized project scope | Upload via local storage fallback |
| POST | `/:id/attachments` | Authorized project scope | Register attachment metadata |
| GET | `/attachments/:attachmentId/download`, `/file` | Authorized project scope | Download/stream attachment |
| GET | `/:id/activity` | Project-visible user | Project/task activity |
| GET | `/:id/calendar.ics` | Project-visible user | Project date export |

### Payroll — `/payroll`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | `payroll.view` | List payroll records |
| POST | `/generate` | `payroll.manage` | Generate period draft |
| GET | `/me` | Authenticated | Own payroll records |
| GET | `/:id` | `payroll.view` | Read payroll record |
| PUT | `/:id/adjust` | `payroll.manage` | Adjust payroll record |
| POST | `/:id/recall` | `payroll.process` | Recall eligible processed data |
| POST | `/process-full` | `payroll.process` | Process period payroll |
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

`/notifications`: `GET /stream` (authenticated SSE), `GET /`, `GET /count`, `PUT /read-all`, `PUT /:id/read`, `DELETE /:id`. Users can only access their own notification records. `GET /` keeps page-number pagination by default. Set `cursor_mode=true` for cursor pagination; response contains `items`, `next_cursor`, `has_more` and `unread_count`. Pass `next_cursor` as `cursor` for the next page. Cursor anchors are validated against the signed-in user's scope.

Cursor pagination is also available on `GET /org/audit-logs` and `GET /attendance/me` using `cursor_mode=true`, optional `limit`, and `cursor` on subsequent requests. Their cursor-mode responses contain `items`, `next_cursor`, `has_more` and `limit`. Audit cursors are constrained to the caller's organization and active filters; attendance cursors are constrained to the caller's own history/date window. Existing response formats remain unchanged when cursor mode is omitted.

### AI conversations — `/ai`

| Method | Path | Permission/access | Purpose |
| --- | --- | --- | --- |
| GET | `/conversations` | `analytics.ai_chat` | List up to 50 caller-owned conversations with first-message title, context label, update time and message count |
| GET | `/conversations/:id` | `analytics.ai_chat` + owner/org validation | Read the latest 100 messages, stored context, total count, and whether older messages were omitted |
| POST | `/chat` | `analytics.ai_chat` + AI configuration | Accept a message and optional new-thread context; reply, invoke authorized tools, persist history |

AI tools are defined/filtered in `src/routes/ai.ts` and executed in `src/services/ai/agent.ts`. User identity and effective permissions are loaded server-side. Read tools query only records in the caller's scope. AI writes require explicit intent in the latest user turn and are presented as pending actions; no write tool executes until the caller confirms. Confirmation claims the pending action once, and the executor still checks permissions and record scope. Prior chat history or an assistant statement never authorizes a new write. Provider credentials, quota and timeout affect availability; AI responses must not invent records when a tool fails.

### Integrations, public and platform APIs

`/org/outbound-webhooks`: `GET/POST /`, `DELETE /:id`, `POST /:id/test`, `GET /:id/deliveries`, and `POST /:id/deliveries/:deliveryId/replay` (all require `org.settings.update`). Secrets are generated on create and returned only in that response. Event deliveries are persisted before sending, signed with HMAC-SHA256, retried with exponential backoff up to eight attempts, then moved to `dead_letter`. The delivery log includes outcome, attempt count, HTTP status and last error. Administrators can replay only dead-letter deliveries; replay and failure history is retained independently of webhook removal. Webhooks auto-disable after 20 consecutive failures. `POST /webhooks/whatsapp` receives provider callbacks; `GET /webhooks/whatsapp` handles provider verification.

`/public` (public): `POST /onboard`, `GET /plans`, `GET /blog`, `GET /blog/:slug`.

`/admin` uses platform permissions, independent of org roles:

- Organizations: `GET /stats`, `GET /orgs`, `GET /orgs/pending`, `GET /orgs/:id`, `GET /orgs/:id/users`, `POST /orgs`, `PATCH /orgs/:id`, `PATCH /orgs/:id/plan`, `PATCH /orgs/:id/suspend`, `PATCH /orgs/:id/subscription`, `POST /orgs/:id/extend-trial`, `POST /orgs/:id/activate`, `POST /orgs/:id/approve`, `POST /orgs/:id/reject`.
- Plans: `GET/POST /plans`, `PUT/DELETE /plans/:id`.
- Public blog management: `GET/POST /blog`, `GET/PUT/DELETE /blog/:id`, `PATCH /blog/:id/publish`.
- Operations: `POST /broadcast`, `GET /audit-logs`.

`/admin/users` and `/admin/roles` provide platform user and platform-role management under `platform.users.manage` and `platform.roles.manage` permissions. `/reports` exposes `POST /:type` for supported report generation using scoped input.

**OpenAPI limitation:** `src/services/openapi.ts` uses generic success/error response schemas. It cannot infer response shapes/statuses from imperative route handlers, or request schemas for bodies validated manually. Custom response routes (downloads, SSE, ICS, 204 deletes) and manually validated payloads need explicit documentation or route metadata before the generated spec can be treated as a complete external contract.

## Core business logic

### Attendance, timezone and breaks

The organization's IANA timezone defines local work dates and shift wall-clock times. Persisted event timestamps are instants. Overnight shift ends resolve to the following local date. `/attendance/today-status` is the canonical current-state response for clients; client-side timers are presentation only.

Effective shift resolution uses the dated employee assignment first, then applicable published organization-wide/default fallback. Attendance is unique per employee/date. `POST /checkin` accepts `idempotency_key`, `client_event_at` and `offline`; offline clients must send all three consistently. Requests received within 12 hours use the event timestamp for the attendance instant and organization-local attendance date, while the server separately stores when it received the event. Device timestamps more than two minutes in the future or beyond the reconciliation window are parked for human review, not silently applied. Repeating a key for the same employee returns the existing record; unique employee/date constraints also protect concurrent duplicate requests. The mobile client persists manual check-ins with their original event time and key, retries on connectivity recovery, and parks out-of-window events for correction instead of replaying them into the wrong day. When location policy is enabled, the same endpoint stores location accuracy, mock-location signal, geofence decision and distance with the record. Approved leave is checked against the reconciled date; partial/timed leave follows its own interval rules. Remote check-in does not use the office geofence; shift checkpoint location behavior remains separate.

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

Payroll generation uses attendance totals, approved overtime and employee/organization pay settings. Missing compensation inputs are surfaced as incomplete records for review. Payroll adjustment and processing require dedicated permissions; employees can only read their own payslips unless granted broader scope. Analytics and report handlers must constrain source rows to the caller's organization and visibility. These calculations do not file taxes or submit payroll to an external provider.

### AI tool safety and conversation history

Conversations are owned by the authenticated user and organization. Identity and permissions are loaded server-side. Tool declarations are permission-filtered, and each executor checks permission and record scope again because model tool calls are untrusted input. Reads use scoped queries. Writes require explicit intent in the latest user turn and are persisted as pending actions for caller confirmation before execution. Confirmation is single-use; prior conversation, assistant text or an earlier request does not authorize a new write. Equivalent tool calls are deduplicated within a chat request. Tool/provider failures must be reported rather than represented as success.

`POST /api/v1/ai/chat` accepts `{ message, conversation_id?, context? }`; `context` is limited to 12,000 characters and is stored when a new conversation is created. For an existing conversation, the server-owned stored context is authoritative; a later request cannot silently replace it. Context is a page-data snapshot for resolving what the user means, not proof of current state. The system prompt directs the assistant to verify live state through tools before reporting it or making changes. Personal attendance totals use `getMyAttendanceSummary`, scoped to the authenticated user and organization, with date defaults in the organization timezone and incomplete hours reported as unavailable.

`GET /api/v1/ai/conversations` lists the authenticated user's 50 most recently updated conversations. Each item includes the first user message as its title, an optional safe context label (project/task name only, not the serialized context), update time, and total message count. `GET /api/v1/ai/conversations/:id` verifies ownership and returns the stored context, latest 100 messages, total count, and `has_older_messages`. This matches the 100-message history loaded by the chat agent; older messages remain stored but are not included in the model prompt or the conversation-detail response. Clients should disclose when a restored thread is partial. The web and mobile clients render stored choice metadata and keep previously selected choices disabled when restoring a thread.

Web integration includes the dashboard-wide chat widget, the dedicated `/ai` page, and contextual Ask AI actions on project/task pages. The Flutter app exposes AI from Home and contextual actions from attendance, leave, approvals, shift planning, project, and task screens when the caller has `analytics.ai_chat`. Project/task launchers pass compact record identifiers and a focused prompt rather than duplicating full page data; mobile sends context on the first request so it is stored with that new thread. The active context is shown in chat and clearing it starts a separate thread rather than continuing with stale context. History is kept separate per user and organization on web, and per user and organization in Flutter preferences.

When adding an AI entry point, gate its UI with `analytics.ai_chat`, use a focused prompt, and pass only the minimum page snapshot needed to identify the relevant records. Keep record lookup, date math, authorization, and mutations in server-side tools; never treat client context as authorization or current truth. Add a scoped tool and unit tests for any new computed answer instead of asking the model to calculate it from unbounded raw rows. Keep chat history, context ownership, detail ordering, and the model's history limit consistent across API and clients.

High-value contextual entry points still worth considering are payroll/payslips (employee-safe pay-period explanation), employee profiles (permission-scoped summaries), and shift/availability detail pages (coverage or personal schedule questions). The current global chat can already answer supported questions from those modules; add a page-specific launcher only when it can supply a precise focus and its server-side tools enforce the same visibility as the page.

## Background processing and notifications

`src/server.ts` calls `startAllJobs()` after the API server starts. A Redis minute-bucket lock prevents duplicate job ticks across instances. If Redis cannot acquire a lock, that tick is skipped; jobs do not run unlocked. Cron callbacks tick on the process scheduler, while business deadlines and scheduled times are checked in each organization's configured timezone. Monthly leave accrual additionally records a unique `(org_id, year, month)` run in the same transaction as balance updates. It retries during the local 02:00 hour on later days if that month's run was missed. Payroll auto-generation is idempotent per employee and period: it retries from the configured local payroll day at 08:00, creates only missing employee-period rows, preserves any existing manual draft or finalized record, and clamps payroll day to the month's last calendar day.

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

`createNotification` writes persistent `InAppNotification` records and catches/logs notification failures so they do not roll back a successful primary action. `emitOrgEvent` immediately sends local invalidations and publishes attendance, leave, overtime, remote, swaps, expenses, projects and shifts events to the Redis channel `attenda:org-events:v1`. Each API instance subscribes and forwards matching organization events to its local SSE clients; clients refetch authoritative data. The subscriber reconnects with Redis and logs a temporary fan-out outage. Outbound webhook fan-out remains local to the originating event to avoid duplicate deliveries across API instances; each matching webhook event is persisted in `org_webhook_deliveries` before delivery and processed by the retry worker. The event bus itself is still best-effort between a domain mutation and database enqueue if a process exits before the local fan-out callback runs.

## Database and migrations

`prisma/schema.prisma` is the canonical model. Model domains include organizations/plans/users/departments/RBAC, refresh tokens, attendance/breaks/remote/corrections, leave/balances/holidays, shifts/assignments/swaps/availability/coverage/checkpoints/emergency offers, payroll/overtime/expenses, projects/tasks/dependencies/comments/attachments, notifications/announcements, onboarding/documents/kudos, audit/webhooks and AI conversations/messages.

Schema changes must ship with reviewed additive migrations under `prisma/migrations/`. Regenerate Prisma after schema edits. Apply migrations before deploying code that queries new tables or columns. Checkpoint and emergency-offer tables are introduced in `20261030190000_shift_checkpoints_emergency_offers`.

`20261031190000_reliability_hardening` adds the unique leave accrual run ledger, the remote daily-nudge date marker, and the `org.audit.view` permission. The migration grants the new audit permission to existing organization roles that already had `org.settings.update`, preserving their prior audit access. `20261031200000_webhook_delivery_queue` adds the persistent signed webhook delivery queue and retry indexes. `20261031210000_per_device_sessions` backfills existing refresh-token families into user sessions and links future refresh tokens to their session.
`20261031220000_offline_checkin_idempotency` stores original client check-in time, server receipt time, replay key and offline reconciliation marker on attendance records.
`20261031230000_attendance_geofence` adds organization location policy and check-in location evidence fields.
`20261031240000_offline_checkin_trust` stores payload hashes, trusted-time anchor metadata, offline source and review decisions, with an index for the review queue.

```bash
npm run db:generate
npx prisma migrate deploy
npx prisma migrate status
```

`npm run db:migrate` is for local migration authoring. `npm run db:push` is development-only schema synchronization and must not replace migrations in shared environments. Do not edit an already-deployed migration to fix drift; add a corrective migration.

## Configuration and development

Copy `.env.example` to `.env`. Core settings include the database URL, JWT secrets, Redis and `FRONTEND_URL`. Optional integrations may require Gemini, SMTP/Brevo, WhatsApp, Firebase push and S3-compatible object storage. Keep credentials out of source, docs and client apps. `FRONTEND_URL` accepts comma-separated browser origins.

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
| Scheduler Redis safety | Partial | Redis job leases are held for the full execution, renewed, and released by token; Redis failure skips execution. Due-since-watermark recovery, reminder markers and timezone-grouped organization scans remain. |
| Organization-local scheduled payroll, nudges and leave accrual | Implemented | Minute scheduler ticks check local wall-clock time and retry during the local due window. |
| Idempotent leave accrual and resumable payroll generation | Implemented | Leave uses a unique org-period transaction ledger; payroll creates missing employee-period rows and leaves existing records untouched. |
| Redis pub/sub for SSE invalidation | Partial | Events fan across API instances; event IDs, reconnect-wide invalidation and 20-second SSE heartbeats are implemented. Transactional outbox and replay remain. |
| Rate-limit keys for shared office networks | Partial | Authenticated global API requests use user ID. Login attempts use normalized email+IP buckets plus a higher per-IP ceiling; progressive delay and atomic failure counters remain. |
| Database and Redis readiness probe | Implemented | `GET /ready`, separate from liveness `GET /health`. |
| Dedicated audit-history permission | Implemented | `org.audit.view`, with migration backfill for existing settings managers. |
| Per-device refresh-token sessions | Partial | Password reset/change and role changes revoke sessions; deactivation also removes the push token; 2FA changes revoke other devices. `last_seen_at` writes are throttled to five minutes. Device enrollment/revocation remains. |
| Complete OpenAPI schemas and generated typed clients | Partial | Middleware metadata exists, but manual route contracts and custom responses still need schemas; no generated web/mobile client yet. |
| Webhook delivery log, exponential retry, dead-letter and replay | Implemented | Persistent delivery records, bounded exponential retry, dead-letter status, scoped history and audited replay are available. Enqueueing still depends on the process-local event callback. |
| Cursor pagination for high-volume feeds | Partial | Opt-in cursor mode is available for notifications, organization audit logs and own attendance history; other list endpoints still need a consistent cursor contract. |
| AI provider abstraction/fallback | Partial | Gemini call paths are still being consolidated; no provider fallback policy yet. |

### Value-feature rollout status

| Feature | Status | Scope in place / remaining |
| --- | --- | --- |
| Offline-first check-in | Partial | Mobile persists an idempotency key, signed server-time anchor, process-monotonic elapsed time and location evidence, then retries on reconnection. Server derives event time from the anchor, flags clock/uptime discontinuity or sync delay over 10 minutes, and rejects reuse of a key with a different payload. Uncertain events use receipt time and require manager review. Pending-sync visibility and checkout/break queueing remain. |
| Attendance anti-fraud | Partial | Geofence evidence and a manager review queue are implemented. Strong attestation, enrolled signing keys, per-site polygons, impossible-travel/behavioral checks and optional photo evidence remain. A flag alone never changes wages. |
| Transactional outbox and durable event delivery | Not implemented | Domain mutations still emit after their database writes, so a crash in that gap can lose invalidations/webhook enqueue. SSE reconnect invalidation, IDs and heartbeats are present; transactional outbox is still required. |
| Labor-law compliance rules | Partial | Shift rest checks exist; weekly-hour caps, required-break rules and publish-time warnings are not yet unified. |
| Labor cost/budget on schedules | Not implemented | Draft schedule cost projection and budget thresholds are not available. |
| Billing/payment flow | Not implemented | Platform plan administration exists, but customer subscription checkout, invoices and dunning are not integrated. |
| Project/task time tracking | Not implemented | Attendance is not yet allocatable to projects/tasks for timesheets or costing. |
| Scheduled reports and exports | Partial | Existing report endpoints/exports vary; scheduled delivery and a custom report builder remain. |
| Payroll outputs and regional rules | Partial | Payroll records/payslips exist; bank-transfer files, multi-currency payroll and country-configurable tax/deduction rules remain. |
| Leave depth | Partial | Accrual and carry-over caps exist; half-day/comp-off and per-location holiday policy need a complete policy model. |
| Offboarding | Not implemented | Onboarding exists; exit checklists, asset return and final settlement remain. |
| Multi-branch support | Partial | Organization timezone and scheduling exist; first-class locations with their own networks, managers and calendars remain. |
| Integrations | Partial | Email, WhatsApp, webhooks and object storage exist; chat/calendar/accounting/biometric/SAML/public API integrations remain. |
| Notification preferences | Partial | In-app and integrations exist; quiet hours, per-channel preferences and digest schedules remain. |

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
