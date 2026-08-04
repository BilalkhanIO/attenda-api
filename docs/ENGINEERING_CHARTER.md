# Attenda — Engineering Charter & Architecture Decisions

This charter defines how the three Attenda repositories are built and what
"done" means. It maps enterprise requirements onto the system we actually
run, and records every deliberate divergence as a decision, not an accident.

## The system

| Repo | Stack | Role |
|---|---|---|
| attenda-api | Node 20 · Express 5 · TypeScript · Prisma 7 · PostgreSQL · Redis · Bull/cron | Multi-tenant REST API (~110 endpoints), SSE realtime, background jobs |
| Attenda-web | Next.js 16 App Router · React 19 · TypeScript · Tailwind 4 · TanStack Query · RHF+Zod | Org dashboard + platform (SaaS) console |
| Attenda-mobile | Flutter (Android-first) · provider · go_router · dio · hive_ce · flutter_foreground_task | Employee app with WiFi auto-presence |

## Architecture decisions (ADR summary)

**ADR-1 · Express 5, not NestJS.** The API is a mature, tested Express 5
codebase (72+ tests, layered routes/middleware/services/jobs/utils). NestJS
would add DI/decorator ceremony without fixing any live problem; a rewrite
risks the entire product for zero user value. The Nest-style disciplines are
adopted instead: zod-validated DTOs at the boundary, permission guards per
route, service layer for cross-cutting logic, structured logging with request
correlation, envelope responses.

**ADR-2 · Custom token design system, not shadcn/ui.** The web app has a
complete in-house component library on CSS design tokens (`--glass-*`,
`--primary-*`, `--on-glass-*`) with one visual language across org and
platform consoles. shadcn would introduce a second design language.
Accessibility gaps are fixed in-place (dialog semantics, aria labels,
focus management) rather than by replacement.

**ADR-3 · TanStack Query owns server state; no Zustand.** Client state that
isn't server state is small (auth context, UI toggles) and lives in React
context/local state. Adding a store library before there is store-shaped
state violates KISS.

**ADR-4 · provider → Riverpod is staged, not big-bang.** Per
`Attenda-mobile/docs/MOBILE_RESEARCH.md` §1: typed models + repositories +
sealed failures first (done: `ApiFailure`), widget decomposition second
(done), Riverpod for new feature state third, auth migration last (router
`refreshListenable` risk). Freezed is adopted only where copyWith/equality
earns its codegen cost.

**ADR-5 · SSE over Socket.io.** All realtime needs are server→client
(notification counts, cache-invalidation hints). SSE runs over plain HTTP,
reconnects with backoff, and needs no sticky sessions. WebSockets are
reconsidered only if bidirectional features (chat, live co-editing) arrive.

**ADR-6 · The legacy `users.role` column is a denormalized mirror.**
Authorization flows exclusively through dynamic RBAC (org roles ∪ per-user
grants, resolved by `requirePermission`); the column feeds the JWT claim and
platform/tenant segregation. Fallbacks exist so unseeded databases resolve
legacy-equivalent permissions instead of locking users out.

**ADR-7 · Railway + Vercel now; AWS-compatible by construction.** Docker
image with health check, S3 for files, SMTP for mail, env-driven config —
nothing binds to Railway. `docker-compose.yml` reproduces the topology
locally.

## Enterprise requirements — status

| Requirement | Status | Where |
|---|---|---|
| Validation (schema DTOs) | ◐ wave 1 shipped (auth/leave/users), wave 2 in flight | `src/middleware/validate.ts`, `src/schemas/` |
| AuthN/AuthZ on every endpoint | ✅ JWT + blacklist; `requirePermission`/feature gates | `src/middleware/auth.ts` |
| RBAC + role hierarchy + per-user grants | ✅ dynamic, catalog-driven, self-healing seeds | `src/services/authorization.ts`, `constants/rbac.ts` |
| Refresh-token rotation + reuse detection | ✅ family revocation on replay | `src/services/refreshTokens.ts` |
| Rate limiting | ✅ Redis-backed global + auth buckets | `src/app.ts` |
| Structured logging + request IDs | ✅ pino + AsyncLocalStorage correlation | `src/utils/logger.ts` |
| Audit logs (pay-affecting) | ✅ append-only + viewer UI | `src/services/audit.ts`, web Settings |
| Multi-instance safety | ✅ Redis tick-locks on all 11 jobs; Redis rate limits | `src/jobs/scheduler.ts` |
| Pagination/filter/search | ✅ users list server-side; others as needed | `GET /users` |
| Caching | ✅ Redis (server), TanStack Query (web) | — |
| Soft delete | ✅ users (`deleted_at`); other entities archive via status fields | schema |
| created/updated audit columns | ◐ created_at everywhere; updated_at + audit trail on mutable money paths | schema |
| Optimistic locking | ▢ not needed yet — single-writer flows; audit trail covers disputes | — |
| Push notifications | ◐ FCM server half shipped (presence challenge); mobile half blocked on Firebase creds | `src/services/pushChallenge.ts` |
| Email service | ✅ SMTP (invites, resets, payslips, lockouts) | `src/services/email.ts` |
| S3 storage | ✅ payslips/exports via presigned URLs | `src/services/s3.ts` |
| Swagger/OpenAPI | ▢ planned: generate from zod schemas once wave 2 lands | ROADMAP #16 |
| API versioning | ✅ `/api/v1` prefix | `src/app.ts` |
| CI/CD | ✅ GitHub Actions in all 3 repos; Railway/Vercel auto-deploy | `.github/workflows` |
| Docker + compose + health checks | ✅ multi-stage Dockerfile, non-root, healthcheck; compose stack | `Dockerfile`, `docker-compose.yml` |
| Web: dark mode | ✅ (dark-first design); light theme = backlog | tokens |
| Web: skeletons/empty/error states, optimistic updates | ✅ | pages |
| Web: command palette, bulk actions | ▢ backlog (ROADMAP #33) | — |
| Web: CSP + security headers | ◐ report-only in flight | `src/proxy.ts` |
| Mobile: offline queue, secure storage, token refresh | ✅ hive_ce + flutter_secure_storage + rotating refresh | services |
| Mobile: biometric login, deep links, localization | ▢ backlog | MOBILE_RESEARCH §roadmap |
| Backups | ▢ operational task: enable Railway Postgres PITR / scheduled `pg_dump` to S3 | DEPLOYMENT.md |
| Monitoring/error tracking | ▢ Sentry + prom-client planned | ROADMAP #17 |

Legend: ✅ shipped · ◐ partial/in-flight · ▢ planned (tracked in `docs/ROADMAP.md`)

## Working agreements

1. **The API route source is the contract.** Clients never invent paths;
   response envelope is `{ success, data }` (+ `pagination`), errors are
   `{ success:false, error, code, details? }`.
2. **Every mutation that affects pay writes an audit entry.**
3. **Migrations are append-only SQL** registered in `scripts/migrate.js`;
   deploys are self-healing (migrate → seed-repair → boot).
4. **No feature ships without its permission key** in the catalog and gates
   on both API and UI.
5. **CI must be green before merge** — tsc+jest (api), eslint+vitest+build
   (web), analyze+test (mobile).
6. **Docs live with the code**: research in `docs/*_RESEARCH.md`, the plan in
   `docs/ROADMAP.md`, behavior guides like `PRESENCE_TRACKING.md` updated in
   the same PR as the behavior.
