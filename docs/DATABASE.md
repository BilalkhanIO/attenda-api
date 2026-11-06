# Database guide

PostgreSQL is accessed through Prisma. The current schema source is [`prisma/schema.prisma`](../prisma/schema.prisma); applied SQL migrations are in [`prisma/migrations/`](../prisma/migrations/). Avoid maintaining model counts or copied schema diagrams here because both drift as features evolve.

## Data rules

- Every tenant-owned record must be scoped to its organization in server queries and mutations. Foreign keys alone do not replace authorization checks.
- Keep the feature's own table as the source of truth; shared approvals, notifications, audit history, and outbox rows reference or describe the source record.
- Preserve audit/history records for security-sensitive and employment-impacting actions.
- Use transactions or conditional updates for multi-row state changes, balance/payroll effects, and reviewer decisions.
- Add indexes to match actual tenant-scoped filters and sort order; prefer cursor pagination for large feeds.
- Use soft deletion or archival where retention/audit requirements apply.

## Migrations

Create additive SQL under `prisma/migrations/<timestamp>_<name>/migration.sql`, update the Prisma schema, regenerate Prisma Client, and apply migrations with the Prisma CLI. Migrations are append-only after they have been applied in a shared environment. The legacy completion-type migration was corrected to drop its text default before converting the column; retain its compatibility behavior and verify history warnings for databases that already recorded the earlier file checksum. Review `DATABASE_URL` carefully before applying a migration. Docker startup and manual deployments both use `prisma migrate deploy`. Existing databases created by the retired raw-SQL runner may need a carefully verified one-time baseline; see [Deployment](DEPLOYMENT.md).

```bash
npx prisma migrate status
npx prisma migrate deploy
npx prisma generate
```

Schema changes that affect attendance, payroll, leave, approvals, or organization scoping must also update [Backend API and Logic](../BACKEND_API_AND_LOGIC.md) and the [feature checklist](NON_PAYMENT_ROADMAP_CHECKLIST.md).
