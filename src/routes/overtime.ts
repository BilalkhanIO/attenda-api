import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { ok, created, noContent, ValidationError, NotFoundError } from '../utils/response';

const router = Router();
router.use(authenticate);

// ─── GET /overtime/rules ───────────────────────────────
router.get('/rules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await prisma.overtimeRule.findMany({
      where: { org_id: req.user!.org_id },
      orderBy: [{ priority: 'asc' }, { threshold_hours: 'asc' }],
    });
    ok(res, rules);
  } catch (e) { next(e); }
});

// ─── POST /overtime/rules ──────────────────────────────
router.post('/rules', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, rule_type, threshold_hours, multiplier, priority } = req.body;
    if (!name || !rule_type || !threshold_hours || !multiplier) {
      throw new ValidationError('name, rule_type, threshold_hours, multiplier required');
    }
    if (!['daily', 'weekly', 'seventh_day'].includes(rule_type)) {
      throw new ValidationError('rule_type must be daily | weekly | seventh_day');
    }
    const rule = await prisma.overtimeRule.create({
      data: {
        org_id: req.user!.org_id,
        name,
        rule_type,
        threshold_hours: parseFloat(threshold_hours),
        multiplier: parseFloat(multiplier),
        priority: priority ? +priority : 1,
      },
    });
    created(res, rule);
  } catch (e) { next(e); }
});

// ─── PUT /overtime/rules/:id ───────────────────────────
router.put('/rules/:id', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await prisma.overtimeRule.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
    });
    if (!rule) throw new NotFoundError('OvertimeRule');
    const { name, rule_type, threshold_hours, multiplier, priority, is_active } = req.body;
    const updated = await prisma.overtimeRule.update({
      where: { id: rule.id },
      data: {
        name,
        rule_type,
        threshold_hours: threshold_hours ? parseFloat(threshold_hours) : undefined,
        multiplier: multiplier ? parseFloat(multiplier) : undefined,
        priority: priority ? +priority : undefined,
        is_active,
      },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /overtime/rules/:id ───────────────────────
router.delete('/rules/:id', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await prisma.overtimeRule.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
    });
    if (!rule) throw new NotFoundError('OvertimeRule');
    await prisma.overtimeRule.delete({ where: { id: rule.id } });
    noContent(res);
  } catch (e) { next(e); }
});

// ─── GET /overtime/summary ─────────────────────────────
router.get('/summary', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { week_start } = req.query;
    const start = week_start
      ? new Date(week_start as string)
      : (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; })();
    const end = new Date(start); end.setDate(end.getDate() + 7);

    const records = await prisma.attendanceRecord.findMany({
      where: { org_id: req.user!.org_id, date: { gte: start, lt: end } },
      include: { user: { select: { id: true, name: true, department: true, hourly_rate: true } } },
    });

    // Group by user and sum hours
    const byUser = new Map<string, { user: typeof records[0]['user']; records: typeof records; totalHours: number; overtimeHours: number }>();
    for (const r of records) {
      const key = r.user_id;
      if (!byUser.has(key)) byUser.set(key, { user: r.user, records: [], totalHours: 0, overtimeHours: 0 });
      const entry = byUser.get(key)!;
      entry.records.push(r);
      const hours = Number(r.net_hours_worked ?? r.hours_worked ?? 0);
      entry.totalHours += hours;
    }

    const rules = await prisma.overtimeRule.findMany({
      where: { org_id: req.user!.org_id, is_active: true },
      orderBy: { priority: 'asc' },
    });
    const weeklyRule = rules.find(r => r.rule_type === 'weekly') ?? { threshold_hours: 40, multiplier: 1.5 };

    const summary = Array.from(byUser.values()).map(({ user, totalHours }) => {
      const threshold = Number(weeklyRule.threshold_hours);
      const overtimeHours = Math.max(0, totalHours - threshold);
      const regularHours = Math.min(totalHours, threshold);
      const rate = Number(user.hourly_rate);
      const regularPay = regularHours * rate;
      const overtimePay = overtimeHours * rate * Number(weeklyRule.multiplier);
      return {
        user_id: user.id,
        name: user.name,
        department: user.department,
        total_hours: +totalHours.toFixed(2),
        regular_hours: +regularHours.toFixed(2),
        overtime_hours: +overtimeHours.toFixed(2),
        regular_pay: +regularPay.toFixed(2),
        overtime_pay: +overtimePay.toFixed(2),
      };
    });

    ok(res, summary);
  } catch (e) { next(e); }
});

export default router;
