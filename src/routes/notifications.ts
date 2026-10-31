import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok, NotFoundError, ValidationError } from '../utils/response';
import { verifyAccessToken } from '../utils/auth';
import { subscribeOrgEvents } from '../services/notifications';
import prisma from '../utils/prisma';
import { randomUUID } from 'node:crypto';

const router = Router();

// ─── GET /notifications/stream ────────────────────────
// SSE endpoint. Preferred auth: Authorization header (fetch-based SSE clients
// can set headers). The ?token= query param remains supported for native
// EventSource clients, but it leaks tokens into access logs — avoid it.
router.get('/stream', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.query.token as string | undefined);
  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }

  let userId: string;
  let orgId: string;
  try {
    const payload = verifyAccessToken(token);
    userId = payload.sub;
    orgId  = payload.org_id;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = async () => {
    try {
      const count = await prisma.inAppNotification.count({
        where: { user_id: userId, read_at: null },
      });
      res.write(`id: ${randomUUID()}\ndata: ${JSON.stringify({ type: 'count', count })}\n\n`);
    } catch { /* DB may be transiently unavailable */ }
  };

  // Invalidation push: mutation handlers emit coarse org-scoped events
  // (see services/notifications emitOrgEvent); forward them so clients can
  // refetch the affected resource without waiting for a poll cycle.
  const unsubscribe = subscribeOrgEvents(orgId, (scope, eventId) => {
    try {
      res.write(`id: ${eventId ?? randomUUID()}\ndata: ${JSON.stringify({ type: 'invalidate', scope })}\n\n`);
    } catch { /* connection is tearing down */ }
  });

  // Subscribe before the initial snapshot to close the connect/refetch race.
  // A reconnect deliberately invalidates all cached resources; pub/sub does not
  // promise replay while an instance is disconnected from Redis.
  try { res.write(`id: ${randomUUID()}\ndata: ${JSON.stringify({ type: 'invalidate', scope: 'all' })}\n\n`); } catch { /* ignore closing client */ }
  await send();
  const interval = setInterval(send, 15_000);
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* closing client */ } }, 20_000);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

// All remaining routes require a Bearer token in the Authorization header
router.use(authenticate);

// ─── GET /notifications ───────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const unread = req.query.unread === 'true';
    const baseWhere = { user_id: req.user!.sub, ...(unread ? { read_at: null } : {}) };

    // Cursor mode is opt-in to preserve the existing page-number contract.
    if (req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string') {
      const parsedLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 20;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      if (cursor) {
        const anchor = await prisma.inAppNotification.findFirst({
          where: { id: cursor, ...baseWhere },
          select: { id: true },
        });
        if (!anchor) throw new ValidationError('Invalid notification cursor');
      }

      const [rows, unreadCount] = await Promise.all([
        prisma.inAppNotification.findMany({
          where: baseWhere,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        }),
        prisma.inAppNotification.count({ where: { user_id: req.user!.sub, read_at: null } }),
      ]);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      ok(res, {
        items,
        next_cursor: hasMore ? items[items.length - 1]?.id ?? null : null,
        has_more: hasMore,
        unread_count: unreadCount,
      });
      return;
    }

    const page     = Math.max(1, parseInt((req.query.page as string) || '1'));
    const limit    = Math.min(50, parseInt((req.query.limit as string) || '20'));
    const skip     = (page - 1) * limit;

    const where: Record<string, unknown> = baseWhere;

    const [items, total, unreadCount] = await Promise.all([
      prisma.inAppNotification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      prisma.inAppNotification.count({ where }),
      prisma.inAppNotification.count({ where: { user_id: req.user!.sub, read_at: null } }),
    ]);

    ok(res, { items, total, page, limit, unread_count: unreadCount });
  } catch (e) { next(e); }
});

// ─── GET /notifications/count ─────────────────────────
router.get('/count', async (req, res, next) => {
  try {
    const count = await prisma.inAppNotification.count({
      where: { user_id: req.user!.sub, read_at: null },
    });
    ok(res, { count });
  } catch (e) { next(e); }
});

// ─── PUT /notifications/read-all ──────────────────────
router.put('/read-all', async (req, res, next) => {
  try {
    await prisma.inAppNotification.updateMany({
      where: { user_id: req.user!.sub, read_at: null },
      data:  { read_at: new Date() },
    });
    ok(res, { message: 'All notifications marked as read' });
  } catch (e) { next(e); }
});

// ─── PUT /notifications/:id/read ──────────────────────
router.put('/:id/read', async (req, res, next) => {
  try {
    const notif = await prisma.inAppNotification.findFirst({
      where: { id: req.params.id, user_id: req.user!.sub },
    });
    if (!notif) throw new NotFoundError('Notification');

    const updated = await prisma.inAppNotification.update({
      where: { id: req.params.id },
      data:  { read_at: new Date() },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /notifications/:id ────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const notif = await prisma.inAppNotification.findFirst({
      where: { id: req.params.id, user_id: req.user!.sub },
    });
    if (!notif) throw new NotFoundError('Notification');

    await prisma.inAppNotification.delete({ where: { id: req.params.id } });
    ok(res, { message: 'Notification deleted' });
  } catch (e) { next(e); }
});

export default router;
