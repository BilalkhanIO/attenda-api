# Deployment and runtime

The API container is built from `attenda-api/Dockerfile` (Node 20, non-root runtime). Both container startup and manual deployment use Prisma's committed migration history through `prisma migrate deploy`. The legacy hand-maintained SQL runner was removed because it stopped at `20260706000000_hot_path_indexes`, swallowed statement failures, and seeded demo/platform accounts at startup. The container now fails before serving traffic if migrations fail; local demo seeding is an explicit command. A clean ephemeral PostgreSQL rehearsal applied all 118 migrations, and a second rehearsal applied them from a verified initial-schema baseline. The configured local database reports all migrations applied.

## Short runbook

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection |
| `REDIS_URL` | Yes | Rate limits, sessions, scheduler locks, event coordination |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Yes | Signed access and refresh credentials; use separate strong secrets |
| `IDEMPOTENCY_RESPONSE_ENCRYPTION_KEY` | Production | Encrypt stored replay responses containing sensitive credentials |
| `FRONTEND_URL` | Yes | Comma-separated allowed browser origins |
| `NODE_ENV`, `PORT` | Runtime | Environment mode and API listener port |
| `API_PUBLIC_URL`, `API_INTERNAL_ORIGIN` | Deployment-dependent | ICS links and internal attendance-sync calls |
| `GEMINI_API_KEY`, `AI_PRIMARY_PROVIDER`, optional `AI_OPENAI_*` | Optional | AI assistant/scheduling provider configuration |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET` | Optional | Object storage for files and generated documents |
| `BREVO_API_KEY`, `BREVO_FROM_EMAIL` or `SMTP_*` | Optional | Outbound email |
| `WHATSAPP_*` | Optional | WhatsApp Cloud API |
| `FIREBASE_SERVICE_ACCOUNT` | Optional | Push delivery and Android presence challenge |

See `.env.example` for supported values and defaults. Keep real credentials in the deployment secret store.

### Migration commands

- Local schema authoring: `npx prisma migrate dev`.
- Apply committed migrations to a database with a valid Prisma migration history: `npx prisma migrate deploy`.
- Check state: `npx prisma migrate status`.
- Docker startup runs `npx prisma migrate deploy`, the same migration-history-aware path used manually. Existing databases created by the removed raw-SQL runner may have tables but no `_prisma_migrations` history; `migrate deploy` will fail closed on such a non-empty schema. Before upgrading one, take a backup, clone it to staging, compare its schema with the exact migration boundary, baseline only migrations proven to be applied using `prisma migrate resolve --applied <migration_name>`, then run `prisma migrate deploy` and verify the full application. Do not automatically baseline a live database or mark migrations applied from the old runner's hard-coded list; it logged and continued after SQL errors. Keep the deployment blocked until a production-like clone has a verified baseline plan.

### Backup before schema or release changes

Create a PostgreSQL custom-format backup before deployment:

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > "attenda-$(date +%F-%H%M).dump"
```

Test restore procedures in a separate database. A restore example is:

```bash
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" attenda-backup.dump
```

### Rollback

1. If the application release fails and the migration was backward-compatible, redeploy the previous application image.
2. Do not reverse an applied migration by editing its SQL or deleting its migration record. Ship a forward fix.
3. If data/schema recovery is required, stop writes and restore the pre-deploy backup or provider point-in-time recovery into a recovery database; validate it before switching traffic.
4. Confirm `/health`, `/ready`, authentication, and one read/write flow after recovery.

Record the release, migration names, backup location, and restore verification in the deployment change log.

## Required services

- PostgreSQL and Redis
- Strong access, refresh, and idempotency-response encryption keys
- Exact allowed web origins for CORS

The web client is configured through `NEXT_PUBLIC_API_URL` or its Next.js rewrite target. Flutter receives the API base URL at build time through `--dart-define=API_URL=...`.

## Local Docker stack

From `attenda-api/`, copy `.env.example` to `.env` and run `docker compose up --build`. Compose starts the API, PostgreSQL, and Redis. The API uses port `5000` by default; web and mobile setup instructions are in their respective READMEs.

## Health and rollout

- `GET /health` is the liveness endpoint.
- `GET /ready` is the readiness endpoint and checks PostgreSQL and Redis.
- The Docker health check uses `/health`; configure the hosting platform's readiness probe to use `/ready` where supported.
- Watch migration output and API startup logs during rollout. Migrations are append-only once shared; use an expand/contract migration for changes that need rolling compatibility.
- Redis stores coordination/session support state and is not a substitute for durable application records.

The outbox and scheduler use Redis coordination and PostgreSQL state. API instances should share the same database and Redis deployment. See [Backend API and Logic](../BACKEND_API_AND_LOGIC.md) for known multi-instance behavior and remaining validation work.
