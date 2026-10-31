import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { correctionRequestSchema, correctionReviewSchema } from '../schemas';
import { ok, created, NotFoundError, ValidationError, AppError } from '../utils/response';
import { calcHoursWorked } from '../utils/auth';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { createNotification, emitOrgEvent } from '../services/notifications';

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
router.post('/', validate({ body: correctionRequestSchema }), async (req, res, next) => {
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

async function loadPending(id: string, orgId: string) {
  const correction = await prisma.attendanceCorrection.findFirst({
    where: { id, org_id: orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!correction) throw new NotFoundError('Correction request');
  if (correction.status !== 'pending') {
    throw new AppError('Correction has already been reviewed', 400, 'ALREADY_REVIEWED');
  }
  return correction;
}

// ─── PUT /attendance/corrections/:id/approve ───────────
router.put('/:id/approve', requirePermission('attendance.override'), validate({ body: correctionReviewSchema }), async (req, res, next) => {
  try {
    const correction = await loadPending(String(req.params.id), req.user!.org_id);
    const note = req.body.note as string | undefined;

    // Apply the requested times the same way a manual override would.
    const overrideReason = `correction: ${correction.reason}`;
    let record = correction.attendance_id
      ? await prisma.attendanceRecord.findUnique({ where: { id: correction.attendance_id } })
      : await prisma.attendanceRecord.findUnique({
          where: { user_id_date: { user_id: correction.user_id, date: correction.date } },
        });

    const checkIn = correction.requested_check_in ?? record?.check_in_at ?? null;
    const checkOut = correction.requested_check_out ?? record?.check_out_at ?? null;
    const hours = checkIn && checkOut ? calcHoursWorked(checkIn, checkOut) : record?.hours_worked ?? null;

    const before = record
      ? { check_in_at: record.check_in_at, check_out_at: record.check_out_at, hours_worked: record.hours_worked }
      : null;

    if (record) {
      record = await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: {
          ...(correction.requested_check_in ? { check_in_at: correction.requested_check_in } : {}),
          ...(correction.requested_check_out ? { check_out_at: correction.requested_check_out } : {}),
          ...(hours !== null ? { hours_worked: hours } : {}),
          is_overridden: true, override_by: req.user!.sub, override_reason: overrideReason,
        },
      });
    } else {
      // No record existed for that day (e.g. missed check-in entirely).
      record = await prisma.attendanceRecord.create({
        data: {
          user_id: correction.user_id, org_id: correction.org_id, date: correction.date,
          check_in_at: correction.requested_check_in, check_out_at: correction.requested_check_out,
          ...(hours !== null ? { hours_worked: hours } : {}),
          check_in_type: 'manual', status: 'in',
          is_overridden: true, override_by: req.user!.sub, override_reason: overrideReason,
        },
      });
    }

    const updated = await prisma.attendanceCorrection.update({
      where: { id: correction.id },
      data: {
        status: 'approved', reviewed_by: req.user!.sub, reviewed_at: new Date(),
        review_note: note ?? null, attendance_id: record.id,
      },
      include: CORRECTION_INCLUDE,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'attendance.correction.approve', entityType: 'attendance_record', entityId: record.id,
      before, after: { check_in_at: record.check_in_at, check_out_at: record.check_out_at, hours_worked: record.hours_worked },
      reason: correction.reason,
    });
    createNotification({
      userId: correction.user_id, orgId: req.user!.org_id,
      type: 'correction_approved',
      title: 'Attendance correction approved',
      body: `Your correction for ${correction.date.toISOString().slice(0, 10)} was approved`,
      actionType: 'attendance_correction', actionId: correction.id,
    }).catch(() => {});
    emitOrgEvent(req.user!.org_id, 'attendance_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PUT /attendance/corrections/:id/reject ────────────
router.put('/:id/reject', requirePermission('attendance.override'), validate({ body: correctionReviewSchema }), async (req, res, next) => {
  try {
    const correction = await loadPending(String(req.params.id), req.user!.org_id);
    const note = req.body.note as string | undefined;

    const updated = await prisma.attendanceCorrection.update({
      where: { id: correction.id },
      data: { status: 'rejected', reviewed_by: req.user!.sub, reviewed_at: new Date(), review_note: note ?? null },
      include: CORRECTION_INCLUDE,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'attendance.correction.reject', entityType: 'attendance_correction', entityId: correction.id,
      reason: note ?? correction.reason,
    });
    createNotification({
      userId: correction.user_id, orgId: req.user!.org_id,
      type: 'correction_rejected',
      title: 'Attendance correction rejected',
      body: note ? `Your correction was rejected: ${note}` : 'Your attendance correction was rejected',
      actionType: 'attendance_correction', actionId: correction.id,
    }).catch(() => {});
    emitOrgEvent(req.user!.org_id, 'attendance_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

export default router;
