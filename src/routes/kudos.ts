import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { kudosCreateSchema } from '../schemas';
import { ok, created, paginated, NotFoundError, ValidationError, AppError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { createNotification } from '../services/notifications';
import { resolveUserPermissions } from '../services/authorization';
import { KUDOS_DAILY_LIMIT, kudosDayWindow, isKudosCapReached } from '../services/kudos';

/**
 * Kudos / recognition feed. Deliberately permission-free: any org member
 * can give kudos and read the org feed — giving is the point. The only
 * guardrails are no-self-kudos, an active-member target check, and a
 * 20-per-giver-per-day cap. Deletion (moderation) is the author or
 * org.settings.update; soft delete keeps the audit trail. Mounted at /kudos.
 */

const router = Router();
router.use(authenticate);

const KUDOS_INCLUDE = {
  giver:     { select: { id: true, name: true, avatar_url: true, department: true } },
  recipient: { select: { id: true, name: true, avatar_url: true, department: true } },
} as const;

// ─── POST /kudos ───────────────────────────────────────
router.post('/', validate({ body: kudosCreateSchema }), async (req, res, next) => {
  try {
    const { to_user_id, message, emoji } = req.body as {
      to_user_id: string; message: string; emoji?: string;
    };

    if (to_user_id === req.user!.sub) {
      throw new ValidationError('You cannot give kudos to yourself');
    }

    const target = await prisma.user.findFirst({
      where: { id: to_user_id, org_id: req.user!.org_id, is_active: true, deleted_at: null },
      select: { id: true, name: true },
    });
    if (!target) throw new NotFoundError('User');

    // Rate-limit-lite: max 20 kudos per giver per UTC day.
    const { start, end } = kudosDayWindow();
    const sentToday = await prisma.kudos.count({
      where: {
        from_user_id: req.user!.sub,
        created_at: { gte: start, lt: end },
        deleted_at: null,
      },
    });
    if (isKudosCapReached(sentToday)) {
      throw new AppError(
        `Daily kudos limit reached (${KUDOS_DAILY_LIMIT} per day)`,
        429, 'RATE_LIMITED',
      );
    }

    const kudos = await prisma.kudos.create({
      data: {
        org_id: req.user!.org_id,
        from_user_id: req.user!.sub,
        to_user_id,
        message,
        emoji: emoji ?? null,
      },
      include: KUDOS_INCLUDE,
    });

    createNotification({
      userId: to_user_id, orgId: req.user!.org_id,
      type: 'kudos_received',
      title: 'You received kudos!',
      body: `${kudos.giver.name} recognised you${emoji ? ` ${emoji}` : ''}: "${message}"`,
      actionType: 'kudos', actionId: kudos.id,
    }).catch(() => {});

    created(res, kudos);
  } catch (e) { next(e); }
});

// ─── GET /kudos ────────────────────────────────────────
// Org feed, newest first. Pagination is opt-in via ?page=&limit= like the
// other list endpoints; without it the latest 100 are returned.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = req.query as Record<string, string>;
    const where = { org_id: req.user!.org_id, deleted_at: null };
    const orderBy = { created_at: 'desc' as const };

    if (page || limit) {
      const pg = Math.max(1, parseInt(page || '1'));
      const lm = Math.min(100, Math.max(1, parseInt(limit || '25')));
      const [feed, total] = await Promise.all([
        prisma.kudos.findMany({ where, include: KUDOS_INCLUDE, orderBy, skip: (pg - 1) * lm, take: lm }),
        prisma.kudos.count({ where }),
      ]);
      paginated(res, feed, total, pg, lm);
      return;
    }

    const feed = await prisma.kudos.findMany({ where, include: KUDOS_INCLUDE, orderBy, take: 100 });
    ok(res, feed);
  } catch (e) { next(e); }
});

// ─── GET /kudos/mine ───────────────────────────────────
router.get('/mine', async (req, res, next) => {
  try {
    const [receivedCount, givenCount, recentReceived] = await Promise.all([
      prisma.kudos.count({ where: { to_user_id: req.user!.sub, deleted_at: null } }),
      prisma.kudos.count({ where: { from_user_id: req.user!.sub, deleted_at: null } }),
      prisma.kudos.findMany({
        where: { to_user_id: req.user!.sub, deleted_at: null },
        include: KUDOS_INCLUDE,
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
    ]);
    ok(res, { received: receivedCount, given: givenCount, recent_received: recentReceived });
  } catch (e) { next(e); }
});

// ─── DELETE /kudos/:id ─────────────────────────────────
// Author may retract their own kudos; moderation needs org.settings.update.
router.delete('/:id', async (req, res, next) => {
  try {
    const kudos = await prisma.kudos.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, deleted_at: null },
    });
    if (!kudos) throw new NotFoundError('Kudos');

    if (kudos.from_user_id !== req.user!.sub) {
      const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
      if (!perms.has('org.settings.update')) {
        throw new AppError('Only the author or an org admin can delete kudos', 403, 'FORBIDDEN');
      }
    }

    await prisma.kudos.update({
      where: { id: kudos.id },
      data: { deleted_at: new Date() },
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'kudos.delete', entityType: 'kudos', entityId: kudos.id,
      before: { from_user_id: kudos.from_user_id, to_user_id: kudos.to_user_id, message: kudos.message },
      after: { deleted_at: new Date().toISOString() },
    });

    ok(res, { id: kudos.id, deleted: true });
  } catch (e) { next(e); }
});

export default router;
