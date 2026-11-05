import { Router } from 'express';
import { aiRouter } from "./ai"; export { aiRouter };
import { authenticate, requireOrgFeature, requirePermission } from '../middleware/auth';
import { resolveUserPermissions } from '../services/authorization';
import { ok, NotFoundError, ValidationError, AppError, ForbiddenError, created } from '../utils/response';
import { startOfDay } from '../utils/auth';
import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { validate } from '../middleware/validate';
import { idempotency } from '../middleware/idempotency';
import { customReportDefinitionSchema, customReportSchema } from '../schemas/custom-reports';
import { orgSettingsSchema, announcementSchema, attendanceSecuritySchema } from '../schemas';
import { isScheduledForLater, publishAnnouncement, announcementAudienceWhere } from '../services/announcements';
import { generateGeminiJson } from '../services/ai/gemini-json';
import { recordAudit } from '../services/audit';
import { decodeCursor, encodeCursor, keysetAfter } from '../utils/cursor';
import { dateOnlyInTz } from '../utils/shift';
import { attendanceDateKey, attendanceDateOffset, localAttendanceDate, localAttendanceMonthStart, shiftAttendanceDateKey } from '../services/attendanceAnalytics';

// ─── PERFORMANCE ──────────────────────────────────────
export const performanceRouter = Router();
performanceRouter.use(authenticate);

// ─── ANNOUNCEMENTS ────────────────────────────────────
// Persisted announcements with optional publish scheduling (scheduled_for)
// and department targeting (department_id; target_dept_id is the legacy
// alias). Unscheduled org-wide announcements behave exactly as before:
// immediate in-app notification fan-out, response keeps {count, message}.
performanceRouter.post('/announcements', requirePermission('org.announcements.send'), validate({ body: announcementSchema }), async (req, res, next) => {
  try {
    const { title, body, department_id, target_dept_id, scheduled_for } = req.body;
    const orgId = req.user!.org_id;

    const deptId = department_id ?? target_dept_id ?? null;
    if (deptId) {
      const dept = await prisma.department.findFirst({
        where: { id: String(deptId), org_id: orgId },
        select: { id: true },
      });
      if (!dept) throw new NotFoundError('Department');
    }

    let scheduledFor: Date | null = null;
    if (scheduled_for) {
      scheduledFor = new Date(scheduled_for);
      if (isNaN(scheduledFor.getTime())) throw new ValidationError('Invalid scheduled_for');
    }

    const announcement = await prisma.announcement.create({
      data: {
        org_id: orgId,
        title, body,
        department_id: deptId ? String(deptId) : null,
        scheduled_for: scheduledFor,
        created_by: req.user!.sub,
      },
    });

    if (isScheduledForLater(scheduledFor, new Date())) {
      return ok(res, { announcement, count: 0, message: 'Announcement scheduled' });
    }

    const count = await publishAnnouncement(announcement);
    const published = await prisma.announcement.findUnique({ where: { id: announcement.id } });
    ok(res, { announcement: published ?? announcement, count, message: 'Announcement sent' });
  } catch (e) { next(e); }
});

// GET /performance/announcements — published announcements targeted at the
// caller (org-wide + their department), each with my_read_at.
performanceRouter.get('/announcements', async (req, res, next) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { department_id: true },
    });

    const audience: Array<Record<string, unknown>> = [{ department_id: null }];
    if (me?.department_id) audience.push({ department_id: me.department_id });

    const announcements = await prisma.announcement.findMany({
      where: { org_id: req.user!.org_id, published_at: { not: null }, OR: audience },
      include: {
        author:   { select: { id: true, name: true, avatar_url: true } },
        receipts: { where: { user_id: req.user!.sub }, select: { read_at: true } },
      },
      orderBy: { published_at: 'desc' },
      take: 50,
    });

    ok(res, announcements.map(({ receipts, ...a }) => ({
      ...a,
      my_read_at: receipts[0]?.read_at ?? null,
    })));
  } catch (e) { next(e); }
});

// POST /performance/announcements/:id/read — the reader's receipt.
// Idempotent: re-reading keeps the original read_at.
performanceRouter.post('/announcements/:id/read', async (req, res, next) => {
  try {
    const announcement = await prisma.announcement.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
      select: { id: true, published_at: true },
    });
    if (!announcement) throw new NotFoundError('Announcement');
    if (!announcement.published_at) {
      throw new AppError('Announcement is not published yet', 400, 'NOT_PUBLISHED');
    }

    const receipt = await prisma.announcementReceipt.upsert({
      where: {
        announcement_id_user_id: {
          announcement_id: announcement.id,
          user_id: req.user!.sub,
        },
      },
      update: {},
      create: { announcement_id: announcement.id, user_id: req.user!.sub },
    });
    ok(res, receipt);
  } catch (e) { next(e); }
});

// GET /performance/announcements/:id/receipts — sender-side read stats.
performanceRouter.get('/announcements/:id/receipts', requirePermission('org.announcements.send'), async (req, res, next) => {
  try {
    const announcement = await prisma.announcement.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
    });
    if (!announcement) throw new NotFoundError('Announcement');

    const [receipts, audienceCount] = await Promise.all([
      prisma.announcementReceipt.findMany({
        where: { announcement_id: announcement.id },
        include: { user: { select: { id: true, name: true, avatar_url: true, department: true } } },
        orderBy: { read_at: 'desc' },
      }),
      prisma.user.count({
        where: announcementAudienceWhere(req.user!.org_id, announcement.department_id) as never,
      }),
    ]);

    ok(res, {
      announcement,
      read_count: receipts.length,
      audience_count: audienceCount,
      readers: receipts.map(r => ({ ...r.user, read_at: r.read_at })),
    });
  } catch (e) { next(e); }
});

// GET /performance/reviews
performanceRouter.get('/reviews', requirePermission('performance.view'), async (req, res, next) => {
  try {
    const { month, year, department } = req.query as Record<string, string>;
    let m: number, y: number;
    if (month && month.includes('-')) {
      const parts = month.split('-').map(Number);
      if (parts[0] > 12) { y = parts[0]; m = parts[1]; }  // YYYY-MM
      else                { m = parts[0]; y = parts[1]; }  // MM-YYYY
    } else {
      m = parseInt(month || String(new Date().getMonth() + 1));
      y = parseInt(year  || String(new Date().getFullYear()));
    }

    const where: Record<string, unknown> = { org_id: req.user!.org_id, period_month: m, period_year: y };
    if (!req.permissions?.has('employees.view')) {
      const team = await prisma.user.findMany({ where: { manager_id: req.user!.sub }, select: { id: true } });
      where.user_id = { in: team.map(u => u.id) };
    }

    // Ensure reviews exist for all active users
    const users = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, is_active: true, role: 'employee', deleted_at: null, ...(!req.permissions?.has('employees.view') ? { manager_id: req.user!.sub } : {}) },
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
    // Map DB field names to the shape the web client expects
    ok(res, reviews.map(r => ({
      ...r,
      score:    r.manager_rating ?? 0,
      comments: r.notes ?? '',
      month:    `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    })));
  } catch (e) { next(e); }
});

// GET /performance/reviews/me — employee sees their own reviews (no role restriction)
performanceRouter.get('/reviews/me', async (req, res, next) => {
  try {
    const reviews = await prisma.performanceReview.findMany({
      where: { user_id: req.user!.sub },
      include: { reviewer: { select: { id: true, name: true } } },
      orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
      take: 24,
    });
    ok(res, reviews);
  } catch (e) { next(e); }
});

// POST /performance/reviews/:userId
performanceRouter.post('/reviews/:userId', requirePermission('performance.manage'), async (req, res, next) => {
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
      where: { user_id: String(req.params.userId), period_month: m, period_year: y, org_id: req.user!.org_id },
    });
    if (!review) throw new NotFoundError('Review');
    if (review.submitted_at) throw new AppError('Review already submitted and locked', 400);

    const attendanceScore = await calcAttendanceScore(String(req.params.userId), m, y);
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
    // In-app notification to the reviewed employee
    const { createNotification } = await import('../services/notifications');
    createNotification({
      userId: updated.user.id, orgId: req.user!.org_id,
      type: 'review_submitted',
      title: 'Performance review submitted',
      body: `Your performance review for ${m}/${y} has been submitted by ${updated.reviewer?.name || 'your manager'}`,
      actionType: 'performance_review', actionId: updated.id,
    }).catch(console.error);

    ok(res, { ...updated, score: updated.manager_rating ?? 0, comments: updated.notes ?? '' });
  } catch (e) { next(e); }
});

// GET /performance/goals
performanceRouter.get('/goals', async (req, res, next) => {
  try {
    const requestedUserId = req.query.user_id as string | undefined;
    const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    const isManager = perms.has('performance.view');
    let goalWhere: Record<string, unknown>;
    if (isManager && !requestedUserId) {
      // Manager with no filter — return all goals across the org
      goalWhere = { user: { org_id: req.user!.org_id } };
    } else {
      const userId = (requestedUserId && isManager) ? requestedUserId : req.user!.sub;
      if (userId !== req.user!.sub) {
        const target = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id } });
        if (!target) throw new NotFoundError('User');
      }
      goalWhere = { user_id: userId };
    }
    const goals = await prisma.performanceGoal.findMany({
      where: goalWhere,
      include: { user: { select: { id: true, name: true, department: true } } },
      orderBy: { created_at: 'desc' },
    });
    ok(res, goals);
  } catch (e) { next(e); }
});

// POST /performance/goals
performanceRouter.post('/goals', requirePermission('performance.manage'), async (req, res, next) => {
  try {
    const { user_id, review_id, title, description, weight, target_date } = req.body;
    if (!user_id || !review_id || !title || !weight) throw new ValidationError('Missing required fields');

    // Target user and review must both belong to the caller's org
    const [targetUser, review] = await Promise.all([
      prisma.user.findFirst({ where: { id: user_id, org_id: req.user!.org_id }, select: { id: true } }),
      prisma.performanceReview.findFirst({ where: { id: review_id, org_id: req.user!.org_id }, select: { id: true } }),
    ]);
    if (!targetUser) throw new NotFoundError('User');
    if (!review)     throw new NotFoundError('Performance review');

    const goal = await prisma.performanceGoal.create({
      data: { user_id, review_id, title, description, weight, target_date: target_date ? new Date(target_date) : null },
      include: { user: { select: { id: true, name: true, department: true } } },
    });

    // In-app notification to the employee
    const { createNotification } = await import('../services/notifications');
    createNotification({
      userId: user_id, orgId: req.user!.org_id,
      type: 'goal_assigned',
      title: 'New goal assigned',
      body: `A new goal has been assigned to you: ${title}`,
      actionType: 'performance_goal', actionId: goal.id,
    }).catch(console.error);

    ok(res, goal, 201);
  } catch (e) { next(e); }
});

// PUT /performance/goals/:id
performanceRouter.put('/goals/:id', requirePermission('performance.manage'), async (req, res, next) => {
  try {
    const { title, description, weight, target_date, completion } = req.body;
    const data: Record<string, unknown> = {};
    if (title       !== undefined) data.title       = title;
    if (description !== undefined) data.description = description;
    if (weight      !== undefined) data.weight      = weight;
    if (completion  !== undefined) data.completion  = completion;
    if (target_date !== undefined) data.target_date = target_date ? new Date(target_date) : null;

    // Org scoping: the goal's subject must belong to the caller's org
    const existing = await prisma.performanceGoal.findFirst({
      where: { id: String(req.params.id), user: { org_id: req.user!.org_id } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError('Goal');

    const goal = await prisma.performanceGoal.update({ where: { id: existing.id }, data });
    ok(res, goal);
  } catch (e) { next(e); }
});

// ─── AI: GET /performance/reviews/:userId/insights ────
performanceRouter.get('/reviews/:userId/insights', requirePermission('performance.view'), async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AppError('AI service not configured', 503, 'AI_NOT_CONFIGURED');

    const user = await prisma.user.findFirst({
      where: { id: String(req.params.userId), org_id: req.user!.org_id },
      select: { id: true, name: true, department: true, job_title: true },
    });
    if (!user) throw new NotFoundError('User');

    const [reviews, goals, attendance] = await Promise.all([
      prisma.performanceReview.findMany({
        where: { user_id: user.id },
        orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
        take: 6,
      }),
      prisma.performanceGoal.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
      prisma.attendanceRecord.findMany({
        where: { user_id: user.id, date: { gte: new Date(new Date().setMonth(new Date().getMonth() - 3)) } },
      }),
    ]);

    const attendanceSummary = {
      total_days: attendance.length,
      present: attendance.filter(r => ['in','out'].includes(r.status)).length,
      late: attendance.filter(r => r.status === 'late').length,
      absent: attendance.filter(r => r.status === 'absent').length,
      remote: attendance.filter(r => r.status === 'remote').length,
    };

    const axios = (await import('axios')).default;
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 768,
        messages: [{
          role: 'user',
          content: `Generate a professional monthly performance insight summary for this employee. Be constructive, specific, and actionable.\n\nEmployee: ${user.name}\nRole: ${user.job_title || 'N/A'}\nDepartment: ${user.department || 'N/A'}\n\nReview history (last 6 months):\n${JSON.stringify(reviews.map(r => ({ month: `${r.period_year}-${r.period_month}`, rating: r.manager_rating, score: r.overall_score, notes: r.notes })), null, 2)}\n\nGoals (recent):\n${JSON.stringify(goals.map(g => ({ title: g.title, weight: g.weight, completion: g.completion })), null, 2)}\n\nAttendance (last 90 days): ${JSON.stringify(attendanceSummary)}\n\nProvide: 1) Performance trend summary (2-3 sentences), 2) Strengths (2 bullet points), 3) Areas to improve (2 bullet points), 4) Recommended action for manager (1-2 sentences).`,
        }],
      },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
    );
    ok(res, {
      user: { id: user.id, name: user.name },
      insights: aiRes.data.content?.[0]?.text,
      data_summary: { reviews: reviews.length, goals: goals.length, attendance: attendanceSummary },
    });
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
analyticsRouter.use(authenticate, requirePermission('analytics.view'));

/** Attendance dates are stored as local calendar dates; resolve them using the branch on the record. */
async function getAnalyticsAttendance(orgId: string, now: Date, days: number) {
  const [org, users] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: orgId }, select: { timezone: true } }),
    prisma.user.findMany({
      where: { org_id: orgId, is_active: true, deleted_at: null },
      select: { id: true, primary_location: { select: { timezone: true } } },
    }),
  ]);
  if (!users.length) return { orgTimezone: org?.timezone || 'UTC', users, records: [] };
  const fallbackTimezone = org?.timezone || 'UTC';
  const todayKeys = users.map(user => localAttendanceDate(now, user.primary_location?.timezone || fallbackTimezone));
  const min = todayKeys.reduce((a, b) => a < b ? a : b);
  const max = todayKeys.reduce((a, b) => a > b ? a : b);
  const records = await prisma.attendanceRecord.findMany({
    where: {
      org_id: orgId,
      user_id: { in: users.map(user => user.id) },
      date: { gte: new Date(`${shiftAttendanceDateKey(min, -(days - 1) - 2)}T00:00:00.000Z`), lte: new Date(`${shiftAttendanceDateKey(max, 2)}T00:00:00.000Z`) },
    },
    include: {
      location: { select: { timezone: true } },
      user: { select: { name: true, primary_location: { select: { timezone: true } } } },
    },
  });
  return { orgTimezone: fallbackTimezone, users, records };
}

// GET /analytics/overview
analyticsRouter.get('/overview', async (req, res, next) => {
  try {
    const now = new Date();
    const { orgTimezone, users, records } = await getAnalyticsAttendance(req.user!.org_id, now, 1);
    const todayRecords = records.filter(record => {
      const timezone = record.location?.timezone || record.user?.primary_location?.timezone || orgTimezone;
      return attendanceDateKey(record.date) === localAttendanceDate(now, timezone);
    });

    const counts = todayRecords.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    ok(res, {
      checked_in:    counts['in'] || 0,
      checked_out:   counts['out'] || 0,
      remote:        counts['remote'] || 0,
      on_leave:      counts['leave'] || 0,
      absent:        counts['absent'] || 0,
      total_employees: users.length,
      updated_at:    new Date(),
    });
  } catch (e) { next(e); }
});

// GET /analytics/attendance-trend
analyticsRouter.get('/attendance-trend', async (req, res, next) => {
  try {
    const requestedDays = Number.parseInt((req.query.days as string) || '30', 10);
    const days = Number.isFinite(requestedDays) ? Math.min(90, Math.max(1, requestedDays)) : 30;
    const now = new Date();
    const { orgTimezone, records } = await getAnalyticsAttendance(req.user!.org_id, now, days);
    const orgToday = localAttendanceDate(now, orgTimezone);
    const buckets = Array.from({ length: days }, () => ({ present: 0, absent: 0, late: 0, total: 0 }));
    for (const record of records) {
      const timezone = record.location?.timezone || record.user?.primary_location?.timezone || orgTimezone;
      const localToday = localAttendanceDate(now, timezone);
      const offset = attendanceDateOffset(localToday, attendanceDateKey(record.date));
      if (offset > 0 || offset < -(days - 1)) continue;
      const bucket = buckets[days - 1 + offset];
      bucket.total++;
      if (['in', 'out', 'late', 'remote'].includes(record.status)) bucket.present++;
      if (record.status === 'absent') bucket.absent++;
      if (record.status === 'late') bucket.late++;
    }
    const data = buckets.map((bucket, index) => ({
      date: shiftAttendanceDateKey(orgToday, index - (days - 1)),
      present: bucket.present,
      absent: bucket.absent,
      late: bucket.late,
      rate: Math.round((bucket.present / Math.max(1, bucket.total)) * 100),
    }));
    ok(res, data);
  } catch (e) { next(e); }
});

// GET /analytics/late-arrivals
analyticsRouter.get('/late-arrivals', async (req, res, next) => {
  try {
    const now = new Date();
    const { orgTimezone, records } = await getAnalyticsAttendance(req.user!.org_id, now, 32);
    const currentMonthLate = records.filter(record => {
      if (record.status !== 'late') return false;
      const timezone = record.location?.timezone || record.user?.primary_location?.timezone || orgTimezone;
      const localToday = localAttendanceDate(now, timezone);
      return attendanceDateKey(record.date) >= localAttendanceMonthStart(now, timezone) && attendanceDateKey(record.date) <= localToday;
    });
    const grouped = currentMonthLate.reduce((acc: Record<string, { name: string; count: number }>, r) => {
      const name = r.user?.name || r.user_id;
      if (!acc[name]) acc[name] = { name, count: 0 };
      acc[name].count++;
      return acc;
    }, {});
    ok(res, Object.values(grouped).sort((a, b) => b.count - a.count));
  } catch (e) { next(e); }
});

// GET /analytics/payroll-cost
analyticsRouter.get('/payroll-cost', requirePermission('analytics.advanced'), async (req, res, next) => {
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


// ─── AI: GET /analytics/anomalies ─────────────────────
analyticsRouter.get('/anomalies', requirePermission('analytics.advanced'), async (req, res, next) => {
  try {
    const days = 30;
    const since = new Date(); since.setDate(since.getDate() - days);

    const records = await prisma.attendanceRecord.findMany({
      where: { org_id: req.user!.org_id, date: { gte: since } },
      include: { user: { select: { id: true, name: true, department: true } } },
      orderBy: { date: 'desc' },
    });

    const summary = records.slice(0, 200).map(r => ({
      user: r.user?.name,
      dept: r.user?.department,
      date: r.date,
      status: r.status,
      hours: r.hours_worked,
      overtime: r.overtime_hours,
      check_in: r.check_in_at,
      ip: r.ip_detected,
    }));

    const anomalies = await generateGeminiJson<unknown[]>(
      `You are an HR analytics assistant. Review the following attendance records from the last 30 days. Identify evidence-based anomalies such as unusually long hours, IP inconsistencies, excessive overtime, or repeated absences. Do not infer misconduct from a single anomaly. Return only a JSON array with fields user_name, type, severity (low, medium, high), description, and date. If nothing is unusual, return [].\n\nAttendance data:\n${JSON.stringify(summary)}`,
      2048,
    );
    if (!Array.isArray(anomalies)) throw new AppError('Gemini returned an invalid attendance analysis.', 502, 'AI_INVALID_RESPONSE');
    ok(res, { anomalies, analyzed_records: records.length, period_days: days });
  } catch (e) { next(e); }
});

// ─── AI: GET /analytics/payroll-anomalies ─────────────
analyticsRouter.get('/payroll-anomalies', requirePermission('analytics.advanced'), async (req, res, next) => {
  try {
    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id },
      include: { user: { select: { name: true, department: true } } },
      orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
      take: 100,
    });

    const summary = records.map(r => ({
      user: r.user?.name,
      dept: r.user?.department,
      month: `${r.period_year}-${String(r.period_month).padStart(2,'0')}`,
      regular_hours: Number(r.regular_hours),
      overtime_hours: Number(r.overtime_hours),
      gross_pay: Number(r.gross_pay),
      adjustments: Number(r.manual_adjustment),
    }));

    const anomalies = await generateGeminiJson<unknown[]>(
      `You are an HR payroll analytics assistant. Review these payroll records for unusual overtime, significant deviations from the same employee's history, unexplained adjustments, or clear peer outliers. Use only evidence in the data and avoid unsupported conclusions. Return only a JSON array with user_name, type, severity (low, medium, high), description, and month. If no anomalies are supported, return [].\n\nPayroll data:\n${JSON.stringify(summary)}`,
      2048,
    );
    if (!Array.isArray(anomalies)) throw new AppError('Gemini returned an invalid payroll analysis.', 502, 'AI_INVALID_RESPONSE');
    ok(res, { anomalies });
  } catch (e) { next(e); }
});

// ─── AI: POST /analytics/chat ─────────────────────────
// HR assistant chatbot — natural language queries
analyticsRouter.post('/chat', async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AppError('AI service not configured', 503, 'AI_NOT_CONFIGURED');

    const { message } = req.body;
    if (!message) throw new ValidationError('message required');

    const today = startOfDay(new Date());
    const [todayRecords, totalUsers, pendingLeaves, recentPayroll] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: { org_id: req.user!.org_id, date: today },
        include: { user: { select: { name: true, department: true } } },
      }),
      prisma.user.count({ where: { org_id: req.user!.org_id, is_active: true, deleted_at: null } }),
      prisma.leaveRequest.count({ where: { org_id: req.user!.org_id, status: 'pending' } }),
      prisma.payrollRecord.findMany({
        where: { org_id: req.user!.org_id, status: 'processed' },
        orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
        take: 5,
        include: { user: { select: { name: true } } },
      }),
    ]);

    const context = {
      today: today.toISOString().split('T')[0],
      total_employees: totalUsers,
      pending_leaves: pendingLeaves,
      today_attendance: {
        present: todayRecords.filter(r => ['in','out','late'].includes(r.status)).length,
        remote: todayRecords.filter(r => r.status === 'remote').length,
        absent: todayRecords.filter(r => r.status === 'absent').length,
        on_leave: todayRecords.filter(r => r.status === 'leave').length,
        who_is_in: todayRecords.filter(r => r.status === 'in').map(r => r.user?.name),
      },
      recent_payroll_totals: recentPayroll.map(p => ({
        user: p.user?.name,
        month: `${p.period_year}-${p.period_month}`,
        gross: Number(p.gross_pay),
      })),
    };

    const axios = (await import('axios')).default;
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: `You are an HR assistant for the Attenda attendance management system. Answer questions about employees, attendance, payroll, and leave based on the provided context. Be concise and helpful. Today's context: ${JSON.stringify(context)}`,
        messages: [{ role: 'user', content: message }],
      },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
    );
    ok(res, { reply: aiRes.data.content?.[0]?.text });
  } catch (e) { next(e); }
});

// ─── ORG SETTINGS ─────────────────────────────────────
export const orgRouter = Router();
orgRouter.use(authenticate);

// Explicit safe column list for org settings responses. NEVER add:
// - wa_access_token (WhatsApp Cloud API bearer token — GET /org/whatsapp
//   returns it redacted; returning it here undoes that)
// - admin_notes / features_override / billing_email / contact_* /
//   company_size (platform-admin internal columns)
// - wa_* config (managed via the dedicated /org/whatsapp endpoints)
// - office_ips / office_ssids (managed via the gated office-network endpoints)
const ORG_SETTINGS_SELECT = {
  id: true, name: true, logo_url: true, timezone: true, currency: true,
  payroll_day: true, monthly_pay_divisor: true, tax_rate: true, pension_rate: true, late_threshold: true,
  heartbeat_grace_mins: true, gap_forgiveness_mins: true,
  leave_accrual: true, late_policy: true,
  plan: true, status: true, subscription_status: true,
  trial_started_at: true, trial_ends_at: true, seats_limit: true,
  totp_required: true, address: true, phone: true, website: true,
  industry: true, registration_number: true, created_at: true,
} as const;

// GET /org/settings — gated on org.settings.view, matching the web nav
// (the Settings page is only shown to holders of this key; the TrialBanner
// swallow-errors on 403 by design).
orgRouter.get('/settings', requirePermission('org.settings.view'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({
      where: { id: req.user!.org_id },
      select: ORG_SETTINGS_SELECT,
    });
    if (!org) throw new NotFoundError('Organisation');
    ok(res, org);
  } catch (e) { next(e); }
});

// PUT /org/settings
orgRouter.put('/settings', requirePermission('org.settings.update'), validate({ body: orgSettingsSchema }), async (req, res, next) => {
  try {
    const {
      name, timezone, currency, payroll_day, monthly_pay_divisor, tax_rate, pension_rate, late_threshold, totp_required,
      logo_url, address, phone, website, industry, registration_number,
    } = req.body;
    const data: Record<string, unknown> = {};
    if (name       !== undefined) data.name        = name;
    if (timezone   !== undefined) data.timezone    = timezone;
    if (currency   !== undefined) data.currency    = currency;
    if (totp_required !== undefined) data.totp_required = Boolean(totp_required);
    if (logo_url   !== undefined) data.logo_url    = logo_url || null;
    if (address    !== undefined) data.address     = address || null;
    if (phone      !== undefined) data.phone       = phone || null;
    if (website    !== undefined) data.website     = website || null;
    if (industry   !== undefined) data.industry    = industry || null;
    if (registration_number !== undefined) data.registration_number = registration_number || null;
    if (payroll_day !== undefined) {
      const day = parseInt(payroll_day);
      if (day < 1 || day > 28) throw new ValidationError('payroll_day must be between 1 and 28');
      data.payroll_day = day;
    }
    if (monthly_pay_divisor !== undefined) {
      const divisor = parseInt(monthly_pay_divisor);
      if (divisor < 20 || divisor > 31) throw new ValidationError('monthly_pay_divisor must be between 20 and 31 days');
      data.monthly_pay_divisor = divisor;
    }
    if (tax_rate !== undefined) {
      const rate = parseFloat(tax_rate);
      if (rate < 0 || rate > 100) throw new ValidationError('tax_rate must be between 0 and 100');
      data.tax_rate = rate;
    }
    if (pension_rate !== undefined) {
      const rate = parseFloat(pension_rate);
      if (rate < 0 || rate > 100) throw new ValidationError('pension_rate must be between 0 and 100');
      data.pension_rate = rate;
    }
    if (late_threshold !== undefined) {
      const mins = parseInt(late_threshold);
      if (mins < 0 || mins > 120) throw new ValidationError('late_threshold must be between 0 and 120 minutes');
      data.late_threshold = mins;
    }
    if (req.body.heartbeat_grace_mins !== undefined) {
      const mins = parseInt(req.body.heartbeat_grace_mins);
      if (mins < 10 || mins > 120) throw new ValidationError('heartbeat_grace_mins must be between 10 and 120');
      data.heartbeat_grace_mins = mins;
    }
    // JSON policy columns: explicit null clears the policy (DbNull), a value replaces it.
    if (req.body.leave_accrual !== undefined) {
      data.leave_accrual = req.body.leave_accrual === null ? Prisma.DbNull : req.body.leave_accrual;
    }
    if (req.body.late_policy !== undefined) {
      data.late_policy = req.body.late_policy === null ? Prisma.DbNull : req.body.late_policy;
    }
    if (req.body.gap_forgiveness_mins !== undefined) {
      const mins = parseInt(req.body.gap_forgiveness_mins);
      if (mins < 0 || mins > 90) throw new ValidationError('gap_forgiveness_mins must be between 0 and 90');
      data.gap_forgiveness_mins = mins;
    }
    const updated = await prisma.$transaction(async tx => {
      const org = await tx.organisation.update({ where: { id: req.user!.org_id }, data, select: ORG_SETTINGS_SELECT });
      if (data.monthly_pay_divisor !== undefined) await tx.payrollRecord.updateMany({ where: { org_id: req.user!.org_id, status: 'draft' }, data: { inputs_stale: true } });
      if (typeof data.timezone === 'string') await tx.location.updateMany({ where: { org_id: req.user!.org_id, is_main: true }, data: { timezone: data.timezone } });
      return org;
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// GET /org/audit-logs — append-only trail of pay-affecting mutations
// ─── GET /org/whos-out ─────────────────────────────────
// Who's away for a date range (default: today): approved leave, remote
// sessions and public holidays in one read model. Open to all org members —
// it powers the team calendar on both clients.
orgRouter.get('/whos-out', async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const fromStr = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from ?? '')) ? String(req.query.from) : today;
    const toStr = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to ?? '')) ? String(req.query.to) : fromStr;
    const from = new Date(`${fromStr}T00:00:00.000Z`);
    const to = new Date(`${toStr}T00:00:00.000Z`);
    if (to < from) throw new ValidationError('to must be on or after from');
    if ((to.getTime() - from.getTime()) / 86_400_000 > 62) throw new ValidationError('Range cannot exceed 62 days');

    const USER_SEL = { select: { id: true, name: true, avatar_url: true, department: true } };
    const [leave, remote, holidaySet] = await Promise.all([
      prisma.leaveRequest.findMany({
        where: { org_id: req.user!.org_id, status: 'approved', start_date: { lte: to }, end_date: { gte: from } },
        select: { id: true, leave_type: true, start_date: true, end_date: true, is_half_day: true, half_day_period: true, user: USER_SEL },
        orderBy: { start_date: 'asc' },
      }),
      prisma.remoteSession.findMany({
        where: {
          status: 'approved',
          user: { org_id: req.user!.org_id },
          attendance: { date: { gte: from, lte: to } },
        },
        select: { id: true, user: USER_SEL, attendance: { select: { date: true } } },
      }),
      import('../services/holidays').then(m => m.holidaySetForRange(req.user!.org_id, from, to)),
    ]);

    ok(res, {
      from: fromStr,
      to: toStr,
      on_leave: leave,
      remote: remote.map(r => ({ id: r.id, user: r.user, date: r.attendance?.date ?? null })),
      holidays: [...holidaySet].sort(),
    });
  } catch (e) { next(e); }
});

orgRouter.get('/audit-logs', requirePermission('org.audit.view'), async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (req.query.action)      where.action = String(req.query.action);
    if (req.query.entity_type) where.entity_type = String(req.query.entity_type);

    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string';
    const parsedLimit = Number.parseInt(String(req.query.limit ?? (cursorMode ? '50' : '50')), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 50;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const position = cursorMode && cursor ? decodeCursor(cursor, where) : null;
    if (cursorMode && cursor && !position) {
      const anchor = await prisma.auditLog.findFirst({
        where: { ...where, id: cursor },
        select: { id: true },
      });
      if (!anchor) throw new ValidationError('Invalid audit log cursor');
    }

    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1')));
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: position ? { ...where, AND: [keysetAfter(position, 'created_at')] } : where,
        ...(cursorMode
          ? (!position && cursor ? { cursor: { id: cursor }, skip: 1 } : {})
          : { skip: (page - 1) * limit }),
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: cursorMode ? limit + 1 : limit,
      }),
      cursorMode ? Promise.resolve(0) : prisma.auditLog.count({ where }),
    ]);

    const hasMore = cursorMode && rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    // Resolve actor names in one query
    const actorIds = [...new Set(items.map(i => i.actor_id))];
    const actors = await prisma.user.findMany({
      where: { id: { in: actorIds } }, select: { id: true, name: true },
    });
    const nameById = new Map(actors.map(a => [a.id, a.name]));
    const outputItems = items.map(i => ({ ...i, actor_name: nameById.get(i.actor_id) ?? 'Unknown' }));
    ok(res, cursorMode
      ? { items: outputItems, next_cursor: hasMore && items.length ? encodeCursor({ at: items[items.length - 1].created_at, id: items[items.length - 1].id }, where) : null, has_more: hasMore, limit }
      : { items: outputItems, total, page, limit });
  } catch (e) { next(e); }
});

orgRouter.get('/outbox/dead-letters', requirePermission('org.events.replay'), async (req, res, next) => {
  try {
    const events = await prisma.outboxEvent.findMany({
      where: { org_id: req.user!.org_id, dead_lettered_at: { not: null } },
      orderBy: { dead_lettered_at: 'desc' }, take: 100,
      select: { id: true, event_type: true, entity_type: true, entity_id: true, attempts: true, last_error: true, created_at: true, dead_lettered_at: true },
    });
    ok(res, events);
  } catch (error) { next(error); }
});

orgRouter.post('/outbox/dead-letters/:id/replay', requirePermission('org.events.replay'), async (req, res, next) => {
  try {
    const event = await prisma.outboxEvent.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, dead_lettered_at: { not: null } } });
    if (!event) throw new NotFoundError('Dead-lettered event');
    await prisma.$transaction(async tx => {
      await tx.outboxEvent.update({ where: { id: event.id }, data: { attempts: 0, last_error: null, dead_lettered_at: null, next_attempt_at: new Date(), claimed_at: null, claim_token: null } });
      await tx.auditLog.create({ data: { org_id: req.user!.org_id, actor_id: req.user!.sub, action: 'outbox_event_replayed', entity_type: 'outbox_event', entity_id: event.id, before: { attempts: event.attempts, last_error: event.last_error, event_type: event.event_type }, after: { status: 'queued_for_replay' } } });
    });
    ok(res, { id: event.id, status: 'queued_for_replay' }, 202);
  } catch (error) { next(error); }
});

// GET /org/my-ip — returns the client IP as seen by the server (useful for network auto-detection)
orgRouter.get('/my-ip', authenticate, async (req, res, _next) => {
  const fwd = req.headers['x-forwarded-for'];
  const raw = fwd
    ? (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim()
    : req.socket?.remoteAddress || req.ip || '';
  ok(res, { ip: raw.replace(/^::ffff:/, '') });
});

// GET /org/office-ips
orgRouter.get('/office-ips', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    ok(res, { ips: org?.office_ips || [], ssids: org?.office_ssids || [] });
  } catch (e) { next(e); }
});

orgRouter.get('/wifi-attendance', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: req.user!.org_id }, select: { wifi_auto_checkin_enabled: true, wifi_auto_checkout_enabled: true, heartbeat_grace_mins: true, gap_forgiveness_mins: true } });
    ok(res, org);
  } catch (e) { next(e); }
});

orgRouter.put('/wifi-attendance', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const { wifi_auto_checkin_enabled, wifi_auto_checkout_enabled, heartbeat_grace_mins, gap_forgiveness_mins } = req.body;
    if (typeof wifi_auto_checkin_enabled !== 'boolean' || typeof wifi_auto_checkout_enabled !== 'boolean' || !Number.isInteger(heartbeat_grace_mins) || heartbeat_grace_mins < 10 || heartbeat_grace_mins > 120 || !Number.isInteger(gap_forgiveness_mins) || gap_forgiveness_mins < 0 || gap_forgiveness_mins > 90) throw new ValidationError('Invalid Wi-Fi attendance settings');
    const org = await prisma.organisation.update({ where: { id: req.user!.org_id }, data: { wifi_auto_checkin_enabled, wifi_auto_checkout_enabled, heartbeat_grace_mins, gap_forgiveness_mins } });
    if (!wifi_auto_checkout_enabled) await prisma.attendanceRecord.updateMany({ where: { org_id: req.user!.org_id, check_out_at: null, ip_checkout_pending_at: { not: null } }, data: { ip_checkout_pending_at: null } });
    ok(res, { wifi_auto_checkin_enabled: org.wifi_auto_checkin_enabled, wifi_auto_checkout_enabled: org.wifi_auto_checkout_enabled, heartbeat_grace_mins: org.heartbeat_grace_mins, gap_forgiveness_mins: org.gap_forgiveness_mins });
  } catch (e) { next(e); }
});

orgRouter.get('/attendance-security', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: req.user!.org_id }, select: { attendance_security: true } });
    const policy = (org.attendance_security && typeof org.attendance_security === 'object' ? org.attendance_security : {}) as Record<string, unknown>;
    ok(res, {
      geofence_enabled: policy.geofence_enabled === true,
      latitude: typeof policy.latitude === 'number' ? policy.latitude : null,
      longitude: typeof policy.longitude === 'number' ? policy.longitude : null,
      radius_m: typeof policy.radius_m === 'number' ? policy.radius_m : 150,
      enforcement: policy.enforcement === 'block' ? 'block' : 'warn',
      require_location: policy.require_location === true,
      block_mock_location: policy.block_mock_location === true,
    });
  } catch (e) { next(e); }
});

orgRouter.put('/attendance-security', requirePermission('org.office.update'), validate({ body: attendanceSecuritySchema }), async (req, res, next) => {
  try {
    const before = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { attendance_security: true } });
    const updated = await prisma.organisation.update({
      where: { id: req.user!.org_id },
      data: { attendance_security: req.body },
      select: { attendance_security: true },
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'org.attendance_security.update', entityType: 'organisation', entityId: req.user!.org_id,
      before: before?.attendance_security, after: updated.attendance_security,
    });
    ok(res, updated.attendance_security);
  } catch (e) { next(e); }
});

// PUT /org/office-ips
orgRouter.put('/office-ips', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const { ips } = req.body;
    if (!Array.isArray(ips)) throw new ValidationError('ips must be an array');
    if (ips.length > 20) throw new ValidationError('Maximum 20 entries allowed');
    const updated = await prisma.$transaction(async tx => {
      const org = await tx.organisation.update({ where: { id: req.user!.org_id }, data: { office_ips: ips } });
      await tx.location.updateMany({ where: { org_id: req.user!.org_id, is_main: true }, data: { office_ips: ips } });
      return org;
    });
    ok(res, { ips: updated.office_ips, ssids: updated.office_ssids || [] });
  } catch (e) { next(e); }
});

// PUT /org/office-ssids
orgRouter.put('/office-ssids', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const { ssids } = req.body;
    if (!Array.isArray(ssids)) throw new ValidationError('ssids must be an array');
    if (ssids.length > 10) throw new ValidationError('Maximum 10 SSIDs allowed');
    const trimmed = ssids.map((s: string) => s.trim()).filter(Boolean);
    const updated = await prisma.$transaction(async tx => {
      const org = await tx.organisation.update({ where: { id: req.user!.org_id }, data: { office_ssids: trimmed } });
      await tx.location.updateMany({ where: { org_id: req.user!.org_id, is_main: true }, data: { office_ssids: trimmed } });
      return org;
    });
    ok(res, { ips: updated.office_ips, ssids: updated.office_ssids || [] });
  } catch (e) { next(e); }
});

// GET /org/whatsapp
orgRouter.get('/whatsapp', requirePermission('org.whatsapp.update'), requireOrgFeature('whatsapp'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    ok(res, {
      enabled:         org?.wa_enabled ?? false,
      phone_number_id: org?.wa_phone_number_id || '',
      access_token:    org?.wa_access_token ? '***redacted***' : null,
      groups:          (org?.wa_groups as unknown[]) || [],
      events:          org?.wa_events || {},
      dept_groups:     org?.wa_dept_groups ?? {},
      monthly_message_limit: org?.wa_monthly_message_limit ?? null,
      alert_threshold_percent: org?.wa_alert_threshold_percent ?? 80,
      estimated_cost_per_message: org?.wa_estimated_cost_per_message === null || org?.wa_estimated_cost_per_message === undefined ? null : Number(org.wa_estimated_cost_per_message),
      currency: org?.currency ?? 'USD',
    });
  } catch (e) { next(e); }
});

orgRouter.get('/whatsapp/usage', requirePermission('whatsapp.logs.view'), requireOrgFeature('whatsapp'), async (req, res, next) => {
  try {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError('Month must use YYYY-MM format.');
    const usage = await (await import('../services/whatsappUsage')).getWhatsAppUsage(req.user!.org_id, month);
    ok(res, usage);
  } catch (e) { next(e); }
});

// PUT /org/whatsapp
orgRouter.put('/whatsapp', requirePermission('org.whatsapp.update'), requireOrgFeature('whatsapp'), idempotency, async (req, res, next) => {
  try {
    const { enabled, phone_number_id, access_token, groups, events, dept_groups } = req.body;
    const data: Record<string, unknown> = {};
    if (enabled         !== undefined) data.wa_enabled         = enabled;
    if (phone_number_id !== undefined) data.wa_phone_number_id = phone_number_id;
    if (groups          !== undefined) data.wa_groups          = groups;
    if (events          !== undefined) data.wa_events          = events;
    if (dept_groups     !== undefined) data.wa_dept_groups     = dept_groups;
    if (access_token && access_token !== '***redacted***') data.wa_access_token = access_token;
    if (Object.prototype.hasOwnProperty.call(req.body, 'monthly_message_limit')) {
      const limit = req.body.monthly_message_limit;
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000_000)) throw new ValidationError('Monthly message limit must be between 1 and 10,000,000, or empty for no limit.');
      data.wa_monthly_message_limit = limit;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'alert_threshold_percent')) {
      const threshold = req.body.alert_threshold_percent;
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new ValidationError('Usage alert threshold must be a whole percentage from 1 to 100.');
      data.wa_alert_threshold_percent = threshold;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'estimated_cost_per_message')) {
      const rate = req.body.estimated_cost_per_message;
      if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 10_000)) throw new ValidationError('Estimated message cost must be a non-negative number, or empty if unknown.');
      data.wa_estimated_cost_per_message = rate === null ? null : rate === undefined ? undefined : new Prisma.Decimal(rate);
    }
    await prisma.organisation.update({ where: { id: req.user!.org_id }, data });
    ok(res, { message: 'WhatsApp settings saved' });
  } catch (e) { next(e); }
});

// POST /org/whatsapp/test
orgRouter.post('/whatsapp/test', requirePermission('whatsapp.test'), requireOrgFeature('whatsapp'), async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    if (!org?.wa_phone_number_id || !org?.wa_access_token) {
      throw new ValidationError('WhatsApp is not configured. Save credentials first.');
    }
    const { notify } = await import('../services/whatsapp');
    const groups = (org.wa_groups as { id: string; phone: string; name: string }[] || []);
    if (groups.length === 0) throw new ValidationError('No WhatsApp groups configured.');
    let sent = 0;
    for (const group of groups) {
      await notify({ orgId: req.user!.org_id, event: 'check_in', recipientType: 'group', recipientId: group.phone, message: `✅ *Attenda Test Message*\nWhatsApp notifications are working correctly.\n_Sent by ${req.user!.name}_` }).catch(console.error);
      sent++;
    }
    ok(res, { sent, message: `Test message sent to ${sent} group${sent !== 1 ? 's' : ''}.` });
  } catch (e) { next(e); }
});

// GET /org/whatsapp/logs
orgRouter.get('/whatsapp/logs', requirePermission('whatsapp.logs.view'), requireOrgFeature('whatsapp'), async (req, res, next) => {
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
orgRouter.get('/qr-code', requirePermission('org.qr.manage'), async (req, res, next) => {
  try {
    const { generateOrgQrCode } = await import('../services/qrcode');
    const result = await generateOrgQrCode(req.user!.org_id);
    ok(res, result);
  } catch (e) { next(e); }
});

// POST /org/qr-code/regenerate
orgRouter.post('/qr-code/regenerate', requirePermission('org.qr.manage'), async (req, res, next) => {
  try {
    const { generateOrgQrCode } = await import('../services/qrcode');
    const result = await generateOrgQrCode(req.user!.org_id);
    ok(res, result);
  } catch (e) { next(e); }
});

// ─── REPORTS (analytics/generate + download) ──────────
export const reportsRouter = Router();
reportsRouter.use(authenticate, requirePermission('reports.export'));

reportsRouter.get('/schedules', async (req, res, next) => {
  try {
    const rows = await prisma.reportSchedule.findMany({
      where: { org_id: req.user!.org_id, owner_id: req.user!.sub },
      include: { runs: { orderBy: { created_at: 'desc' }, take: 1 } },
      orderBy: { created_at: 'desc' },
    });
    ok(res, rows);
  } catch (e) { next(e); }
});

reportsRouter.get('/runs', async (req, res, next) => {
  try {
    const rows = await prisma.reportRun.findMany({
      where: { org_id: req.user!.org_id, owner_id: req.user!.sub },
      orderBy: { created_at: 'desc' }, take: 50,
    });
    ok(res, rows);
  } catch (e) { next(e); }
});

reportsRouter.get('/custom/definitions', async (req, res, next) => {
  try {
    const rows = await prisma.reportDefinition.findMany({
      where: { org_id: req.user!.org_id, owner_id: req.user!.sub },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, definition: true, created_at: true, updated_at: true },
    });
    ok(res, rows);
  } catch (error) { next(error); }
});

reportsRouter.post('/custom/definitions', idempotency, validate({ body: customReportDefinitionSchema }), async (req, res, next) => {
  try {
    const existing = await prisma.reportDefinition.findFirst({ where: { org_id: req.user!.org_id, owner_id: req.user!.sub, name: req.body.name } });
    if (existing) throw new AppError('A saved custom report already uses that name.', 409, 'REPORT_DEFINITION_NAME_EXISTS');
    const row = await prisma.reportDefinition.create({ data: {
      org_id: req.user!.org_id, owner_id: req.user!.sub, name: req.body.name,
      definition: req.body.definition as Prisma.InputJsonValue,
    }, select: { id: true, name: true, definition: true, created_at: true, updated_at: true } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'report.definition.create', entityType: 'report_definition', entityId: row.id, after: { name: row.name } });
    created(res, row);
  } catch (error) { next(error); }
});

reportsRouter.put('/custom/definitions/:id', idempotency, validate({ body: customReportDefinitionSchema }), async (req, res, next) => {
  try {
    const existing = await prisma.reportDefinition.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, owner_id: req.user!.sub } });
    if (!existing) throw new NotFoundError('Saved custom report');
    const nameConflict = await prisma.reportDefinition.findFirst({ where: { org_id: req.user!.org_id, owner_id: req.user!.sub, name: req.body.name, id: { not: existing.id } }, select: { id: true } });
    if (nameConflict) throw new AppError('A saved custom report already uses that name.', 409, 'REPORT_DEFINITION_NAME_EXISTS');
    const row = await prisma.reportDefinition.update({ where: { id: existing.id }, data: { name: req.body.name, definition: req.body.definition as Prisma.InputJsonValue }, select: { id: true, name: true, definition: true, created_at: true, updated_at: true } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'report.definition.update', entityType: 'report_definition', entityId: row.id, before: { name: existing.name }, after: { name: row.name } });
    ok(res, row);
  } catch (error) { next(error); }
});

reportsRouter.delete('/custom/definitions/:id', idempotency, async (req, res, next) => {
  try {
    const existing = await prisma.reportDefinition.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, owner_id: req.user!.sub } });
    if (!existing) throw new NotFoundError('Saved custom report');
    await prisma.reportDefinition.delete({ where: { id: existing.id } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'report.definition.delete', entityType: 'report_definition', entityId: existing.id, before: { name: existing.name } });
    ok(res, { deleted: true });
  } catch (error) { next(error); }
});

reportsRouter.post('/schedules', idempotency, async (req, res, next) => {
  try {
    const { name, type, params, frequency, local_time, recipients = [] } = req.body as Record<string, any>;
    if (typeof name !== 'string' || !name.trim() || name.length > 160) throw new ValidationError('A report name (up to 160 characters) is required');
    if (!['attendance', 'leave', 'payroll', 'performance', 'custom'].includes(type)) throw new ValidationError('Unsupported report type');
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) throw new ValidationError('Frequency must be daily, weekly, or monthly');
    if (typeof local_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(local_time)) throw new ValidationError('Use a valid local time in HH:MM format');
    if (type === 'payroll' && !req.permissions?.has('payroll.view')) throw new ForbiddenError('Payroll report access required');
    const reportParams = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
    if (type === 'custom') {
      const definitionId = typeof reportParams.definition_id === 'string' ? reportParams.definition_id : '';
      const definition = definitionId ? await prisma.reportDefinition.findFirst({ where: { id: definitionId, org_id: req.user!.org_id, owner_id: req.user!.sub } }) : null;
      if (!definition) throw new ValidationError('Choose one of your saved custom report setups.');
      if (reportParams.relative_period !== true) throw new ValidationError('Custom report schedules must use a relative period.');
      const parsed = customReportSchema.safeParse(definition.definition);
      if (!parsed.success) throw new ValidationError('The saved custom report setup is invalid. Update or recreate it before scheduling.');
      const allowed = await import('../services/customReports').then(module => module.canGenerateCustomDataset(parsed.data.dataset, req.permissions ?? new Set()));
      if (!allowed) throw new ForbiddenError(`Permission to export the ${parsed.data.dataset} dataset is required.`);
    } else {
      (await import('../services/reportGeneration')).validateScheduledReportParameters(type, reportParams);
    }
    if (Array.isArray(recipients) && recipients.some((email: unknown) => typeof email !== 'string' || email.toLowerCase() !== req.user!.email.toLowerCase())) {
      throw new ValidationError('Scheduled reports can only be delivered to your own account email');
    }
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { timezone: true } });
    if (!org) throw new NotFoundError('Organisation');
    const schedule = await prisma.reportSchedule.create({ data: {
      org_id: req.user!.org_id, owner_id: req.user!.sub, name: name.trim(), report_type: type,
      params: reportParams as Prisma.InputJsonValue,
      frequency, local_time, timezone: org.timezone || 'UTC', recipients: [req.user!.email],
      next_run_at: (await import('../services/scheduledReports')).nextReportRun(frequency, local_time, org.timezone || 'UTC', new Date()),
    } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'report.schedule.create', entityType: 'report_schedule', entityId: schedule.id, after: { name: schedule.name, report_type: schedule.report_type, frequency: schedule.frequency } });
    created(res, schedule);
  } catch (e) { next(e); }
});

reportsRouter.patch('/schedules/:id', idempotency, async (req, res, next) => {
  try {
    const existing = await prisma.reportSchedule.findFirst({ where: { id: req.params.id as string, org_id: req.user!.org_id, owner_id: req.user!.sub } });
    if (!existing) throw new NotFoundError('Report schedule');
    const status = req.body.status;
    if (status !== 'active' && status !== 'paused') throw new ValidationError('Status must be active or paused');
    const nextRun = status === 'active' && existing.next_run_at <= new Date()
      ? (await import('../services/scheduledReports')).nextReportRun(existing.frequency, existing.local_time, existing.timezone, new Date())
      : existing.next_run_at;
    const updated = await prisma.reportSchedule.update({ where: { id: existing.id }, data: { status, next_run_at: nextRun } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'report.schedule.update', entityType: 'report_schedule', entityId: updated.id, before: { status: existing.status }, after: { status: updated.status } });
    ok(res, updated);
  } catch (e) { next(e); }
});

reportsRouter.delete('/schedules/:id', idempotency, async (req, res, next) => {
  try {
    const existing = await prisma.reportSchedule.findFirst({ where: { id: req.params.id as string, org_id: req.user!.org_id, owner_id: req.user!.sub } });
    if (!existing) throw new NotFoundError('Report schedule');
    await prisma.reportSchedule.delete({ where: { id: existing.id } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'report.schedule.delete', entityType: 'report_schedule', entityId: existing.id, before: { name: existing.name, report_type: existing.report_type } });
    ok(res, { deleted: true });
  } catch (e) { next(e); }
});

reportsRouter.post('/custom', idempotency, validate({ body: customReportSchema }), async (req, res, next) => {
  try {
    const result = await (await import('../services/customReports')).generateCustomReport(
      req.user!.org_id,
      req.user!.sub,
      req.permissions ?? new Set<string>(),
      req.body,
    );
    ok(res, result);
  } catch (e) { next(e); }
});

reportsRouter.post('/:type', idempotency, async (req, res, next) => {
  try {
    const type = String(req.params.type);
    if (type === 'payroll' && !req.permissions?.has('payroll.view')) throw new ForbiddenError('Payroll report access required');
    const result = await (await import('../services/reportGeneration')).generateReport(
      req.user!.org_id, type, req.body as Record<string, unknown>,
    );
    ok(res, result);
  } catch (e) { next(e); }
});
