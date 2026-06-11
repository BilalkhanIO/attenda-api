import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger, requestContext } from './utils/logger';
import redis from './utils/redis';

import authRouter       from './routes/auth';
import usersRouter      from './routes/users';
import attendanceRouter from './routes/attendance';
import leaveRouter      from './routes/leave';
import shiftsRouter     from './routes/shifts';
import payrollRouter    from './routes/payroll';
import departmentsRouter from './routes/departments';
import { performanceRouter, analyticsRouter, orgRouter, reportsRouter } from './routes/misc';
import orgRbacRouter from './routes/org-rbac';
import webhooksRouter from './routes/webhooks';
import adminRouter         from './routes/admin';
import adminPlatformUsersRouter from './routes/admin-platform-users';
import overtimeRouter      from './routes/overtime';
import notificationsRouter from './routes/notifications';
import publicRouter        from './routes/public';
import { errorHandler, notFound } from './middleware/errorHandler';

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
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests', code: 'RATE_LIMITED' },
  store: new RedisStore({ sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never, prefix: 'rl:global:' }),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many auth attempts', code: 'RATE_LIMITED' },
  store: new RedisStore({ sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never, prefix: 'rl:auth:' }),
});

app.use(globalLimiter);

// ─── Health check ─────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ─── API Routes ───────────────────────────────────────
const API = '/api/v1';

app.use(`${API}/auth`,        authLimiter, authRouter);
app.use(`${API}/users`,       usersRouter);
app.use(`${API}/attendance`,  attendanceRouter);
app.use(`${API}/leave`,       leaveRouter);
app.use(`${API}/shifts`,      shiftsRouter);
app.use(`${API}/payroll`,     payrollRouter);
app.use(`${API}/performance`, performanceRouter);
app.use(`${API}/analytics`,   analyticsRouter);
app.use(`${API}/org/departments`, departmentsRouter);
app.use(`${API}/org`,         orgRouter);
app.use(`${API}/org`,         orgRbacRouter);
app.use(`${API}/reports`,      reportsRouter);
app.use(`${API}/webhooks`,    webhooksRouter);
app.use(`${API}/admin/users`, adminPlatformUsersRouter);
app.use(`${API}/admin`,      adminRouter);
app.use(`${API}/overtime`,       overtimeRouter);
app.use(`${API}/notifications`, notificationsRouter);
app.use(`${API}/public`,       publicRouter);

// ─── 404 & Error handler ──────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
