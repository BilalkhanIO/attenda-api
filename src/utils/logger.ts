import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request context propagated through async boundaries. */
export const requestContext = new AsyncLocalStorage<{ requestId: string; userId?: string }>();

const base = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // Pretty output only outside production (and only if pino-pretty is present)
  ...(process.env.NODE_ENV !== 'production' && {
    transport: undefined, // keep JSON; pipe through `npx pino-pretty` locally if desired
  }),
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  mixin() {
    const ctx = requestContext.getStore();
    return ctx ? { requestId: ctx.requestId, ...(ctx.userId && { userId: ctx.userId }) } : {};
  },
});

export const logger = base;

/** Child logger for background jobs (no request context). */
export const jobLogger = base.child({ scope: 'jobs' });
