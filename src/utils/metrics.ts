import { collectDefaultMetrics, Registry, Histogram } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/** Times every request; the route label uses the matched Express route
 *  pattern (not the raw URL) so cardinality stays bounded. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : req.baseUrl || 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

/** GET /metrics — Prometheus scrape endpoint. When METRICS_TOKEN is set the
 *  scraper must send it as a bearer token; without the env var the endpoint
 *  stays open (fine for private networks, set the token on public deploys). */
export async function metricsHandler(req: Request, res: Response) {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
