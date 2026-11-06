# Developer onboarding

For the reproducible API + web + mobile local path and the pre-PR check matrix, start with [Local development quickstart](LOCAL_DEVELOPMENT.md). This page is the cross-repository map and change guide; avoid maintaining a second setup procedure here.

Start with the workspace [system feature guide](../../SYSTEM_FEATURE_GUIDE.md), then use the guide for the app you are changing:

- API behavior and permissions: [`BACKEND_API_AND_LOGIC.md`](../BACKEND_API_AND_LOGIC.md)
- Web routes and UI conventions: [`Attenda-web/FRONTEND_ARCHITECTURE.md`](../../Attenda-web/docs/FRONTEND_ARCHITECTURE.md)
- Mobile routes and UI conventions: [`Attenda-mobile/docs/FEATURES_AND_ARCHITECTURE.md`](../../Attenda-mobile/docs/FEATURES_AND_ARCHITECTURE.md)
- Feature status: [`NON_PAYMENT_ROADMAP_CHECKLIST.md`](../../NON_PAYMENT_ROADMAP_CHECKLIST.md)

## Run the applications

Follow the Local development quickstart for the single supported workflow. App READMEs retain only app-specific details. Do not copy production secrets into local examples.

Both local deployment commands and the Docker image use Prisma migration history. A database previously created by the retired raw-SQL runner may need a one-time, staging-verified baseline; follow the [deployment runbook](DEPLOYMENT.md) before upgrading it.

## Code map

- `attenda-api/src/app.ts` mounts middleware and domain routers; `src/routes/` handles HTTP, `src/schemas/` validates inputs, `src/services/` owns shared business workflows, and `src/jobs/scheduler.ts` runs background jobs.
- `Attenda-web/src/app/` defines routes; `src/lib/api.ts` wraps endpoints, `src/lib/queries.ts` defines shared query keys, and `src/components/ui/` contains shared controls.
- `Attenda-mobile/lib/router.dart` defines navigation; `lib/services/api_service.dart` owns HTTP, `lib/screens/` contains feature screens, and `lib/widgets/common.dart` plus `lib/utils/theme.dart` define shared UI.

## Change rules

1. Check the backend route and Zod schema before changing a client request.
2. Enforce tenant scope, dynamic permissions, and plan features on the server; client guards only shape navigation.
3. Keep status transitions, audit, notifications, and concurrency rules in shared backend services.
4. Add an additive Prisma migration for schema changes; apply it locally and document rollout implications.
5. Reuse each client's shared UI primitives, theme tokens, and data layer.
6. Update the backend/frontend guide and roadmap checklist when behavior or completion status changes.
