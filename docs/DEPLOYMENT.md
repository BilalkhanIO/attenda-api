# Deployment Guide

## Topology

```
 Vercel (Attenda-web, Next.js)          Google Play / APK (Attenda-mobile)
        │  HTTPS + /api/v1 rewrite               │  HTTPS (dio)
        ▼                                        ▼
 Railway: attenda-api container  ──────────  PostgreSQL (Railway)
        │  ioredis                                 Redis (Railway)
        ├─ S3 (payslips, exports — presigned URLs)
        ├─ SMTP (invites, resets, payslips, lockout alerts)
        ├─ Meta WhatsApp Cloud API (webhooks in + notifications out)
        ├─ Anthropic API (AI scheduling, analytics chat, remote-reply parsing)
        └─ FCM (presence challenges — optional, env-gated)
```

The container start command is self-healing — no manual release steps:
`node scripts/migrate.js && node dist/server.js`
1. applies every SQL migration statement-by-statement (idempotent, partial-
   apply tolerant), 2. seeds baseline data (plans, blog, platform RBAC core)
with `ON CONFLICT DO NOTHING`, 3. boots; boot re-verifies the RBAC catalog
and platform role assignments.

## Environment variables (API)

Required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`FRONTEND_URL` (comma-separated origins for CORS), `NODE_ENV=production`.

Optional — features degrade gracefully when unset:
| Var | Enables |
|---|---|
| `AWS_ACCESS_KEY_ID/SECRET/REGION/S3_BUCKET` | Payslip PDFs + report exports on S3 (otherwise data-URI fallbacks) |
| `SMTP_HOST/PORT/USER/PASS/FROM` | All outbound email |
| `WHATSAPP_PHONE_ID/TOKEN/VERIFY_TOKEN/APP_SECRET` | WhatsApp notifications + webhook |
| `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL`) | AI scheduling, analytics chat, remote-nudge parsing |
| `FIREBASE_SERVICE_ACCOUNT` (JSON string) | FCM presence challenges |
| `LOG_LEVEL` | pino level (default info in production) |

Web (`Vercel`): `NEXT_PUBLIC_API_URL` (or rely on the `/api/v1` rewrite +
`BACKEND_API_URL`). Mobile: `--dart-define=API_URL=…` at build time.

## Deploy procedure

1. Merge to `main` → Railway and Vercel build automatically.
2. Watch the Railway **Build Logs** to completion (a failed build silently
   keeps the previous image serving — this bit us once; the Dockerfile now
   copies `prisma/` before `npm ci` so the postinstall generate works).
3. Deploy Logs must show: migrations ✓ → `[seed] Platform RBAC core ensured`
   → `🚀 Attenda API running`.
4. Smoke: `GET /health`, then log in on the web app.

## Rollback

Railway → Deployments → previous Active build → Redeploy. Migrations are
additive (columns/tables with defaults), so old code runs safely against a
newer schema.

## Backups (action required — not yet automated)

- Enable Railway PostgreSQL backups/PITR on the database service, **and/or**
- Schedule `pg_dump -Fc "$DATABASE_URL" | aws s3 cp - s3://<bucket>/backups/attenda-$(date +%F).dump`
  from any cron-capable host; test a restore quarterly (`pg_restore -c`).
- Redis holds only ephemeral state (blacklist, rate limits, locks) — no
  backup needed; a flush logs out sessions at worst.

## Scaling notes

Safe at >1 replica today: rate limits and job locks are Redis-backed.
Known single-instance seam: SSE invalidation events use an in-process
EventEmitter — at 2+ replicas, events reach only clients connected to the
emitting instance (counts still poll every 15s). Upgrade path: Redis pub/sub
behind the same `emitOrgEvent/subscribeOrgEvents` interface.
