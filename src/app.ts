import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger, requestContext } from './utils/logger';
import { metricsMiddleware, metricsHandler } from './utils/metrics';
import redis from './utils/redis';
import prisma from './utils/prisma';

import authRouter       from './routes/auth';
import usersRouter      from './routes/users';
import attendanceRouter from './routes/attendance';
import leaveRouter      from './routes/leave';
import shiftsRouter     from './routes/shifts';
import shiftFieldOpsRouter from './routes/shift-field-ops';
import shiftPlanningRouter from './routes/shift-planning';
import payrollRouter    from './routes/payroll';
import departmentsRouter from './routes/departments';
import { performanceRouter, analyticsRouter, aiRouter, orgRouter, reportsRouter } from './routes/misc';
import holidaysRouter from './routes/holidays';
import correctionsRouter from './routes/corrections';
import approvalsRouter from './routes/approvals';
import expensesRouter from './routes/expenses';
import documentsRouter from './routes/documents';
import orgRbacRouter from './routes/org-rbac';
import orgWebhooksRouter from './routes/org-webhooks';
import webhooksRouter from './routes/webhooks';
import adminRouter         from './routes/admin';
import adminPlatformUsersRouter from './routes/admin-platform-users';
import adminPlatformRolesRouter from './routes/admin-platform-roles';
import overtimeRouter      from './routes/overtime';
import onboardingRouter    from './routes/onboarding';
import kudosRouter         from './routes/kudos';
import notificationsRouter from './routes/notifications';
import publicRouter        from './routes/public';
import projectsRouter      from './routes/projects';
import { errorHandler, notFound } from './middleware/errorHandler';
import { verifyAccessToken } from './utils/auth';

const app = express();

// Trust Railway/cloud-proxy X-Forwarded-For header so rate-limit uses real IPs
app.set('trust proxy', 1);

// ─── Security & Parsing ───────────────────────────────
app.use(helmet());
const allowedOrigins = new Set(
  (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Capture raw body for webhook signature verification
app.use('/api/v1/webhooks', express.json({
  limit: '5mb',
  verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// ─── Structured logging + request correlation ─────────
app.use((req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, next);
});
app.use(pinoHttp({
  logger,
  genReqId: (_req, res) => res.getHeader('x-request-id') as string,
  autoLogging: { ignore: req => req.url === '/health' },
  customLogLevel: (_req, res, err) =>
    err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
}));

// ─── Rate limiting ────────────────────────────────────
// Counters live in Redis so limits hold across instances/restarts
// (the default memory store resets per process and double-counts nothing).
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: req => req.path === '/health' || req.path === '/ready',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests', code: 'RATE_LIMITED' },
  // The limiter runs before authenticate(), so safely verify the bearer token
  // here to prevent a shared office/NAT IP from throttling all employees.
  // Invalid/expired tokens and public traffic continue to use the IP bucket.
  keyGenerator: (req) => {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      try {
        const payload = verifyAccessToken(authorization.slice(7));
        if (payload.sub) return `user:${payload.sub}`;
      } catch { /* fall back to the source IP for invalid tokens */ }
    }
    return `ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1')}`;
  },
  store: new RedisStore({ sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never, prefix: 'rl:global:' }),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, error: 'Too many auth attempts', code: 'RATE_LIMITED' },
  store: new RedisStore({ sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never, prefix: 'rl:auth:' }),
});

// Login attempts are isolated by normalized email and source IP, so a whole
// office behind one NAT does not share a low credential-attempt bucket. The
// broader auth limiter above remains the higher per-IP ceiling.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many login attempts for this account and network', code: 'RATE_LIMITED' },
  keyGenerator: req => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'missing-email';
    const digest = createHash('sha256').update(email).digest('hex').slice(0, 24);
    const ip = ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1');
    return `email-ip:${digest}:${ip}`;
  },
  store: new RedisStore({ sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never, prefix: 'rl:login:' }),
});

const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, error: 'Too many authentication requests from this network', code: 'RATE_LIMITED' },
  keyGenerator: req => ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1'),
  store: new RedisStore({ sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never, prefix: 'rl:auth-ip:' }),
});

app.use(globalLimiter);

// ─── Health check & metrics ───────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});
app.get('/ready', async (_req, res) => {
  const checks = { database: false, redis: false };
  const results = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);
  checks.database = results[0].status === 'fulfilled';
  checks.redis = results[1].status === 'fulfilled';
  const ready = checks.database && checks.redis;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});
app.get('/metrics', metricsHandler);
app.use(metricsMiddleware);

// ─── API Routes ───────────────────────────────────────
const API = '/api/v1';

// The mount table doubles as the OpenAPI generator's route source —
// add new routers here and they appear in /api/v1/openapi.json.
const MOUNTS: Array<[string, express.Router]> = [
  [`${API}/auth`,            authRouter],
  [`${API}/users`,           usersRouter],
  // corrections mounts before the attendance router so its paths are not
  // swallowed by /attendance/:userId
  [`${API}/attendance/corrections`, correctionsRouter],
  [`${API}/approvals`,          approvalsRouter],
  [`${API}/attendance`,      attendanceRouter],
  [`${API}/leave`,           leaveRouter],
  [`${API}/shifts/planning`, shiftPlanningRouter],
  [`${API}/shifts`,          shiftFieldOpsRouter],
  [`${API}/shifts`,          shiftsRouter],
  [`${API}/payroll`,         payrollRouter],
  [`${API}/expenses`,        expensesRouter],
  [`${API}/documents`,       documentsRouter],
  [`${API}/onboarding`,      onboardingRouter],
  [`${API}/kudos`,           kudosRouter],
  [`${API}/performance`,     performanceRouter],
  [`${API}/projects`,        projectsRouter],
  [`${API}/analytics`,       analyticsRouter],
  [`${API}/ai`,              aiRouter],
  [`${API}/org/departments`, departmentsRouter],
  [`${API}/org/holidays`,    holidaysRouter],
  // outbound-webhooks mounts before the generic /org routers so its paths
  // are not swallowed by their parameterised routes
  [`${API}/org/outbound-webhooks`, orgWebhooksRouter],
  [`${API}/org`,             orgRouter],
  [`${API}/org`,             orgRbacRouter],
  [`${API}/reports`,         reportsRouter],
  [`${API}/webhooks`,        webhooksRouter],
  [`${API}/admin/users`,     adminPlatformUsersRouter],
  [`${API}/admin/roles`,     adminPlatformRolesRouter],
  [`${API}/admin`,           adminRouter],
  [`${API}/overtime`,        overtimeRouter],
  [`${API}/notifications`,   notificationsRouter],
  [`${API}/public`,          publicRouter],
];

app.use(`${API}/auth`, authIpLimiter, authLimiter);
app.use(`${API}/auth/login`, loginLimiter);
for (const [prefix, router] of MOUNTS) app.use(prefix, router);

// ─── OpenAPI spec (generated once, on first request) ──
let openApiDoc: Record<string, unknown> | null = null;
app.get(`${API}/openapi.json`, (_req, res) => {
  if (!openApiDoc) {
    const { buildOpenApiDoc } = require('./services/openapi') as typeof import('./services/openapi');
    openApiDoc = buildOpenApiDoc(MOUNTS);
  }
  res.json(openApiDoc);
});

// ─── 404 & Error handler ──────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
