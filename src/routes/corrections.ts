import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { correctionRequestSchema, correctionReviewSchema } from '../schemas';
import { ok, created } from '../utils/response';
import prisma from '../utils/prisma';
import { reviewApproval } from '../services/approval-workflows';
import { idempotency } from '../middleware/idempotency';

/**
 * Employee-initiated attendance corrections ("forgot to check out", wrong
 * times): employee submits requested times + reason → manager/HR with
 * attendance.override approves (times applied like a manual override,
 * audited) or rejects with a note. Mounted at /attendance/corrections.
 */

const router = Router();
router.use(authenticate);

const CORRECTION_INCLUDE = {
  user:     { select: { id: true, name: true, avatar_url: true, department: true } },
  reviewer: { select: { id: true, name: true } },
} as const;

// ─── POST /attendance/corrections ──────────────────────
router.post('/', idempotency, validate({ body: correctionRequestSchema }), async (req, res, next) => {
  try {
    const { submitAttendanceCorrection } = await import('../services/attendance-correction-request');
    const correction = await submitAttendanceCorrection(req.user!.sub, req.user!.org_id, req.body);
    created(res, correction);
  } catch (e) { next(e); }
});

// ─── GET /attendance/corrections/me ────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const corrections = await prisma.attendanceCorrection.findMany({
      where: { user_id: req.user!.sub },
      include: CORRECTION_INCLUDE,
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    ok(res, corrections);
  } catch (e) { next(e); }
});

// ─── GET /attendance/corrections ───────────────────────
router.get('/', requirePermission('attendance.override'), async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query as Record<string, string>;
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (status !== 'all') where.status = status;

    const corrections = await prisma.attendanceCorrection.findMany({
      where,
      include: CORRECTION_INCLUDE,
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    ok(res, corrections);
  } catch (e) { next(e); }
});

// ─── PUT /attendance/corrections/:id/approve ───────────
router.put('/:id/approve', requirePermission('attendance.override'), idempotency, validate({ body: correctionReviewSchema }), async (req, res, next) => {
  try {
    const result = await reviewApproval(
      { userId: req.user!.sub, orgId: req.user!.org_id },
      { type: 'correction', id: String(req.params.id), action: 'approve', note: req.body.note },
    );
    ok(res, result);
  } catch (e) { next(e); }
});

// ─── PUT /attendance/corrections/:id/reject ────────────
router.put('/:id/reject', requirePermission('attendance.override'), idempotency, validate({ body: correctionReviewSchema }), async (req, res, next) => {
  try {
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const result = await reviewApproval(
      { userId: req.user!.sub, orgId: req.user!.org_id },
      { type: 'correction', id: String(req.params.id), action: 'reject', reason: note, note },
    );
    ok(res, result);
  } catch (e) { next(e); }
});

export default router;
