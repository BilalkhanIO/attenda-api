# Attenda API

The multi-tenant Express and Prisma API for Attenda. Product features across API, web, and mobile are mapped in the workspace [system feature guide](../SYSTEM_FEATURE_GUIDE.md). This service's routes, permissions, data flows, background work, and migrations are documented in [Backend API and Logic](BACKEND_API_AND_LOGIC.md).

## Run locally

```bash
cp .env.example .env
# Set DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET, FRONTEND_URL
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
```

The API listens on port `5000` by default. Use `GET /health` for process liveness and `GET /ready` for database/Redis readiness. The generated OpenAPI contract is at `/api/v1/openapi.json`. Both local release commands and Docker use Prisma migration history; read the [deployment runbook](docs/DEPLOYMENT.md) for the one-time baseline requirement on legacy databases.

## Documentation

- [Backend API and Logic](BACKEND_API_AND_LOGIC.md) — current API catalog, authorization, workflows, jobs, notifications, and change checklist.
- [Database](docs/DATABASE.md) — schema and migration conventions.
- [Deployment](docs/DEPLOYMENT.md) — runtime requirements and operations.
- [Developer onboarding](docs/ONBOARDING.md) — local setup and code map.
- [Workspace quickstart](docs/LOCAL_DEVELOPMENT.md) — API, web, and mobile local setup and pre-PR checks.
- [Non-payment roadmap](../NON_PAYMENT_ROADMAP_CHECKLIST.md) — current completion status and known gaps.

The backend route handlers and Zod schemas are authoritative. The former hand-maintained API catalogs were removed because they had drifted from the live route table; use the generated OpenAPI document for endpoint contracts.
