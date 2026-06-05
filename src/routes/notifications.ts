// @ts-nocheck
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { ok, NotFoundError } from '../utils/response';
import { verifyAccessToken } from '../utils/auth';
import prisma from '../utils/prisma';

const router = Router();

// ─── GET /notifications/stream ────────────────────────
// SSE endpoint — token passed as query param because EventSource can't set headers.
// Must be registered BEFORE router.use(authenticate) since EventSource cannot
// send an Authorization header; the token is validated inline from the query string.
router.get('/stream', async (req: Request, res: Response) => {
  const token = req.query.token as string | undefined;
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
      res.write(`data: ${JSON.stringify({ type: 'count', count })}\n\n`);
    } catch { /* DB may be transiently unavailable */ }
  };

  await send();
  const interval = setInterval(send, 15_000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// All remaining routes require a Bearer token in the Authorization header
router.use(authenticate);

// ─── GET /notifications ───────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const page     = Math.max(1, parseInt((req.query.page as string) || '1'));
    const limit    = Math.min(50, parseInt((req.query.limit as string) || '20'));
    const unread   = req.query.unread === 'true';
    const skip     = (page - 1) * limit;

    const where: Record<string, unknown> = { user_id: req.user!.sub };
    if (unread) where.read_at = null;

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
