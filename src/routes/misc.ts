// @ts-nocheck
import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { ok, NotFoundError, ValidationError, AppError } from '../utils/response';
import { startOfDay } from '../utils/auth';
import prisma from '../utils/prisma';

// ─── PERFORMANCE ──────────────────────────────────────
export const performanceRouter = Router();
performanceRouter.use(authenticate);

// GET /performance/reviews
performanceRouter.get('/reviews', requireRole('manager'), async (req, res, next) => {
  try {
    const { month, year, department } = req.query as Record<string, string>;
    const m = parseInt(month || String(new Date().getMonth() + 1));
    const y = parseInt(year  || String(new Date().getFullYear()));

    const where: Record<string, unknown> = { org_id: req.user!.org_id, period_month: m, period_year: y };
    if (req.user!.role === 'manager') {
      const team = await prisma.user.findMany({ where: { manager_id: req.user!.sub }, select: { id: true } });
      where.user_id = { in: team.map(u => u.id) };
    }

    // Ensure reviews exist for all active users
    const users = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, is_active: true, role: 'employee', deleted_at: null, ...(req.user!.role === 'manager' ? { manager_id: req.user!.sub } : {}) },
      select: { id: true },
    });

    for (const u of users) {
      await prisma.performanceReview.upsert({
        where: { user_id_period_month_period_year: { user_id: u.id, period_month: m, period_year: y } },
        update: {},
        create: { user_id: u.id, org_id: req.user!.org_id, period_month: m, period_year: y },
      });
    }

    const reviews = await prisma.performanceReview.findMany({
      where,
      include: {
        user:     { select: { id: true, name: true, department: true, avatar_url: true } },
        reviewer: { select: { id: true, name: true } },
        goals:    true,
      },
      orderBy: { user: { name: 'asc' } },
    });
    ok(res, reviews);
  } catch (e) { next(e); }
});

// POST /performance/reviews/:userId
performanceRouter.post('/reviews/:userId', requireRole('manager'), async (req, res, next) => {
  try {
    const { score, comments, month, year } = req.body;
    if (!score || !comments || !month) throw new ValidationError('score, comments and month required');
    if (score < 1 || score > 5) throw new ValidationError('score must be between 1 and 5');

    // Accept month as "MM-YYYY", "YYYY-MM", or separate month + year fields
    let m: number, y: number;
    if (year) {
      m = parseInt(month);
      y = parseInt(year);
    } else {
      const parts = (month as string).split('-').map(Number);
      // Detect format: if first part > 12 it's YYYY-MM, else MM-YYYY
      if (parts[0] > 12) { y = parts[0]; m = parts[1]; }
      else                { m = parts[0]; y = parts[1]; }
    }
    if (!m || !y || m < 1 || m > 12) throw new ValidationError('Invalid month/year format. Use MM-YYYY');
    const review = await prisma.performanceReview.findFirst({
      where: { user_id: req.params.userId, period_month: m, period_year: y },
    });
    if (!review) throw new NotFoundError('Review');
    if (review.submitted_at) throw new AppError('Review already submitted and locked', 400);

    const attendanceScore = await calcAttendanceScore(req.params.userId, m, y);
    const overallScore    = score * 20; // star 1-5 -> score 20-100

    const updated = await prisma.performanceReview.update({
      where: { id: review.id },
      data: {
        manager_rating: score,
        attendance_score: attendanceScore,
        overall_score: overallScore,
        notes: comments,
        reviewer_id: req.user!.sub,
        submitted_at: new Date(),
      },
      include: {
        user:     { select: { id: true, name: true, department: true } },
        reviewer: { select: { id: true, name: true } },
      },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// GET /performance/goals
performanceRouter.get('/goals', authenticate, async (req, res, next) => {
  try {
    const userId = (req.query.user_id as string) || req.user!.sub;
    const goals = await prisma.performanceGoal.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
    ok(res, goals);
  } catch (e) { next(e); }
});

// POST /performance/goals
performanceRouter.post('/goals', requireRole('manager'), async (req, res, next) => {
  try {
    const { user_id, review_id, title, description, weight, target_date } = req.body;
    if (!user_id || !review_id || !title || !weight) throw new ValidationError('Missing required fields');
    const goal = await prisma.performanceGoal.create({
      data: { user_id, review_id, title, description, weight, target_date: target_date ? new Date(target_date) : null },
    });
    ok(res, goal, 201);
  } catch (e) { next(e); }
});

// PUT /performance/goals/:id
performanceRouter.put('/goals/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const goal = await prisma.performanceGoal.update({ where: { id: req.params.id }, data: req.body });
    ok(res, goal);
  } catch (e) { next(e); }
});

async function calcAttendanceScore(userId: string, month: number, year: number): Promise<number> {
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 0);
  const records = await prisma.attendanceRecord.findMany({ where: { user_id: userId, date: { gte: start, lte: end } } });
  const lateCount   = records.filter(r => r.status === 'late').length;
  const absentCount = records.filter(r => r.status === 'absent').length;
  return Math.max(0, 100 - lateCount * 3 - absentCount * 5);
}


// ─── ANALYTICS ────────────────────────────────────────
export const analyticsRouter = Router();
analyticsRouter.use(authenticate, requireRole('manager'));

// GET /analytics/overview
analyticsRouter.get('/overview', async (req, res, next) => {
  try {
    const today = startOfDay(new Date());
    const where: Record<string, unknown> = { org_id: req.user!.org_id, date: today };

    const records = await prisma.attendanceRecord.findMany({ where });
    const allUsers = await prisma.user.count({ where: { org_id: req.user!.org_id, is_active: true, deleted_at: null } });

    const counts = records.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    ok(res, {
      checked_in:    counts['in'] || 0,
      checked_out:   counts['out'] || 0,
      remote:        counts['remote'] || 0,
      on_leave:      counts['leave'] || 0,
      absent:        counts['absent'] || 0,
      total_employees: allUsers,
      updated_at:    new Date(),
    });
  } catch (e) { next(e); }
});

// GET /analytics/attendance-trend
analyticsRouter.get('/attendance-trend', async (req, res, next) => {
  try {
    const days = parseInt((req.query.days as string) || '30');
    const data = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const date = startOfDay(d);
      const records = await prisma.attendanceRecord.findMany({ where: { org_id: req.user!.org_id, date } });
      const present = records.filter(r => ['in','out','late','remote'].includes(r.status)).length;
      const total   = records.length || 1;
      data.push({ date: date.toISOString().split('T')[0], present, absent: records.filter(r => r.status === 'absent').length, late: records.filter(r => r.status === 'late').length, rate: Math.round((present / total) * 100) });
    }
    ok(res, data);
  } catch (e) { next(e); }
});

// GET /analytics/late-arrivals
analyticsRouter.get('/late-arrivals', async (req, res, next) => {
  try {
    const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
    const records = await prisma.attendanceRecord.findMany({
      where: { org_id: req.user!.org_id, status: 'late', date: { gte: start } },
      include: { user: { select: { name: true } } },
    });
    const grouped = records.reduce((acc: Record<string, { name: string; count: number }>, r) => {
      const name = r.user?.name || r.user_id;
      if (!acc[name]) acc[name] = { name, count: 0 };
      acc[name].count++;
      return acc;
    }, {});
    ok(res, Object.values(grouped).sort((a, b) => b.count - a.count));
  } catch (e) { next(e); }
});

// GET /analytics/payroll-cost
analyticsRouter.get('/payroll-cost', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const data = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const month = d.getMonth() + 1; const year = d.getFullYear();
      const records = await prisma.payrollRecord.findMany({ where: { org_id: req.user!.org_id, period_month: month, period_year: year, status: 'processed' } });
      const total = records.reduce((s, r) => s + Number(r.gross_pay), 0);
      data.push({ month: `${year}-${String(month).padStart(2,'0')}`, total });
    }
    ok(res, data);
  } catch (e) { next(e); }
});


// ─── ORG SETTINGS ─────────────────────────────────────
export const orgRouter = Router();
orgRouter.use(authenticate);

// GET /org/settings
orgRouter.get('/settings', async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    if (!org) throw new NotFoundError('Organisation');
    ok(res, org);
  } catch (e) { next(e); }
});

// PUT /org/settings
orgRouter.put('/settings', requireRole('super_admin'), async (req, res, next) => {
  try {
    const { name, timezone, currency, payroll_day } = req.body;
    const data: Record<string, unknown> = {};
    if (name       !== undefined) data.name        = name;
    if (timezone   !== undefined) data.timezone    = timezone;
    if (currency   !== undefined) data.currency    = currency;
    if (payroll_day !== undefined) {
      const day = parseInt(payroll_day);
      if (day < 1 || day > 28) throw new ValidationError('payroll_day must be between 1 and 28');
      data.payroll_day = day;
    }
    const updated = await prisma.organisation.update({ where: { id: req.user!.org_id }, data });
    ok(res, updated);
  } catch (e) { next(e); }
});

// GET /org/office-ips
orgRouter.get('/office-ips', requireRole('super_admin'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    ok(res, org?.office_ips || []);
  } catch (e) { next(e); }
});

// PUT /org/office-ips
orgRouter.put('/office-ips', requireRole('super_admin'), async (req, res, next) => {
  try {
    const { ips } = req.body;
    if (!Array.isArray(ips)) throw new ValidationError('ips must be an array');
    if (ips.length > 10) throw new ValidationError('Maximum 10 IPs allowed');
    const updated = await prisma.organisation.update({ where: { id: req.user!.org_id }, data: { office_ips: ips } });
    ok(res, updated.office_ips);
  } catch (e) { next(e); }
});

// GET /org/whatsapp
orgRouter.get('/whatsapp', requireRole('super_admin'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    ok(res, {
      enabled: org?.wa_enabled,
      phone_number_id: org?.wa_phone_number_id,
      access_token: org?.wa_access_token ? '***redacted***' : null,
      group_ids: org?.wa_group_ids,
      events: org?.wa_events,
    });
  } catch (e) { next(e); }
});

// PUT /org/whatsapp
orgRouter.put('/whatsapp', requireRole('super_admin'), async (req, res, next) => {
  try {
    const { enabled, phone_number_id, access_token, group_ids, events } = req.body;
    const data: Record<string, unknown> = { wa_enabled: enabled, wa_phone_number_id: phone_number_id, wa_group_ids: group_ids, wa_events: events };
    if (access_token && access_token !== '***redacted***') data.wa_access_token = access_token;
    const updated = await prisma.organisation.update({ where: { id: req.user!.org_id }, data });
    ok(res, { message: 'WhatsApp settings saved' });
  } catch (e) { next(e); }
});

// GET /org/whatsapp/logs
orgRouter.get('/whatsapp/logs', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { page = '1', limit = '50', event_type, status } = req.query as Record<string, string>;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (event_type) where.event_type = event_type;
    if (status)     where.status     = status;
    const [logs, total] = await Promise.all([
      prisma.whatsappLog.findMany({ where, orderBy: { created_at: 'desc' }, take, skip }),
      prisma.whatsappLog.count({ where }),
    ]);
    ok(res, { logs, total, page: parseInt(page) || 1, limit: take });
  } catch (e) { next(e); }
});

// GET /org/departments
orgRouter.get('/departments', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, department: { not: null }, deleted_at: null },
      select: { department: true }, distinct: ['department'],
    });
    ok(res, users.map(u => u.department).filter(Boolean));
  } catch (e) { next(e); }
});

// GET /org/qr-code
orgRouter.get('/qr-code', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { generateOrgQrCode } = await import('../services/qrcode');
    const result = await generateOrgQrCode(req.user!.org_id);
    ok(res, result);
  } catch (e) { next(e); }
});

// POST /org/qr-code/regenerate
orgRouter.post('/qr-code/regenerate', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { generateOrgQrCode } = await import('../services/qrcode');
    const result = await generateOrgQrCode(req.user!.org_id);
    ok(res, result);
  } catch (e) { next(e); }
});

// ─── REPORTS (analytics/generate + download) ──────────
export const reportsRouter = Router();
reportsRouter.use(authenticate, requireRole('hr_admin'));

reportsRouter.post('/:type', async (req, res, next) => {
  try {
    const { type } = req.params;
    const { start_date, end_date, format: fmt = 'csv', month, year } = req.body;

    let downloadUrl: string | null = null;

    if (type === 'attendance' && start_date && end_date) {
      const records = await prisma.attendanceRecord.findMany({
        where: {
          org_id: req.user!.org_id,
          date: { gte: new Date(start_date), lte: new Date(end_date) },
        },
        include: { user: { select: { name: true, department: true } } },
        orderBy: [{ date: 'asc' }],
      });
      const { generateAttendanceCsv } = await import('../services/csvExport');
      downloadUrl = await generateAttendanceCsv(req.user!.org_id, records);

    } else if (type === 'payroll' && month && year) {
      const records = await prisma.payrollRecord.findMany({
        where: { org_id: req.user!.org_id, period_month: +month, period_year: +year },
        include: { user: { select: { name: true, department: true } } },
      });
      const { generatePayrollCsv } = await import('../services/csvExport');
      downloadUrl = await generatePayrollCsv(req.user!.org_id, records, +month, +year);

    } else if (type === 'leave' && start_date && end_date) {
      const requests = await prisma.leaveRequest.findMany({
        where: {
          org_id: req.user!.org_id,
          start_date: { lte: new Date(end_date) },
          end_date:   { gte: new Date(start_date) },
        },
        include: {
          user:     { select: { name: true, department: true } },
          reviewer: { select: { name: true } },
        },
      });
      const { generateLeaveCsv } = await import('../services/csvExport');
      downloadUrl = await generateLeaveCsv(req.user!.org_id, requests);

    } else if (type === 'performance' && month && year) {
      const reviews = await prisma.performanceReview.findMany({
        where: { org_id: req.user!.org_id, period_month: +month, period_year: +year },
        include: { user: { select: { name: true, department: true } } },
      });
      const { generatePerformanceCsv } = await import('../services/csvExport');
      downloadUrl = await generatePerformanceCsv(req.user!.org_id, reviews, +month, +year);
    } else {
      throw new ValidationError('Invalid report type or missing parameters');
    }

    ok(res, { download_url: downloadUrl, type, generated_at: new Date() });
  } catch (e) { next(e); }
});
