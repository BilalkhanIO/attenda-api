// @ts-nocheck
import { Router } from 'express';
import { authenticate, requireOrgFeature, requirePermission } from '../middleware/auth';
import { resolveUserPermissions } from '../services/authorization';
import { ok, NotFoundError, ValidationError, AppError } from '../utils/response';
import { startOfDay } from '../utils/auth';
import prisma from '../utils/prisma';

// ─── PERFORMANCE ──────────────────────────────────────
export const performanceRouter = Router();
performanceRouter.use(authenticate);

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
      where: { user_id: req.params.userId, period_month: m, period_year: y, org_id: req.user!.org_id },
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
    const goal = await prisma.performanceGoal.update({ where: { id: req.params.id }, data });
    ok(res, goal);
  } catch (e) { next(e); }
});

// ─── AI: GET /performance/reviews/:userId/insights ────
performanceRouter.get('/reviews/:userId/insights', requirePermission('performance.view'), async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AppError('AI service not configured', 503, 'AI_NOT_CONFIGURED');

    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AppError('AI service not configured', 503, 'AI_NOT_CONFIGURED');

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

    const axios = (await import('axios')).default;
    const res2 = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are an HR analytics AI. Analyze this attendance data from the last 30 days and identify anomalies: unusual hours, IP address inconsistencies, sudden schedule changes, suspicious patterns, excessive overtime, or concerning absenteeism.\n\nData:\n${JSON.stringify(summary, null, 2)}\n\nReturn a JSON array of anomalies with fields: user_name, type (e.g. "excessive_overtime", "ip_mismatch", "unusual_hours", "frequent_absence"), severity ("low","medium","high"), description, date.`,
        }],
      },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
    );
    const text = res2.data.content?.[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const anomalies = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    ok(res, { anomalies, analyzed_records: records.length, period_days: days });
  } catch (e) { next(e); }
});

// ─── AI: GET /analytics/payroll-anomalies ─────────────
analyticsRouter.get('/payroll-anomalies', requirePermission('analytics.advanced'), async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AppError('AI service not configured', 503, 'AI_NOT_CONFIGURED');

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

    const axios = (await import('axios')).default;
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are an HR payroll AI. Analyze this payroll data and flag anomalies: unusual overtime, significant pay deviations from the same employee's history, unexplained manual adjustments, or outliers compared to peers.\n\nData:\n${JSON.stringify(summary, null, 2)}\n\nReturn a JSON array with fields: user_name, type, severity ("low","medium","high"), description, month.`,
        }],
      },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
    );
    const text = aiRes.data.content?.[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    ok(res, { anomalies: jsonMatch ? JSON.parse(jsonMatch[0]) : [] });
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

// GET /org/settings
orgRouter.get('/settings', async (req, res, next) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    if (!org) throw new NotFoundError('Organisation');
    ok(res, org);
  } catch (e) { next(e); }
});

// PUT /org/settings
orgRouter.put('/settings', requirePermission('org.settings.update'), async (req, res, next) => {
  try {
    const {
      name, timezone, currency, payroll_day, tax_rate, pension_rate, late_threshold, totp_required,
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
    if (req.body.gap_forgiveness_mins !== undefined) {
      const mins = parseInt(req.body.gap_forgiveness_mins);
      if (mins < 0 || mins > 90) throw new ValidationError('gap_forgiveness_mins must be between 0 and 90');
      data.gap_forgiveness_mins = mins;
    }
    const updated = await prisma.organisation.update({ where: { id: req.user!.org_id }, data });
    ok(res, updated);
  } catch (e) { next(e); }
});

// GET /org/audit-logs — append-only trail of pay-affecting mutations
orgRouter.get('/audit-logs', requirePermission('org.settings.update'), async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1')));
    const limit = Math.min(100, parseInt(String(req.query.limit ?? '50')));
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (req.query.action)      where.action = String(req.query.action);
    if (req.query.entity_type) where.entity_type = String(req.query.entity_type);

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where, orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Resolve actor names in one query
    const actorIds = [...new Set(items.map(i => i.actor_id))];
    const actors = await prisma.user.findMany({
      where: { id: { in: actorIds } }, select: { id: true, name: true },
    });
    const nameById = new Map(actors.map(a => [a.id, a.name]));
    ok(res, {
      items: items.map(i => ({ ...i, actor_name: nameById.get(i.actor_id) ?? 'Unknown' })),
      total, page, limit,
    });
  } catch (e) { next(e); }
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

// PUT /org/office-ips
orgRouter.put('/office-ips', requirePermission('org.office.update'), async (req, res, next) => {
  try {
    const { ips } = req.body;
    if (!Array.isArray(ips)) throw new ValidationError('ips must be an array');
    if (ips.length > 20) throw new ValidationError('Maximum 20 entries allowed');
    const updated = await prisma.organisation.update({ where: { id: req.user!.org_id }, data: { office_ips: ips } });
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
    const updated = await prisma.organisation.update({ where: { id: req.user!.org_id }, data: { office_ssids: trimmed } });
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
    });
  } catch (e) { next(e); }
});

// PUT /org/whatsapp
orgRouter.put('/whatsapp', requirePermission('org.whatsapp.update'), requireOrgFeature('whatsapp'), async (req, res, next) => {
  try {
    const { enabled, phone_number_id, access_token, groups, events, dept_groups } = req.body;
    const data: Record<string, unknown> = {};
    if (enabled         !== undefined) data.wa_enabled         = enabled;
    if (phone_number_id !== undefined) data.wa_phone_number_id = phone_number_id;
    if (groups          !== undefined) data.wa_groups          = groups;
    if (events          !== undefined) data.wa_events          = events;
    if (dept_groups     !== undefined) data.wa_dept_groups     = dept_groups;
    if (access_token && access_token !== '***redacted***') data.wa_access_token = access_token;
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
