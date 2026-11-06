# Attenda non-payment roadmap checklist

This tracker consolidates the implemented roadmap across the API, web, and mobile apps. It excludes billing, subscriptions, payment processing, and dunning. `[x]` means implemented and documented, `[~]` means partially implemented, and `[ ]` means remaining. Update this file as work lands; do not restart completed items.

## Developer setup and contracts

- [x] Web quickstart no longer tells developers to copy an absent `.env.example`; it explains the local `/api/v1` rewrite default and optional `BACKEND_API_URL` override.
- [x] Mobile API configuration is shared between the foreground attendance service and API client, defaults to localhost rather than production, and logs only the selected scheme/host in debug mode. README includes Android emulator, iOS simulator, and physical-device examples. Focused test, analyzer and Android debug APK build passed.
- [x] Mobile README now links to the canonical route/architecture guide instead of duplicating a stale partial screen tree.
- [~] Publish a deterministic workspace quickstart using Compose, migrations, explicit local demo seed, API/web/mobile smoke checks, plus a fast-to-slow pre-PR command matrix (`LOCAL_DEVELOPMENT.md`). The guide avoids overwriting an existing `.env` and documents local-only demo credentials. Remaining: run it from a clean clone, assign a maintainer, capture time-to-first-success, and agree a target; elapsed time and owner remain unmeasured/unassigned.

## Reliability and security foundations

- [x] Distributed scheduler leases are held, renewed, token-released, and skipped when Redis coordination is unavailable.
- [x] Persist per-job start/success/error watermarks and durable marker claims; shift, project-deadline, and remote reminders catch up missed ticks and dedupe in-app and channel deliveries across restarts.
- [~] Group scheduler work by due organization timezone/`next_run_at` instead of scanning every organization each tick. Project deadlines, daily remote nudges, leave accrual, and payroll use durable local schedules. Late/absent detectors fetch published shifts once per organization, query date-specific assignments by branch, and load all active employees only when an active org-wide/default shift requires them; location/active-user and assignment/date indexes support candidate selection. HR escalation recipients are fetched once per org. Heartbeat expiry filters for the minimum possible 10-minute staleness; auto-checkout and break automation use bounded attendance-date windows and supporting indexes. Remaining: timezone-grouped due-org selection for every frequent job, candidate-driven session scans, and production-like multi-instance validation.
- [x] Local-time checks for payroll, nudges, and leave accrual.
- [~] General idempotency now also covers employee imports/invites, notification read/delete actions, AI policy and shift-plan proposals, project attachment metadata, local project file uploads hashed by content, API-key create/rotate encrypted replay responses, organization onboarding, platform users/roles, blog writes, broadcasts, login/refresh/setup-account/2FA/SSO auth flows, password recovery, and session actions. Auth actors are hashed and token-bearing response bodies are encrypted; web and mobile clients persist operation keys across ambiguous retries. Migrations redact legacy plaintext API credentials. API/web tests cover response replay, changed-payload rejection, canonical ordering, sensitive response encryption, hashed pre-auth actors and retry-key reuse. Mobile secure persistence covers restart/concurrency, payload separation, canonicalization, success cleanup, expiry and opted-in auth writes; Dio transport tests cover 5xx retry, definite 4xx replacement, unknown-outcome retention and multipart fingerprint reuse. Signed upload URLs remain intentionally uncached because their URLs expire; a complete audit of every externally exposed mutation is still in progress.
- [~] Add a CI-backed multi-organization negative-access matrix for direct-ID reads/writes across attendance, payroll, projects/files, approvals, notifications, reports/exports, AI tools, API keys, nested relations, and async jobs. Project task updates now scope linked performance-goal reads, task aggregation, and writes to the authenticated organization, with regression coverage for cross-organization IDs. The remaining endpoint matrix and equivalent web/mobile denial checks are open; assess Postgres RLS separately after verifying transaction-context propagation.
- [~] Audit remaining externally retryable mutations and run client/server contract tests for auth retries. Signed upload-URL responses are intentionally not replay-cached because their URLs expire. Plan/subscription administration is excluded with payment/billing work.
- [x] User-aware API limits and normalized email/IP login throttling with progressive delay.
- [x] `/health` liveness and `/ready` database/Redis readiness probes.
- [x] Per-device refresh-token sessions, single-session revocation, security-change revocation, and throttled last-seen writes.
- [x] Device/session enrollment and revocation management: employees can enroll/revoke trusted devices; Android proves P-256 key possession using Android Keystore; authorized HR/Admin reviewers can approve/revoke in web Settings; enrollment is audited and documented. Signed check-in enforcement/attestation remains in the separate anti-fraud item.
- [x] Dedicated audit-view permission and organization-scoped event dead-letter replay.
- [x] Transactional outbox for supported domain writes, retry backoff, dead-letter state, and audited replay.
- [~] Outbox events persist a schema version; `/metrics` exposes pending depth, oldest pending age, dead-letter depth, and success/failure counters. PostgreSQL triggers transactionally cover core and related attendance, leave, overtime, remote sessions, swaps, expenses, projects/tasks/comments/dependencies/files/members, shifts/assignments/breaks/checkpoints/offers/availability/coverage, timesheets, and project time entries. The remaining work is payload evolution/version upgrade tooling and production-like multi-instance verification.
- [x] Webhook delivery history, retry, dead letters, SSRF protection, replay, and web settings UI.
- [x] Add webhook dual-secret rotation with a 24-hour overlap and expiry cleanup.
- [x] Publish a webhook event catalogue with explicit envelope schema versions and persist the version on each delivery.
- [x] Signed cursor pagination for notifications, audit, own attendance, leave (all/team/personal), employees, and expenses, with matching web/mobile client methods and load-more controls on leave queues.
- [~] Approval union now has permission-bound signed keyset pagination and a web load-more control; migrate remaining large feeds and sunset their legacy page modes.
- [~] OpenAPI route metadata and generated docs.
- [~] OpenAPI now supports explicit success response Zod schemas via `documentResponse()`; `/dashboard/summary` is the first documented response and a unit test covers generation. Most routes still have generic response data or manual request validation; typed web/mobile client generation and breaking-change CI remain.

## Attendance, scheduling, and compliance

- [x] Offline check-in, checkout, and break actions are queued with clock proof, sequence, idempotency, and review parking.
- [x] Add batch `/attendance/sync` with per-event results, expiring pending-sync watermarks, late/absent detector protection, and manager review through attendance evidence records.
- [x] Branch-aware geofence evidence and manager review: check-ins evaluate a location-specific circle or polygon with configurable warn/block, required-location, mock-location, and accuracy rules; warn-mode non-inside evidence is labeled in the attendance review queue. The legacy organization circle remains the fallback when no branch override is configured. Review flags never change wages.
- [x] Remote-work rejection requires a clear reason, persists reviewer/time/note, notifies the employee with that reason, and applies the decision only while the request remains pending; web and mobile review flows collect the reason.
- [x] Shared approvals and remote-work list, monitor, and log endpoints include employees in locations managed by reviewers with `employees.view_location`; remote approve/reject actions use the shared audited approval workflow.
- [x] Bound heartbeat-expiry and shift auto-checkout candidate scans by heartbeat age and attendance work date, and add supporting indexes.
- [~] Add verified platform attestation, enrolled-device signatures, impossible-travel/behavior signals, and consent-based photo evidence (Android signs online and queued offline check-ins when a challenge was cached; verified platform attestation, travel/behavior signals, and consent/retention photo evidence remain).
- [x] Effective-dated configurable schedule rules for max weekly hours, shift duration, spread-over, rest, and breaks; publish block/override with audit history.
- [ ] Apply approved compliance rule packs to attendance/payroll calculations and add jurisdiction-reviewed rule packs.
- [~] Weekly schedule labor cost, budget variance, and overtime exposure estimates with aggregate-only manager visibility.
- [x] Add historical effective-dated hourly, daily, and monthly pay rates and organization/department/location cost budgets. HR can set effective rates, payroll records their basis, daily/monthly calculations use the configured monthly divisor, rate/divisor changes stale affected drafts, and schedule estimates compare scoped weekly budgets without exposing individual rates.
- [~] Build first-class branch locations and migrate attendance networks, timezones, calendars, managers, shifts, and report scoping to locations. `Location`/`LocationManager`, Main office migration/backfill, dynamic-role manager backfill, per-location holiday records, Settings → Locations management, employee primary-location API, and Main office compatibility synchronization are in place. `employees.view_location` scopes employee directory and attendance detail/today views to managed branches. Check-in/heartbeat/IP attendance and shift assignment/claim routes use or persist employee location. Leave requests and accrual periods use employee location. Web and mobile team-schedule assignment filters now include location and preserve server-side employee visibility; schedule date-entry, branch-specific accrual policies, and broader reporting/cost filters remain.
- [~] Audit and migrate local work-date calculations from organization timezone to assignment location timezone. Personal check-in, checkout, Wi-Fi heartbeat/IP events, scheduled attendance detectors, stale/auto checkout, shift break automation, reminders, per-session remote nudges and remote monitoring, the attendance “today” team view, leave request validation/holiday calculations, attendance overview/trend/late-arrival analytics, and monthly accrual periods now resolve dates by record or employee location. Non-attendance report periods and assignment date entry/display still need migration.

## People operations

- [x] Append-only leave ledger and ledger-backed balances, accruals, usage, adjustments, and reversals.
- [~] Half-day and timed leave requests, capped January carry-over, and location holiday calendars are implemented; request dates and approved attendance records now use a snapshotted employee location. Arbitrary hourly-unit policies, comp-off accrual/expiry, configurable carry-over expiry, and eligibility rules remain.
- [x] Attendance writes now stale matching draft payroll rows through a database trigger; processed payroll periods reject attendance changes until recall, and finalization conditionally claims only fresh draft rows. The trigger locks affected payroll rows and reconciles both old and new user/date periods. Manual adjustments remain preserved during regeneration. Migrations `20261110120000_attendance_payroll_input_integrity` and `20261110130000_lock_processed_payroll_periods` must be deployed with the API release.
- [~] Add versioned regional tax/deduction parameters, statutory output reports, salary certificates, and bank-transfer exports. Effective-dated tax/contribution inputs, maker-checker activation, projected annual tax calculation, persisted employee/employer contributions, stale-draft marking, and payslip breakdowns are implemented. Annual processed-payroll summaries and CSV contribution breakdowns are implemented; official/certified salary certificates, reviewed jurisdiction packs, bank-transfer files (payment execution excluded), statutory payroll integration with compliance packs, and professional review remain.
- [x] Offboarding cases, HR-only notes, exit checklist, asset return tracking, audited cancellation, scheduled local-date access/session revocation, future-shift removal, manager/task reassignment, and closure gates.
- [x] Final settlement workflow: manual whole-PKR line items, earnings/deductions, independent maker-checker approval, immutable lock, or reasoned waiver before case closure. Statutory amount calculation remains in the separate payroll/statutory item; this workflow does not initiate payment.
- [x] Onboarding, documents, and employee notifications.

## Projects, reports, and integrations

- [x] Complete project collaboration across API/web/mobile: custom task statuses, task search and filters, task details, subtasks/milestones, members, files, comments, dependencies, calendar export, activity, and project time. Task assignment is restricted to project members; member removal is blocked while open tasks remain assigned; selected member mentions notify through the transactional outbox. Web provides board/list/calendar/timeline views; mobile has project and task search/filter controls.
- [x] Project/task timers, manual time entries, timesheet submission/review, and checkout timer stop.
- [x] Project task dependency updates reject cycles and serialize graph edits per project; dependency changes are included in task audit history.
- [x] Time entries resolve and attach the matching employee-local attendance work date; checkout links the timer it closes. A nullable attendance foreign key and index are applied locally.
- [x] Project hours and all-time budget-burn reporting, with a bounded date-range report by task, day, and employee.
- [x] Add allocation-vs-attendance utilization and warning summaries to project reporting and the project detail UI.
- [x] Owner-only daily/weekly/monthly scheduled CSV exports for attendance, leave, payroll, and performance, with run history, timezone handling, permission rechecks, and owner-only email delivery.
- [~] Safe custom report builder now has owner-private saved definitions and daily/weekly/monthly custom schedules that recheck dataset permissions and pause on permission loss or missing definitions. Async large exports, more formats, and recipient permission scoping remain.
- [x] Add scoped/rotatable public API keys, API-access plan gating, live permission/scope enforcement, and a versioned read-only API for employees, attendance, leave, and projects; webhook event catalogue/versioning is complete.
- [x] Add signed, revocable per-user ICS feeds for each employee's published shifts; optional two-way Google/Outlook sync remains separate.
- [ ] Add Slack/Teams approval actions executed as the linked user.
- [ ] Add biometric device CSV/push ingestion with employee mapping and event deduplication.
- [ ] Add SAML SSO with per-organization identity-provider setup and optional enforcement.
- [x] Add balanced, multi-currency payroll journal CSV exports for finalized periods, with generic account codes, an out-of-balance guard, organization scoping, export audit, and web download; no payment execution is involved.

## Notifications and AI governance

- [x] Structured notification categories and channel preference controls on web/mobile.
- [x] Structured notification categories/channels, durable retry queue, push/email/WhatsApp delivery, quiet-hour deferral, daily/weekly email digests, delivery logs, and timestamped WhatsApp opt-in are implemented.
- [~] WhatsApp usage now reconciles Meta message IDs and signed status callbacks (`sent`/`delivered`/`read`/`failed`), timestamps, pricing category/model, and billable flag; stale, duplicate, regressive, and unknown callbacks are ignored. The web settings page shows recent receipts. Configurable monthly attempt caps, alerts, and rate-based cost estimates remain separate from provider billing; plan-level quota integration remains.
- [~] Normalized Gemini provider with optional OpenAI-compatible fallback and circuit breakers.
- [~] Add organization AI enable/disable and monthly request quotas, atomic org-local request metering, provider token usage history, privacy-preserving tool-call audit attribution, and web settings UI. Server identity/project context is now serialized outside static system instructions, and the shared write-intent gate rejects question-form and common negated requests before proposals. Focused regression tests cover hostile identity/context, missing users, write questions/negations, and explicit field intent. Full provider-level prompt-injection/tool-behavior evaluation, golden conversation suite, plan quota integration, and audit-history UI remain.

## Verification and release follow-through

- [ ] Add critical-flow integration coverage for offline attendance, report execution, leave approval, shift publish, and offboarding.
- [ ] Add production-like multi-instance validation for scheduler locks, outbox delivery, and Redis reconnect behavior.
- [ ] Review migrations, API docs, web/mobile permissions, and user-facing error states whenever a checklist item is completed.

## Current pass

- [x] Replace flat notification preferences with a migrated structured model; enforce categories and channel choices, with settings and delivery history in web/mobile.
- [x] Add durable push/email/WhatsApp delivery, explicit WhatsApp consent, retries, quiet hours, and email digests.
- [x] Add timezone-aware scheduled report schedules and run history; apply the local database migration.
- [x] Add offboarding schema/RBAC/API, scheduled access revocation and reassignment automation, and HR web management UI; apply the migration.
- [x] Add offboarding settlement recording, dual-person approval, lock/waive paths, and case-close prerequisites; apply migrations and document endpoints.
- [x] Add scheduler watermarks and durable dedupe/retry markers; route scheduled shift/task/remote reminders through the deduplicated notification queue.
- [x] Make monthly leave accrual use each employee’s location-local year/month, unique per-employee/type period grants, atomic balance/ledger writes, and local effective dates; reconcile daily to handle branch timezone boundaries.
- [x] Add location filtering to web shift assignments and preserve manager visibility when intersecting employee/department filters; verify the API query logic and web TypeScript.
- [x] Add dynamic-permission location filtering to the Flutter team schedule, reuse the tenant-scoped assignment API, and document the permission behavior.
- [x] Reconcile Meta WhatsApp delivery statuses and pricing categories to outbound message logs; surface provider receipts in settings and apply the additive migration.
- [x] Add indexed per-organization `next_run_at` schedules for project deadlines, daily remote nudges, leave accrual, and payroll; reconcile new organizations and timezone/payroll-day changes.
- [x] Publish versioned webhook event names/descriptions and include the persisted schema version in signed delivery payloads.
- [x] Add signed cursor pagination across the permission-scoped approvals union and consume it with a responsive load-more control on approval category pages.
- [x] Extend the transactional outbox to attendance corrections and breaks, project members/comments/dependencies/attachments, and shift breaks/checkpoints/scans/emergency offers/availability/coverage rules; resolve child tenants from parent records first. Apply migrations `20261109150000_outbox_related_entities` and `20261109160000_outbox_parent_tenant_resolution`.
- [x] Add scoped, hashed API credentials with one-time display, rotation/revocation, audit trail, per-key rate identity, settings management, and read-only versioned integration endpoints.
- [x] Add a personal ICS shift subscription with hashed secret storage, immediate rotation/revocation, timezone-aware UTC events, and a self-service settings page.
- [x] Expand project reports with period filters, employee/task/day allocation, attendance utilization warnings, and all-time budget burn; enforce project membership access.
- [x] Add ordered mobile batch sync for offline attendance actions, with individual replay-safe outcomes and detector watermarks.
- [x] Add trusted attendance device self-enrollment/revocation, Android Keystore P-256 challenge proof, HR/Admin approval/revocation UI, organization RBAC, audit records, API docs, and apply the migration.
- [x] Add one-use, P-256 signature evidence to online and queued offline Android check-ins when a challenge is cached; invalid supplied proof is reviewable and does not block attendance or change pay.
- [x] API/web TypeScript checks, changed mobile-file analysis, API/mobile whitespace checks, and Prisma migration status pass for the current pass.
- [x] Extend canonical, collision-checked idempotency to report generation and report schedule create/update/delete; web report actions send idempotency keys. Ambiguous server outcomes now remain blocked for reconciliation instead of being retried as new writes.
- [x] Encrypt one-time API credential replay responses, redact legacy plaintext tokens, and extend idempotency headers/middleware to non-payment platform organization onboarding, platform-user/role management, blog writes, and broadcasts.
- [x] Add an on-demand custom report builder for employee, attendance, and leave CSVs with strict column/filter allowlists, scoped permission checks, and a synchronous row cap; document the endpoint and limitations.
- [x] Add configurable monthly WhatsApp attempt caps and estimated rates, atomic per-attempt reservations, in-app admin alerts, usage history API/UI, and apply the migration. Provider status categories and plan-level quota integration remain partial.
- [x] Add owner-private custom report definition CRUD, reusable UI load/update/delete, custom scheduled report execution using the previous organization-local period, permission rechecks, run history, owner-only delivery, and apply the migration.
- [x] Verify custom-report backend/web TypeScript, Prisma migration status, and whitespace checks; endpoint/UI runtime access still requires an authenticated report-export user.
- [x] Extend idempotency-key protection and web request headers to shared approval decisions, leave cancellation, overtime request/review, remote-work review, attendance correction request/review, expenses, and check-in review actions.
- [x] Add persisted outbox schema versions and aggregate outbox pending-age/dead-letter/publish counters to Prometheus metrics.
- [x] Extend idempotency to offboarding lifecycle/settlement, webhook administration, API-key management, and holiday writes. Capture successful JSON and empty 204 responses; web actions send keys for the API-key, webhook, and offboarding operations.
- [x] Add effective-dated hourly pay-rate history, organization-local payroll effective dates, draft invalidation, payroll rate snapshots, date-aware cost estimates, and an employee history view; label backfilled historical rates as snapshots rather than reconstructed history. Apply the migration and verify Prisma plus backend/web TypeScript.
- [x] Extend pay-rate history and payroll computation to hourly, daily, and monthly bases; configure the monthly working-day divisor, preserve the rate basis in payroll snapshots and payslips, flag affected drafts stale, and support location-scoped weekly labor budgets. Apply migrations and verify focused payroll math plus API/web types.
- [x] Add organization-managed, effective-dated statutory payroll inputs with maker-checker activation, projected annual tax, employee/employer contribution breakdowns, stale draft invalidation, payslip disclosure, and downloadable annual processed-payroll CSV statements. Values are not legally certified; exports, reviewed rule packs, and statutory-compliance integration remain.
- [x] Add first-class branch locations and migrate attendance scheduler decisions, local attendance views, shift reminders, and per-location holiday lookup. Existing office settings remain mirrored to Main office for compatibility; all-workflow location scoping remains partial.
- [x] Extend shared idempotency protection to employee, device, location, role, compliance, attendance, and shift mutations; add focused replay, collision, and canonicalization tests and document the current coverage.
- [x] Persist web idempotency keys per authenticated request fingerprint in session storage across reloads and uncertain transport errors; clear on success/definitive client rejection, expire within the server retention window, and test key reuse/replacement.
- [x] Add persistent mobile idempotency keys using the authenticated request fingerprint and encrypted storage; coalesce concurrent resolutions, keep existing offline attendance event keys intact, and retain keys only for ambiguous outcomes until success, definitive rejection, or the API retention expiry. Unit tests cover storage recreation, concurrent requests, payload separation, canonical hashing, post-success key renewal, and expiry.
- [x] Extract the mobile Dio idempotency interceptor and test the transport lifecycle: reuse the same key after 5xx/unknown outcomes, replace after a definite 4xx, clear on success, replace body markers, preserve caller keys, and skip intentionally excluded requests; support stable retries for mobile project uploads using file-content hashes.
- [x] Extend API key coverage to employee imports/invites, notification state changes, AI policy/shift-plan proposal generation, project attachment metadata/uploads, and web FormData file fingerprints; update docs and verify API TypeScript plus idempotency middleware tests.
- [ ] Continue remaining unchecked/partial items above. Payment/billing remains intentionally out of scope.

## Part T — Product experience, interface standards, and delivery gaps

This section records the product-surface findings verified against the running web app and current mobile source on 2026-11-03. The web app was opened at `http://localhost:3001` with seeded local data. No Android/iOS device was connected, so mobile findings are source-level only.

- [x] Remove 13 stale/duplicate API, research, audit, and roadmap files; consolidate project-time details into the backend guide and keep one workspace feature map plus the current roadmap checklist.
- [x] Restore a concise deployment runbook with env-var table, migration-path warning, backup/restore commands, and rollback steps; document Android-only mobile capabilities.

### Shared interface standards

- [ ] Define one versioned token source for web and Flutter: semantic surface/text/accent/status colors, spacing, radii, elevation, typography, and motion. Generate/export platform-specific values from that source; do not force identical platform layouts.
- [ ] Keep essential body text at 14 px or larger on web and 14 sp or larger on mobile; secondary/help text at 12 px/sp or larger. Metadata below that size must be nonessential and pass contrast review.
- [~] Semantic neutral and status/accent text tokens pass WCAG AA at 4.5:1 across tested dark, glass, and glow surfaces. Full hard-coded/component-pair review, non-color status cues, and touch-target audit remain.
- [ ] Respect reduced motion, platform safe areas, large text, keyboard insets, and narrow viewports. Share interaction behavior where useful while retaining platform-native navigation patterns.

### Verified current state

- **Verified:** Running web UI is dark, teal glass; Flutter tokens define a light solid-surface interface. The apps use separate token definitions; the web has no light theme.
- **Verified:** Web dashboard, approvals landing, and payroll pages loaded with demo data. Bulk review was subsequently added to web category queues and mobile approval tabs; the payroll page still presents a single “Generate now” empty-period action without a guided run wizard.
- **Verified:** Web sidebar pointer expansion now has keyboard-focus behavior and a persisted pin preference. Semantic text tokens pass the automated contrast combinations noted below, while small section headings and hard-coded/component-specific text colors still need review.
- **Verified:** The web client reads access and refresh tokens through `js-cookie` from JavaScript-readable cookies. Next.js `proxy.ts` uses the access cookie for route redirects and `next.config.ts` rewrites API traffic; this is not an HttpOnly-token BFF. The initial running-site audit found no CSP header; a report-only policy and same-origin sanitized report collector have since been added. API `helmet()` headers do not secure the separate web origin.
- **Verified:** No organization first-run setup wizard or setup-health checklist/card was found. There are feature-specific empty states, but no consistent next-action standard across all modules.
- **Verified:** Mobile has separate Leave, Remote, Expenses, Schedule/Swaps, and other request flows; the “My requests” hub, per-category bulk review, and employee shift acknowledgement have since been added. A permission-scoped manager response queue is also on web; cross-platform end-to-end coverage remains open.
- **Verified:** Mobile targets iOS and Android, but persistent Wi-Fi attendance background work and cryptographic device enrollment are Android-only. The guides now state this platform limitation.

### P0 — security and release correctness

- [~] Deploy report-only CSP in production/staging and collect/review real violations for 1–2 weeks before enforcement. `report-uri` and `report-to` are supported; the same-origin route rewrites to an API collector accepting legacy and Reporting API formats, returning 204 for malformed reports, limiting payloads to 12 KiB and using Redis for 60 reports/IP/minute across API instances. It logs truncated origin/path fields only. Production deployment, explicit correct `CSP_REPORT_ENDPOINT`, trusted proxy IP verification, report review, and nonce-compatible remediation remain. A prior `attenda.app` fallback was removed after it proved to be a different product.
- [ ] Start a production review window (owner and dates recorded at deployment); include login/Google SSO, dashboard charts, QR screens, SSE notifications, avatars, and export downloads. Group reports by directive and blocked origin, discard known extension reports, and investigate repeated first-party or unfamiliar third-party reports.
- [ ] Enforce only after at least seven days including a busy week, zero unexplained first-party violations for three consecutive days, and classification/fixes for all remaining reports. Add an environment rollback switch, gradual internal/tenant rollout, and keep a stricter report-only candidate alongside enforcement. Add `Referrer-Policy`, `Permissions-Policy`, and `X-Content-Type-Options` with enforcement.
- [ ] Move browser auth to an HttpOnly, Secure, SameSite cookie BFF/session design after CSP enforcement: refresh-only HttpOnly cookie and in-memory access token; server refresh handler; CSRF/origin protection; server-side API and SSE proxy; update web/proxy flows and cover login, refresh, logout, multiple tabs, and expiry. Remove JavaScript access to long-lived refresh credentials.
- [~] Reconcile deployment migrations: Docker and manual releases now use `prisma migrate deploy`; the raw-SQL runner that stopped at `20260706000000_hot_path_indexes`, swallowed failures, and seeded users was removed. Fixed the historical completion cast default failure. All 118 migrations passed on a fresh ephemeral PostgreSQL database; the same chain passed from a verified initial-schema baseline, and the configured local DB reports current history. Existing deployed databases created by the raw runner still need a production-like clone and exact baseline boundary verification before rollout.
- [ ] Replace or roll back every 9–10 px essential-label use after the shared type scale and contrast rules are applied; preserve useful information density through layout, not faint microcopy.

### P1 — guided core workflows

- [x] Serialize check-in/check-out/break changes on the attendance record; checkout, break settlement, payroll-hour calculation, and stopping the active project timer commit together. Conflicting repeated actions return a conflict instead of silently overwriting state.
- [x] Apply approved-leave and unavailable-time conflicts at schedule publication, with audited violations and a permission-checked, reasoned override path.
- [x] Apply attendance correction decisions with a pending-state compare-and-set and commit the attendance change, audit record, and notification request atomically.
- [x] Reconcile attendance source changes with payroll drafts and block stale payroll finalization; see migrations `20261110120000_attendance_payroll_input_integrity` and `20261110130000_lock_processed_payroll_periods`.
- [~] Add a first-run organization setup wizard with progress/resume, owner handoff, and an actionable setup-health card. The manager dashboard now shows permission-gated setup checks for office networks, leave accrual policy, and shift templates, with links to their configuration flows; a resumable first-run wizard, owner handoff, and a complete empty-state next-action audit remain.
- [ ] Rework dashboard/Home by audience: employees get current shift, attendance state, primary check-in/out/break action, and a compact next-action list; managers get exceptions and staffing risk first.
- [~] Add shared `GET /dashboard/summary` for personal local-day attendance, permission-scoped team attendance, the five oldest eligible approvals, schedule/coverage issues, and open offers. Web consumes approvals/schedule/open offers; mobile consumes the permission-scoped team snapshot. Personal live attendance and open-offer claim eligibility remain in their source endpoints, and dashboard first-run/role simplification work remains.
- [x] Add a mobile “My requests” hub showing leave, remote, overtime, swap, availability, correction, and expense status with links to each source flow. Sections load independently and use existing self-service APIs; full histories/actions remain in their feature screens.
- [~] Add employee shift acknowledgement (confirm, flag a conflict, or request help) with notifications and history. API state, 24-hour deadline, audit history, manager alerts, web/mobile employee actions, and a permission-scoped manager dashboard queue are implemented; migration `20261110100000_shift_acknowledgement` is applied locally. Full publish/response end-to-end coverage and production migration remain before marking complete.
- [~] Approval sources are ordered oldest-first and show waiting age/urgency. Web category queues and mobile approval tabs now allow selecting up to 20 pending requests of one type, require confirmation and a five-character rejection reason, process each decision through existing permission-checked, idempotent endpoints, and report per-item failures. Risk-based ordering beyond age and manager-home inline bulk actions remain.
- [x] The web approvals navigation includes `time.approve`; employees with the remote-work feature can request remote work and see their own history, while team monitoring remains permission-gated.
- [x] Leave approval uses the employee’s snapshotted location holiday calendar when writing attendance rows, keeping holiday dates out of the leave attendance marks.
- [~] Payroll run flow has guided draft preparation, employee-level review, stale/incomplete readiness counts, explicit finalization, generated-by attribution, maker/checker enforcement, and renewable per-period coordination. A shared per-organization configuration lease serializes runs against effective-rate/statutory/org-rate changes. Payroll status and payslip notification intent commit atomically through the outbox; provider delivery retries independently. Remaining: cleanup/reconciliation for an uploaded PDF whose DB finalization fails, a reviewed statutory-rule-pack chooser with effective date/source/approval metadata, and guarded jurisdiction availability.
- [x] Replace hover-only expansion with a persisted click/toggle preference and keyboard-focus expansion. Keep touch navigation explicit and do not make navigation depend on hover.

### P2 — consistency and operational polish

- [ ] Add a shared light/dark web theme from the semantic token source; test both with system preference and explicit user choice.
- [ ] Audit empty/loading/error/permission states across web and mobile, remove duplicated summary cards, and give each empty state one concise next step.
- [ ] Run keyboard, screen-reader, contrast, zoom, reduced-motion, and small-screen reviews on attendance, approvals, payroll, schedules, projects, and settings.
- [ ] Define a role × platform navigation map for employee, manager, HR, org admin and system admin; place documents, expenses, onboarding/offboarding, shift checkpoints and open-shift offers; specify capability-hidden destinations and access-loss deep-link behavior. Add the employee correction timeline through manager decision to payroll recalculation/unchanged result, including locked-period handling.

### Measurable acceptance targets

- Primary body text ≥14 px/sp; helper text ≥12 px/sp; WCAG AA text contrast; interactive targets ≥44×44 CSS px/dp.
- An employee can reach today's shift and attendance action within 2 navigation actions after sign-in; managers can open the oldest actionable approval within 2 actions.
- First-run setup shows completed/blocked/remaining steps and a next action; no empty state ends without a permitted next step or a clear explanation that the user lacks access.
- Approval decisions and payroll finalization always show pending/success/failure state and do not report success until the server confirms the operation.
- At common 390 px mobile width and 1280 px web width, primary workflows have no clipped controls or page-level horizontal overflow.

## Part U — Dashboard and workflow product plan

This plan was supplied in the follow-up product review. It was not present in the checked-in spec when verified on 2026-11-03, so it is recorded here as planned work rather than shipped functionality.

### Role-focused home surfaces

- [~] Keep each role home to at most five blocks and answer “what needs me right now?” Web manager home has five permission-gated blocks. Employee home leads with one attendance action and shows shift, leave balance/recent leave requests, shift acknowledgements, and unread notification count without duplicate attendance KPI cards; a link opens the cross-feature request hub. HR/owner-specific ordering and announcement surfacing remain.
- [~] Add a permission-aware `GET /dashboard/summary` contract shared by web and mobile; return only the caller's permitted summary fields and avoid duplicating business rules in either client. The web uses it for approvals, schedule issues, open offers, manager shift responses, and employee shift acknowledgements; mobile shows its permission-scoped team snapshot. Feature-specific live attendance state and open-offer claim eligibility remain at their source APIs.
- [ ] Done when each role sees no more than five meaningful blocks, the first block prioritizes current actions, metrics respect scoped permissions, and web/mobile show equivalent information with platform-appropriate layouts.

### Feature completion work

- [ ] Finish branch-location migration and apply one compliance evaluator consistently to schedule validation, attendance, and payroll overtime. Done when the same effective-dated rule produces the same result in all three paths and overrides are audited.
- [ ] Complete and review the Pakistan statutory pack before organizations can adopt it. Done when effective dates, sources, jurisdiction applicability, payroll vectors, and professional review are recorded; unsupported values remain unavailable.
- [ ] Complete leave policy and ledger edge cases, the remaining attendance anti-fraud evidence/review work, and time-tracking correction/approval behavior. Done when each workflow has permission checks, audit history, employee-visible status, and documented edge-case behavior.
- [ ] Generate typed web/mobile clients from the API contract and add CI checks for API compatibility and critical check-in, leave approval, and schedule publication flows. Done when generated clients are current and clean CI fails on contract drift or those flow regressions.

### New workflow candidates

- [~] Quick wins: web “My requests” uses one authenticated cross-source API for leave, remote, overtime, expense, attendance correction, shift swap, availability, and late-notice history, with signed per-source keyset cursors, filters, search, partial-source error reporting, and load-more. Shift acknowledgement and per-category mobile bulk approvals are implemented; guarded per-category bulk approvals and a scoped shift response queue are implemented on web. A team board remains.
- [~] Medium: organization setup-health checks are available on the manager home to authorized administrators, with a resumable setup wizard and owner handoff still open; payroll draft preparation/review/finalization, API-enforced maker/checker, per-period leases, and configuration/finalization serialization are implemented, with crash recovery and statutory pack selection still open.
- [ ] Larger: demand forecasting/shift optimizer, employee qualifications, kiosk mode, and earned wage access (requires legal and provider feasibility review before implementation).

### Sprint 1

- [~] CSP review prerequisites: production report-only header, dual report formats, shared Redis IP limiting, and clean type-check are in place. Still record production review owner/start/end dates, verify the Reporting-Endpoints URL against the deployed origin, and classify at least seven days of representative production reports before enforcement.
- [~] Neutral and semantic status/accent foregrounds use dedicated accessible text tokens; `npm run check:contrast` checks 200 combinations of ten text tokens against base, glass, and radial-glow surfaces (minimum 4.88:1). CI runs the checker. Hard-coded one-off pairs and actual component/surface combinations still need a broader visual audit.
- [x] Make the compact desktop sidebar expand while keyboard focus is inside it, retain pointer hover expansion, and persist the user's pinned expanded/collapsed preference. Mobile navigation remains an explicit drawer.
- [ ] Record a successful backup restore exercise from the documented deployment runbook.

### Dashboard design order

Start detailed visual design with the **manager** home: its action queue, exceptions, and coverage hierarchy exercise the shared dashboard summary and approval affordances. Then validate the employee home around the primary attendance action, followed by HR setup/payroll work. This order is a design recommendation, not an implementation claim.
