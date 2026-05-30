// @ts-nocheck
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { ok, NotFoundError, ForbiddenError, ValidationError, AppError } from '../utils/response';
import { startOfDay, calcHoursWorked, isOfficeNetwork } from '../utils/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

const RECORD_INCLUDE = {
  user: { select: { id: true, name: true, avatar_url: true, department: true, job_title: true } },
};

// ─── GET /attendance/today ─────────────────────────────
router.get('/today', requireRole('manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawDate = req.query.date as string | undefined;
    const date = rawDate ? startOfDay(new Date(rawDate)) : startOfDay(new Date());
    const where: Record<string, unknown> = { org_id: req.user!.org_id, date };
    if (req.user!.role === 'manager') {
      const teamIds = await prisma.user.findMany({
        where: { manager_id: req.user!.sub, is_active: true },
        select: { id: true },
      });
      where.user_id = { in: teamIds.map((u: { id: string }) => u.id) };
    }
    const records = await prisma.attendanceRecord.findMany({ where, include: RECORD_INCLUDE, orderBy: { check_in_at: 'asc' } });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/me ────────────────────────────────
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
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

// ─── GET /attendance/remote/sessions ──────────────────
// Manager sees remote session requests for approval
router.get('/remote/sessions', requireRole('manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as { status?: string };

    const teamIds = req.user!.role === 'manager'
      ? (await prisma.user.findMany({ where: { manager_id: req.user!.sub, org_id: req.user!.org_id }, select: { id: true } })).map((u: { id: string }) => u.id)
      : null;

    const where: Record<string, unknown> = { user: { org_id: req.user!.org_id } };
    if (status) where.status = status;
    if (teamIds) where.user_id = { in: teamIds };

    const sessions = await prisma.remoteSession.findMany({
      where,
      include: {
        user:     { select: { id: true, name: true, department: true, avatar_url: true } },
        attendance: { select: { date: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    ok(res, sessions);
  } catch (e) { next(e); }
});

// ─── PUT /attendance/remote/sessions/:id/approve ──────
router.put('/remote/sessions/:id/approve', requireRole('manager'), async (req, res, next) => {
  try {
    const session = await prisma.remoteSession.findUnique({
      where: { id: req.params.id },
      include: { user: true },
    });
    if (!session || session.user.org_id !== req.user!.org_id) throw new NotFoundError('Remote session');
    if (session.status !== 'pending') throw new ValidationError('Session is not pending approval');

    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { status: 'approved', approved_by: req.user!.sub },
    });

    // Notify team group via WhatsApp
    const { notifyRemote } = await import('../services/whatsapp');
    await notifyRemote(session.user.org_id, session.user.name).catch(console.error);

    ok(res, { message: 'Remote session approved' });
  } catch (e) { next(e); }
});

// ─── PUT /attendance/remote/sessions/:id/reject ───────
router.put('/remote/sessions/:id/reject', requireRole('manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await prisma.remoteSession.findFirst({ where: { id: req.params.id, user: { org_id: req.user!.org_id } } });
    if (!session) throw new NotFoundError('Remote session');
    if (session.status !== 'pending') throw new ValidationError('Session is not pending approval');

    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { status: 'rejected', approved_by: req.user!.sub },
    });

    // Revert attendance record status to 'absent' since remote was denied
    await prisma.attendanceRecord.update({
      where: { id: session.attendance_id },
      data: { status: 'absent' },
    });

    ok(res, { message: 'Remote session rejected' });
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/sessions/me ───────────────
// Employee views their own remote sessions
router.get('/remote/sessions/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await prisma.remoteSession.findMany({
      where: { user_id: req.user!.sub },
      include: {
        attendance:    { select: { date: true } },
        checkin_logs:  true,
      },
      orderBy: { created_at: 'desc' },
      take: 30,
    });
    ok(res, sessions);
  } catch (e) { next(e); }
});

// ─── POST /attendance/break/start ─────────────────────
router.post('/break/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { break_type = 'rest' } = req.body;
    const today = new Date(); today.setHours(0,0,0,0);
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: { break_records: { where: { break_end: null } } },
    });
    if (!record || !record.check_in_at) throw new AppError('Not checked in', 400, 'NOT_CHECKED_IN');
    if (record.check_out_at) throw new AppError('Already checked out', 400, 'CHECKED_OUT');
    if (record.break_records.length > 0) throw new AppError('Break already in progress', 400, 'BREAK_IN_PROGRESS');

    const breakRecord = await prisma.breakRecord.create({
      data: {
        attendance_id: record.id,
        break_start: new Date(),
        break_type,
        is_paid: break_type === 'rest',
      },
    });
    ok(res, breakRecord);
  } catch (e) { next(e); }
});

// ─── POST /attendance/break/end ───────────────────────
router.post('/break/end', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: { break_records: { where: { break_end: null } } },
    });
    if (!record) throw new AppError('Not checked in today', 400, 'NOT_CHECKED_IN');
    const activeBreak = record.break_records[0];
    if (!activeBreak) throw new AppError('No break in progress', 400, 'NO_BREAK');

    const now = new Date();
    const durationMins = Math.round((now.getTime() - activeBreak.break_start.getTime()) / 60000);

    const ended = await prisma.breakRecord.update({
      where: { id: activeBreak.id },
      data: { break_end: now, duration_mins: durationMins },
    });

    // Recalculate net_hours_worked
    const allBreaks = await prisma.breakRecord.findMany({
      where: { attendance_id: record.id, break_end: { not: null } },
    });
    const unpaidBreakMins = allBreaks.filter(b => !b.is_paid).reduce((sum, b) => sum + (b.duration_mins || 0), 0);
    const paidBreakMins = allBreaks.filter(b => b.is_paid).reduce((sum, b) => sum + (b.duration_mins || 0), 0);
    const totalMins = record.check_in_at ? Math.round((now.getTime() - record.check_in_at.getTime()) / 60000) : 0;
    const netMins = totalMins - unpaidBreakMins;

    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        break_minutes: unpaidBreakMins + paidBreakMins,
        paid_break_minutes: paidBreakMins,
        net_hours_worked: parseFloat((netMins / 60).toFixed(2)),
      },
    });

    ok(res, ended);
  } catch (e) { next(e); }
});

// ─── GET /attendance/break/status ─────────────────────
router.get('/break/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: { break_records: { orderBy: { break_start: 'asc' } } },
    });
    if (!record) return ok(res, { on_break: false, breaks: [] });
    const activeBreak = record.break_records.find(b => !b.break_end);
    ok(res, {
      on_break: !!activeBreak,
      active_break: activeBreak || null,
      breaks: record.break_records,
      total_break_mins: record.break_minutes,
    });
  } catch (e) { next(e); }
});

// ─── GET /attendance/:userId ───────────────────────────
router.get('/:userId', requireRole('manager'), async (req: Request, res: Response, next: NextFunction) => {
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
router.post('/checkin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type = 'manual', qr_code, duration_type = 'full_day' } = req.body;
    const today = startOfDay(new Date());

    // Check no existing check-in today
    const existing = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
    });
    if (existing?.check_in_at) throw new ValidationError('Already checked in today');

    // Validate QR code if provided
    if (type === 'qr') {
      if (!qr_code) throw new ValidationError('QR code required for QR check-in');
      const { verifyQrCode } = await import('../services/qrcode');
      const verification = verifyQrCode(qr_code, req.user!.org_id);
      if (!verification.valid) throw new ValidationError(verification.reason || 'Invalid QR code');
    }

    const now = new Date();

    // Detect status: check if this is a remote check-in
    let status: string = type === 'remote' ? 'remote' : 'in';

    // Detect late arrival by comparing with assigned shift
    if (type !== 'remote') {
      const [assignment, org] = await Promise.all([
        prisma.shiftAssignment.findFirst({
          where: { user_id: req.user!.sub, date: today },
          include: { shift: true },
        }),
        prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { late_threshold: true } }),
      ]);

      if (assignment?.shift) {
        const [sh, sm] = assignment.shift.start_time.split(':').map(Number);
        const shiftStartMins = sh * 60 + sm;
        const nowMins        = now.getHours() * 60 + now.getMinutes();
        const lateThreshold  = org?.late_threshold ?? 15;
        if (nowMins > shiftStartMins + lateThreshold) {
          status = 'late';
        }
      }
    }

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

    // Handle remote check-in: create RemoteSession pending manager approval
    if (type === 'remote') {
      const sessionExists = await prisma.remoteSession.findFirst({
        where: { attendance_id: record.id },
      });
      if (!sessionExists) {
        await prisma.remoteSession.create({
          data: {
            attendance_id: record.id,
            user_id:       req.user!.sub,
            status:        'pending',
            duration_type,
          },
        });
      }
    }

    // Fire WhatsApp notification (non-blocking)
    if (record.user && type !== 'remote') {
      const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
      const timeStr = formatTime12h(record.check_in_at || now);
      notifyCheckIn(req.user!.org_id, record.user.name, timeStr, record.user.department ?? undefined).catch(console.error);
    }

    ok(res, record);
  } catch (e) { next(e); }
});

// ─── POST /attendance/checkout ─────────────────────────
router.post('/checkout', async (req: Request, res: Response, next: NextFunction) => {
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
      notifyCheckOut(req.user!.org_id, updated.user.name, timeStr, updated.user.department ?? undefined).catch(console.error);
    }
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── POST /attendance/ip-event ─────────────────────────
// Called by Flutter app when WiFi connect/disconnect detected.
// Accepts: event ('match'|'unmatch'), ip (device LAN IP or CIDR), ssid (WiFi network name)
// SSID matching is preferred — more reliable than IP for orgs without static IPs.
router.post('/ip-event', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event, ip, ssid } = req.body;
    if (!event) throw new ValidationError('event is required');
    if (!ip && !ssid) throw new ValidationError('ip or ssid is required');
    const today = startOfDay(new Date());

    // Check against org's registered office networks (SSID first, then IP/CIDR)
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    if (!isOfficeNetwork(ip, ssid, org?.office_ips ?? [], org?.office_ssids ?? [])) {
      return ok(res, { action: 'none', reason: 'Not on a registered office network' });
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
        const now = new Date();
        // Detect late arrival for IP-based check-in
        let status = 'in';
        const assignment = await prisma.shiftAssignment.findFirst({
          where: { user_id: req.user!.sub, date: today },
          include: { shift: true },
        });
        if (assignment?.shift) {
          const [sh, sm] = assignment.shift.start_time.split(':').map(Number);
          const shiftStartMins = sh * 60 + sm;
          const nowMins        = now.getHours() * 60 + now.getMinutes();
          const lateThreshold = org?.late_threshold ?? 15;
          if (nowMins > shiftStartMins + lateThreshold) status = 'late';
        }

        const record = existing
          ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { check_in_at: now, check_in_type: 'auto_ip', status, ip_detected: ip } })
          : await prisma.attendanceRecord.create({ data: { user_id: req.user!.sub, org_id: req.user!.org_id, date: today, check_in_at: now, check_in_type: 'auto_ip', status, ip_detected: ip } });

        // Notify WhatsApp
        const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
        if (user) {
          const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
          notifyCheckIn(req.user!.org_id, user.name, formatTime12h(now)).catch(console.error);
        }

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
router.put('/:id/override', requireRole('manager'), async (req: Request, res: Response, next: NextFunction) => {
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

// ─── GET /attendance/report/export ────────────────────
router.get('/report/export', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start_date, end_date, department } = req.query as Record<string, string>;
    if (!start_date || !end_date) throw new ValidationError('start_date and end_date required');

    const where: Record<string, unknown> = {
      org_id: req.user!.org_id,
      date: { gte: new Date(start_date), lte: new Date(end_date) },
    };
    if (department) {
      const deptUsers = await prisma.user.findMany({ where: { org_id: req.user!.org_id, department }, select: { id: true } });
      where.user_id = { in: deptUsers.map((u: { id: string }) => u.id) };
    }

    const records = await prisma.attendanceRecord.findMany({
      where, include: RECORD_INCLUDE, orderBy: [{ date: 'asc' }, { user_id: 'asc' }],
    });
    ok(res, records);
  } catch (e) { next(e); }
});

export default router;
