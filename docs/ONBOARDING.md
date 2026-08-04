# Developer Onboarding

Read in order: `ENGINEERING_CHARTER.md` (how we build) → this file (how to
run) → `ROADMAP.md` (what's next). Deep dives: `PRESENCE_TRACKING.md`,
`API_RESEARCH.md`, `ATTENDANCE_RESEARCH.md`, and per-repo research docs.

## Run the stack locally

```bash
# API + Postgres + Redis (self-migrating, self-seeding)
cd attenda-api && cp .env.example .env && docker compose up --build
# or natively: npm i && npm run db:push && npm run db:seed && npm run dev

# Web
cd Attenda-web && cp .env.example .env.local && npm i && npm run dev
# BACKEND_API_URL=http://localhost:5000/api/v1 (rewrite proxy)

# Mobile (Android)
cd Attenda-mobile && flutter pub get
flutter run --dart-define=API_URL=http://10.0.2.2:5000/api/v1
```

Demo logins (after seed): `admin@demo.attenda.app` (org super admin),
`hr@` / `manager@` / `alice@demo.attenda.app`, and
`platform@attenda.app` (SaaS console) — all `Demo1234!`.

## Repo maps

**attenda-api/src** — `app.ts` (middleware chain: helmet→cors→json→request-id
→pino→redis rate limits→routers) · `routes/` (one file per domain; handlers
stay thin) · `middleware/` (auth = JWT+blacklist, requirePermission = dynamic
RBAC + `req.permissions`, validate = zod) · `schemas/` (zod DTOs) ·
`services/` (authorization, refreshTokens, audit, pushChallenge, email,
whatsapp, s3, pdf, csvExport, notifications+events) · `jobs/scheduler.ts`
(11 cron jobs behind Redis tick-locks) · `utils/` (logger, prisma, response
envelope+errors, rbac-seed, seed) · `constants/rbac.ts` (permission catalog —
**every new feature adds its key here first**).

**Attenda-web/src** — `app/` (routes; org pages under DashboardLayout,
platform console under `admin/` + AdminLayout — one visual language, tokens
in globals.css) · `lib/` (api.ts axios client: single-flight refresh +
rotation; queries.ts TanStack key factory — **all invalidation goes through
these keys**; auth.tsx context: user + capabilities + hasPermission/Feature) ·
`components/ui/index.tsx` (design system) · `proxy.ts` (Next 16 middleware:
optimistic route guards; NOT authorization).

**Attenda-mobile/lib** — `services/` (api_service singleton, api_failure
sealed errors — **never string-match exceptions**, auth_provider,
wifi_service + foreground_service: the presence engine — change with care,
read PRESENCE_TRACKING.md first) · `screens/` (feature folders; home
sections in `screens/home/widgets/`) · `router.dart` (guards + 2FA flow) ·
`utils/theme.dart` + `widgets/common.dart` (design system).

## Conventions that bite if missed

1. Response envelope `{ success, data }` — clients read `res.data.data`.
2. New endpoint = catalog permission key + `requirePermission` + UI
   `hasPermission` gate + (if pay-affecting) `recordAudit`.
3. Schema change = SQL file in `prisma/migrations/<stamp>_<name>/` +
   register in `scripts/migrate.js` + `npx prisma generate`.
4. Web data fetching = TanStack Query via `lib/queries.ts` only.
5. Mobile errors = `ApiFailure.fromError(e)`; UI copy from `userMessage`.
6. Commit as configured (`user.email noreply@anthropic.com` for agent
   sessions); CI green before merge in all three repos.

## Testing

- API: `npm test` (jest; unit + integration; 72+). Redis/DB not required for
  unit suites (mocked).
- Web: `npm test` (vitest) + `npm run build` (type gate) + `npx eslint src`.
- Mobile: `flutter analyze && flutter test` (CI runs both; container agents
  have no SDK — inspect + rely on CI).
