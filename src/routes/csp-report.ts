import express, { Request, Response, NextFunction } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../utils/redis';
import { logger } from '../utils/logger';

const router = express.Router();
const MAX_REPORTS_PER_POST = 20;

type CspViolation = {
  'effective-directive'?: string;
  'violated-directive'?: string;
  'blocked-uri'?: string;
  'source-file'?: string;
  'document-uri'?: string;
  'line-number'?: number;
  disposition?: string;
};

const reportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1'),
  store: new RedisStore({
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never,
    prefix: 'rl:csp-report:',
  }),
  passOnStoreError: true,
  handler: (_req, res) => res.status(204).end(),
});

function safeText(value: unknown, limit = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(/[?#]/, 1)[0]
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .slice(0, limit) || undefined;
}

function safeLocation(value: unknown): string | undefined {
  const cleaned = safeText(value, 512);
  if (!cleaned) return undefined;
  try {
    const url = new URL(cleaned);
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol.endsWith('-extension:')) {
      return url.protocol;
    }
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return cleaned.startsWith('/') ? cleaned : cleaned.slice(0, 120);
  }
}

function normalizeReports(payload: unknown): CspViolation[] {
  if (!payload || typeof payload !== 'object') return [];
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.slice(0, MAX_REPORTS_PER_POST).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const report = entry as Record<string, unknown>;
    const rawBody = report.body && typeof report.body === 'object'
      ? report.body
      : report['csp-report'];
    if (!rawBody || typeof rawBody !== 'object') return [];
    const body = rawBody as Record<string, unknown>;
    return [{
      'effective-directive': safeText(body.effectiveDirective ?? body['effective-directive']),
      'violated-directive': safeText(body.violatedDirective ?? body['violated-directive']),
      'blocked-uri': safeLocation(body.blockedURL ?? body['blocked-uri']),
      'source-file': safeLocation(body.sourceFile ?? body['source-file']),
      'document-uri': safeLocation(body.documentURL ?? body['document-uri']),
      'line-number': typeof body.lineNumber === 'number'
        ? body.lineNumber
        : typeof body['line-number'] === 'number' ? body['line-number'] : undefined,
      disposition: safeText(body.disposition),
    }];
  });
}

router.post(
  '/',
  reportLimiter,
  express.json({
    type: ['application/json', 'application/csp-report', 'application/reports+json'],
    limit: '12kb',
  }),
  (req: Request, res: Response) => {
    const violations = normalizeReports(req.body);
    for (const violation of violations) {
      // Never log the raw report: it can contain query strings and code samples.
      logger.info({ event: 'csp_report_only_violation', ...violation }, 'CSP report-only violation');
    }
    return res.status(204).end();
  },
);

router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  const parserError = error as { type?: string };
  if (parserError?.type === 'entity.parse.failed' || parserError?.type === 'entity.too.large') {
    return res.status(204).end();
  }
  return next(error);
});

export default router;
