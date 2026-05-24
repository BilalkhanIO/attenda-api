// @ts-nocheck
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { ok, NotFoundError, ForbiddenError, ValidationError } from '../utils/response';
import { startOfDay, endOfDay, calcHoursWorked } from '../utils/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

const RECORD_INCLUDE = {
  user: { select: { id: true, name: true, avatar_url: true, department: true, job_title: true } },
};

// ─── GET /attendance/today ─────────────────────────────
router.get('/today', requireRole('manager'), async (req, res, next) => {
  try {
    const today = new Date();
    const date  = startOfDay(today);
    const where: Record<string, unknown> = { org_id: req.user!.org_id, date };
    if (req.user!.role === 'manager') {
      const teamIds = await prisma.user.findMany({
        where: { manager_id: req.user!.sub, is_active: true },
        select: { id: true },
      });
      where.user_id = { in: teamIds.map(u => u.id) };
    }
    const records = await prisma.attendanceRecord.findMany({ where, include: RECORD_INCLUDE, orderBy: { check_in_at: 'asc' } });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/me ────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const { days = '30' } = req.query as { days?: string };
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));
    const records = await prisma.attendanceRecord.findMany({
      where: { user_id: req.user!.sub, date: { gte: since } },
      orderBy: { date: 'desc' },
    });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/:userId ───────────────────────────
router.get('/:userId', requireRole('manager'), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { start, end } = req.query as { start?: string; end?: string };

    const user = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id } });
    if (!user) throw new NotFoundError('User');

    const where: Record<string, unknown> = { user_id: userId };
    if (start || end) {
      where.date = {};
      if (start) (where.date as Record<string, unknown>).gte = new Date(start);
      if (end)   (where.date as Record<string, unknown>).lte = new Date(end);
    }

    const records = await prisma.attendanceRecord.findMany({
      where, include: RECORD_INCLUDE, orderBy: { date: 'desc' }, take: 90,
    });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── POST /attendance/checkin ──────────────────────────
router.post('/checkin', async (req, res, next) => {
  try {
    const { type = 'manual', qr_code } = req.body;
    const today = startOfDay(new Date());

    // Check no existing check-in today
    const existing = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
    });
    if (existing?.check_in_at) throw new ValidationError('Already checked in today');

    // Validate QR code if provided
    if (type === 'qr' && !qr_code) throw new ValidationError('QR code required for QR check-in');

    const now    = new Date();
    const status = 'in'; // TODO: compare with shift start to detect 'late'

    const record = existing
      ? await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: { check_in_at: now, check_in_type: type, status },
          include: RECORD_INCLUDE,
        })
      : await prisma.attendanceRecord.create({
          data: {
            user_id: req.user!.sub, org_id: req.user!.org_id,
            date: today, check_in_at: now, check_in_type: type, status,
          },
          include: RECORD_INCLUDE,
        });

    // Fire WhatsApp notification (non-blocking)
    if (record.user) {
      const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
      const timeStr = formatTime12h(record.check_in_at || now);
      notifyCheckIn(req.user!.org_id, record.user.name, timeStr).catch(console.error);
    }
    ok(res, record);
  } catch (e) { next(e); }
});

// ─── POST /attendance/checkout ─────────────────────────
router.post('/checkout', async (req, res, next) => {
  try {
    const today = startOfDay(new Date());
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
    });
    if (!record?.check_in_at) throw new ValidationError('No check-in found for today');
    if (record.check_out_at)  throw new ValidationError('Already checked out today');

    const now          = new Date();
    const hoursWorked  = calcHoursWorked(record.check_in_at, now);

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { check_out_at: now, hours_worked: hoursWorked, status: 'out' },
      include: RECORD_INCLUDE,
    });
    // Fire WhatsApp notification (non-blocking)
    if (updated.user) {
      const { notifyCheckOut, formatTime12h } = await import('../services/whatsapp');
      const timeStr = formatTime12h(updated.check_out_at || now);
      notifyCheckOut(req.user!.org_id, updated.user.name, timeStr).catch(console.error);
    }
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── POST /attendance/ip-event ─────────────────────────
// Called by Flutter app when IP match/unmatch detected
router.post('/ip-event', async (req, res, next) => {
  try {
    const { event, ip } = req.body; // event: 'match' | 'unmatch'
    const today = startOfDay(new Date());

    // Verify IP against org registered IPs
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    if (!org?.office_ips.includes(ip)) {
      return ok(res, { action: 'none', reason: 'IP not in registered office IPs' });
    }

    if (event === 'match') {
      const existing = await prisma.attendanceRecord.findUnique({
        where: { user_id_date: { user_id: req.user!.sub, date: today } },
      });

      // Reconnected during grace period — cancel pending checkout
      if (existing?.ip_checkout_pending_at && !existing.check_out_at) {
        await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data:  { ip_checkout_pending_at: null },
        });
        return ok(res, { action: 'grace_period_cancelled' });
      }

      if (!existing?.check_in_at) {
        const record = existing
          ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { check_in_at: new Date(), check_in_type: 'auto_ip', status: 'in', ip_detected: ip } })
          : await prisma.attendanceRecord.create({ data: { user_id: req.user!.sub, org_id: req.user!.org_id, date: today, check_in_at: new Date(), check_in_type: 'auto_ip', status: 'in', ip_detected: ip } });
        return ok(res, { action: 'checked_in', record });
      }
      return ok(res, { action: 'already_in' });
    }

    if (event === 'unmatch') {
      // Start 5-minute grace period: set pending checkout timestamp
      const existing = await prisma.attendanceRecord.findUnique({
        where: { user_id_date: { user_id: req.user!.sub, date: today } },
      });
      if (existing?.check_in_at && !existing.check_out_at && !existing.ip_checkout_pending_at) {
        await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data:  { ip_checkout_pending_at: new Date() },
        });
        return ok(res, { action: 'grace_period_started', expires_at: new Date(Date.now() + 5 * 60 * 1000) });
      }
      return ok(res, { action: 'none' });
    }

    ok(res, { action: 'none' });
  } catch (e) { next(e); }
});

// ─── PUT /attendance/:id/override ─────────────────────
router.put('/:id/override', requireRole('manager'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { check_in_at, check_out_at, reason } = req.body;
    if (!reason) throw new ValidationError('Reason is required for override');

    const record = await prisma.attendanceRecord.findFirst({
      where: { id, org_id: req.user!.org_id },
    });
    if (!record) throw new NotFoundError('Attendance record');

    const updateData: Record<string, unknown> = {
      is_overridden: true,
      override_by: req.user!.sub,
      override_reason: reason,
    };

    if (check_in_at) {
      updateData.check_in_at = new Date(check_in_at);
    }
    if (check_out_at) {
      updateData.check_out_at = new Date(check_out_at);
      const checkIn = check_in_at ? new Date(check_in_at) : record.check_in_at;
      if (checkIn) {
        updateData.hours_worked = calcHoursWorked(checkIn, new Date(check_out_at));
      }
    }

    const updated = await prisma.attendanceRecord.update({
      where: { id },
      data: updateData,
      include: RECORD_INCLUDE,
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /attendance/report ────────────────────────────
router.get('/report/export', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { start_date, end_date, department } = req.query as Record<string, string>;
    if (!start_date || !end_date) throw new ValidationError('start_date and end_date required');

    const where: Record<string, unknown> = {
      org_id: req.user!.org_id,
      date: { gte: new Date(start_date), lte: new Date(end_date) },
    };
    if (department) {
      const deptUsers = await prisma.user.findMany({ where: { org_id: req.user!.org_id, department }, select: { id: true } });
      where.user_id = { in: deptUsers.map(u => u.id) };
    }

    const records = await prisma.attendanceRecord.findMany({
      where, include: RECORD_INCLUDE, orderBy: [{ date: 'asc' }, { user_id: 'asc' }],
    });
    ok(res, records);
  } catch (e) { next(e); }
});

export default router;
