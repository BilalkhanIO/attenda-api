import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { AppError, created, NotFoundError, ok, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import { createNotification, emitOrgEvent } from '../services/notifications';
import { submitShiftAvailability } from '../services/shift-availability';
import { fromZonedTime } from 'date-fns-tz';
import { idempotency } from '../middleware/idempotency';
import { scopedEmployeeIds } from '../services/locationScope';
import { getScheduleIssues } from '../services/scheduleIssues';

const router = Router();
router.use(authenticate);

function dateOnly(value: unknown, name: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${name} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ValidationError(`${name} is invalid`);
  return date;
}
function dayKey(date: Date) { return date.toISOString().slice(0, 10); }
function addDays(date: Date, days: number) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }
function weekEnd(start: Date) { return addDays(start, 6); }
function isMonday(date: Date) { return date.getUTCDay() === 1; }
function toMinutes(value: string) { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
function wallMinutes(shift: { start_time: string; end_time: string }) { const duration = toMinutes(shift.end_time) - toMinutes(shift.start_time); return duration <= 0 ? duration + 1440 : duration; }
function shiftMinutes(shift: { start_time: string; end_time: string; breaks?: Array<{ break_minutes: number; is_paid: boolean }> }) {
  let duration = toMinutes(shift.end_time) - toMinutes(shift.start_time);
  if (duration <= 0) duration += 1440;
  return Math.max(0, duration - (shift.breaks ?? []).filter(b => !b.is_paid).reduce((sum, b) => sum + b.break_minutes, 0));
}
function event(orgId: string, actorId: string, eventType: string, entityType: string, entityId: string | null, details: unknown = {}) {
  return prisma.shiftScheduleEvent.create({ data: { org_id: orgId, actor_id: actorId, event_type: eventType, entity_type: entityType, entity_id: entityId, details: JSON.parse(JSON.stringify(details)) } });
}

// Employee availability is request-based and remains separate from shift assignments.
router.get('/availability/me', async (req, res, next) => {
  try {
    const items = await prisma.shiftAvailability.findMany({ where: { org_id: req.user!.org_id, user_id: req.user!.sub }, orderBy: { created_at: 'desc' }, take: 100 });
    ok(res, items);
  } catch (error) { next(error); }
});

router.post('/availability', idempotency, async (req, res, next) => {
  try {
    const item = await submitShiftAvailability(req.user!.sub, req.user!.org_id, req.body ?? {});
    await event(req.user!.org_id, req.user!.sub, 'availability_submitted', 'availability', item.id, { kind: item.kind, date: item.date, weekday: item.weekday });
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    created(res, item);
  } catch (error) { next(error); }
});

router.delete('/availability/:id', idempotency, async (req, res, next) => {
  try {
    const item = await prisma.shiftAvailability.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, user_id: req.user!.sub, status: 'pending' } });
    if (!item) throw new NotFoundError('Pending availability request');
    await prisma.shiftAvailability.delete({ where: { id: item.id } });
    await event(req.user!.org_id, req.user!.sub, 'availability_cancelled', 'availability', item.id);
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    res.status(204).send();
  } catch (error) { next(error); }
});

router.get('/availability', requirePermission('shifts.availability.manage'), async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const from = typeof req.query.from === 'string' ? dateOnly(req.query.from, 'from') : undefined;
    const to = typeof req.query.to === 'string' ? dateOnly(req.query.to, 'to') : undefined;
    const items = await prisma.shiftAvailability.findMany({ where: { org_id: req.user!.org_id, ...(status ? { status } : {}), ...(from || to ? { OR: [ ...(from ? [{ date: { gte: from } }, { starts_on: { gte: from } }, { ends_on: null }] : []), ...(to ? [{ date: { lte: to } }, { starts_on: { lte: to } }] : []) ] } : {}) }, include: { user: { select: { id: true, name: true, email: true, department: true } } }, orderBy: [{ status: 'asc' }, { created_at: 'asc' }], take: 500 });
    ok(res, items);
  } catch (error) { next(error); }
});

router.put('/availability/:id/review', requirePermission('shifts.availability.manage'), idempotency, async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) throw new ValidationError('status must be approved or rejected');
    const item = await prisma.shiftAvailability.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!item) throw new NotFoundError('Availability request');
    if (item.status !== 'pending') throw new AppError('This availability request has already been reviewed', 409, 'ALREADY_REVIEWED');
    const reviewNote = req.body?.review_note == null ? null : String(req.body.review_note).trim();
    if (status === 'rejected' && !reviewNote) throw new ValidationError('A reason is required when rejecting availability');
    const updated = await prisma.shiftAvailability.update({ where: { id: item.id }, data: { status, reviewed_by: req.user!.sub, reviewed_at: new Date(), review_note: reviewNote } });
    await event(req.user!.org_id, req.user!.sub, `availability_${status}`, 'availability', item.id, { employee_id: item.user_id, note: reviewNote });
    await createNotification({ userId: item.user_id, orgId: req.user!.org_id, type: 'shift_availability_decision', title: `Availability ${status}`, body: status === 'approved' ? 'Your availability request was approved.' : `Your availability request was declined: ${reviewNote}`, actionType: 'shift_availability', actionId: item.id });
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    ok(res, updated);
  } catch (error) { next(error); }
});

router.get('/coverage', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const rules = await prisma.shiftCoverageRule.findMany({ where: { org_id: req.user!.org_id }, include: { shift: true }, orderBy: [{ weekday: 'asc' }, { shift: { name: 'asc' } }] });
    ok(res, rules);
  } catch (error) { next(error); }
});

router.put('/coverage', requirePermission('shifts.coverage.manage'), idempotency, async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.rules) || req.body.rules.length > 500) throw new ValidationError('rules must be an array of at most 500 entries');
    const rules = req.body.rules.map((rule: any) => {
      if (typeof rule.shift_id !== 'string' || !Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6 || !Number.isInteger(rule.required_count) || rule.required_count < 0 || rule.required_count > 100) throw new ValidationError('Each coverage rule needs a valid shift, weekday, and required count (0–100)');
      return { org_id: req.user!.org_id, shift_id: rule.shift_id, weekday: rule.weekday, required_count: rule.required_count, department: String(rule.department ?? '').trim().slice(0, 100) };
    });
    const shiftIds = [...new Set<string>(rules.map((rule: { shift_id: string }) => rule.shift_id))];
    const shifts = await prisma.shift.findMany({ where: { org_id: req.user!.org_id, id: { in: shiftIds } }, select: { id: true } });
    if (shifts.length !== shiftIds.length) throw new NotFoundError('Shift template');
    await prisma.$transaction(async tx => {
      await tx.shiftCoverageRule.deleteMany({ where: { org_id: req.user!.org_id } });
      if (rules.length) await tx.shiftCoverageRule.createMany({ data: rules, skipDuplicates: true });
    });
    const saved = await prisma.shiftCoverageRule.findMany({ where: { org_id: req.user!.org_id }, include: { shift: true }, orderBy: [{ weekday: 'asc' }, { shift: { name: 'asc' } }] });
    await event(req.user!.org_id, req.user!.sub, 'coverage_rules_updated', 'coverage', null, { rule_count: saved.length });
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    ok(res, saved);
  } catch (error) { next(error); }
});

router.get('/issues', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const from = typeof req.query.week_start === 'string' ? dateOnly(req.query.week_start, 'week_start') : (() => { const d = new Date(); const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7)); return monday; })();
    ok(res, await getScheduleIssues(req.user!.org_id, req.user!.sub, req.permissions ?? new Set(), from));
  } catch (error) { next(error); }
});

router.get('/workload', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const from = dateOnly(String(req.query.week_start ?? new Date().toISOString().slice(0, 10)), 'week_start');
    const to = weekEnd(from);
    const employeeIds = await scopedEmployeeIds(req.user!.org_id, req.user!.sub, req.permissions ?? new Set(), 'shifts.manage');
    const assignments = await prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: to }, shift: { org_id: req.user!.org_id }, ...(employeeIds ? { user_id: { in: employeeIds } } : {}) }, include: { shift: { include: { breaks: true } }, user: { select: { id: true, name: true, department: true } } }, orderBy: { date: 'asc' } });
    const grouped = new Map<string, { user: { id: string; name: string; department: string | null }; assignments: number; minutes: number; days: Set<string> }>();
    for (const item of assignments) {
      const current = grouped.get(item.user_id) ?? { user: item.user, assignments: 0, minutes: 0, days: new Set<string>() };
      current.assignments++; current.minutes += shiftMinutes(item.shift); current.days.add(dayKey(item.date)); grouped.set(item.user_id, current);
    }
    ok(res, [...grouped.values()].map(value => ({ user: value.user, assignments: value.assignments, days_worked: value.days.size, scheduled_hours: Math.round(value.minutes / 6) / 10 })).sort((a, b) => b.scheduled_hours - a.scheduled_hours));
  } catch (error) { next(error); }
});

// Aggregate-only labor planning. Individual pay rates are never returned to managers.
router.get('/cost', requirePermission('labor_cost.view'), async (req, res, next) => {
  try {
    const from = dateOnly(String(req.query.week_start ?? new Date().toISOString().slice(0, 10)), 'week_start');
    if (!isMonday(from)) throw new ValidationError('week_start must be a Monday');
    const to = weekEnd(from);
    const employeeIds = await scopedEmployeeIds(req.user!.org_id, req.user!.sub, req.permissions ?? new Set(), 'labor_cost.manage');
    const [assignments, storedBudgets, org] = await Promise.all([prisma.shiftAssignment.findMany({
      where: { date: { gte: from, lte: to }, shift: { org_id: req.user!.org_id }, ...(employeeIds ? { user_id: { in: employeeIds } } : {}) },
      include: { location: { select: { id: true, name: true } }, shift: { include: { breaks: true } }, user: { select: {
        id: true, department: true, hourly_rate: true, primary_location_id: true,
        primary_location: { select: { name: true } },
        pay_rates: { where: { effective_from: { lte: to }, OR: [{ effective_to: null }, { effective_to: { gte: from } }] }, orderBy: { effective_from: 'desc' } },
      } } },
      orderBy: [{ user_id: 'asc' }, { date: 'asc' }, { created_at: 'asc' }],
    }), prisma.laborBudget.findMany({ where: { org_id: req.user!.org_id, week_start: from }, include: { location: { select: { id: true, name: true } } } }), prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { currency: true, monthly_pay_divisor: true } })]);
    const currency = org?.currency ?? 'PKR';
    const visibleLocationIds = new Set(assignments.map(item => item.location_id ?? item.user.primary_location_id).filter((id): id is string => !!id));
    const visibleDepartments = new Set(assignments.map(item => item.user.department).filter((value): value is string => !!value));
    // Scoped managers only see budgets for locations/departments represented
    // by their visible assignments; org-wide budget figures remain payroll-like.
    const budgets = employeeIds === null ? storedBudgets : storedBudgets.filter(item =>
      !!item.location_id && visibleLocationIds.has(item.location_id)
      && (!item.department || visibleDepartments.has(item.department)),
    );
    const spentByDay = new Map<string, { date: string; department: string | null; location_id: string | null; location_name: string | null; scheduled_hours: number; projected_cost: number; published_cost: number; draft_cost: number }>();
    const userMinutes = new Map<string, number>();
    let overtimeExposureMinutes = 0;
    let projectedCost = 0;
    let publishedCost = 0;
    let draftCost = 0;
    for (const assignment of assignments) {
      const minutes = shiftMinutes(assignment.shift);
      const cumulative = userMinutes.get(assignment.user_id) ?? 0;
      // 48 hours is a planning warning baseline only; statutory rule packs are
      // still required before using this estimate for compliance or payroll.
      const overtimeMinutes = Math.max(0, cumulative + minutes - 48 * 60) - Math.max(0, cumulative - 48 * 60);
      userMinutes.set(assignment.user_id, cumulative + minutes);
      overtimeExposureMinutes += overtimeMinutes;
      const baseHours = minutes / 60;
      const overtimeHours = overtimeMinutes / 60;
      const effectiveRate = assignment.user.pay_rates.find(rate => rate.effective_from <= assignment.date && (!rate.effective_to || rate.effective_to >= assignment.date));
      const rateAmount = effectiveRate ? Number(effectiveRate.amount) : Number(assignment.user.hourly_rate);
      const rateBasis = effectiveRate?.basis ?? 'hourly';
      const monthlyDivisor = Math.max(1, Number(org?.monthly_pay_divisor) || 26);
      const rate = rateBasis === 'daily' ? rateAmount / 8 : rateBasis === 'monthly' ? rateAmount / monthlyDivisor / 8 : rateAmount;
      const multiplier = Number(assignment.shift.overtime_multiplier) || 1.5;
      const cost = rate * (baseHours + (assignment.shift.overtime_enabled ? overtimeHours * Math.max(0, multiplier - 1) : 0));
      const date = dayKey(assignment.date);
      const department = assignment.user.department;
      const locationId = assignment.location_id ?? assignment.user.primary_location_id;
      const locationName = assignment.location?.name ?? assignment.user.primary_location?.name ?? null;
      const key = `${date}:${department ?? ''}:${locationId ?? ''}`;
      const row = spentByDay.get(key) ?? { date, department, location_id: locationId, location_name: locationName, scheduled_hours: 0, projected_cost: 0, published_cost: 0, draft_cost: 0 };
      row.scheduled_hours += baseHours;
      row.projected_cost += cost;
      if (assignment.is_published) row.published_cost += cost; else row.draft_cost += cost;
      spentByDay.set(key, row);
      projectedCost += cost;
      if (assignment.is_published) publishedCost += cost; else draftCost += cost;
    }
    const orgBudget = budgets.find(item => item.department === '' && !item.location_id);
    const budgetRows = budgets.map(item => {
      const matchingSpend = [...spentByDay.values()].filter(row =>
        (!item.location_id || row.location_id === item.location_id)
        && (!item.department || row.department === item.department),
      ).reduce((sum, row) => sum + row.projected_cost, 0);
      const amount = Number(item.amount);
      const comparable = item.currency === currency;
      const variance = comparable ? Math.round((matchingSpend - amount) * 100) / 100 : null;
      return { department: item.department || null, location_id: item.location_id, location_name: item.location?.name ?? null, amount, projected_cost: Math.round(matchingSpend * 100) / 100, variance, over_budget: comparable && matchingSpend > amount, currency: item.currency, currency_mismatch: !comparable };
    });
    const scopedOverBudget = budgetRows.some(item => !item.currency_mismatch && item.over_budget);
    ok(res, {
      week_start: dayKey(from), week_end: dayKey(to), currency,
      totals: { projected_cost: Math.round(projectedCost * 100) / 100, published_cost: Math.round(publishedCost * 100) / 100, draft_cost: Math.round(draftCost * 100) / 100, scheduled_hours: Math.round(assignments.reduce((sum, item) => sum + shiftMinutes(item.shift), 0) / 6) / 10, overtime_exposure_hours: Math.round(overtimeExposureMinutes / 6) / 10 },
      budget: budgets.length ? {
        amount: orgBudget ? Number(orgBudget.amount) : null,
        variance: orgBudget ? Math.round((projectedCost - Number(orgBudget.amount)) * 100) / 100 : null,
        over_budget: orgBudget ? projectedCost > Number(orgBudget.amount) : scopedOverBudget,
        rows: budgetRows,
      } : null,
      days: [...spentByDay.values()].map(row => ({ ...row, scheduled_hours: Math.round(row.scheduled_hours * 10) / 10, projected_cost: Math.round(row.projected_cost * 100) / 100, published_cost: Math.round(row.published_cost * 100) / 100, draft_cost: Math.round(row.draft_cost * 100) / 100 })),
    });
  } catch (error) { next(error); }
});

router.put('/budget', requirePermission('labor_cost.manage'), idempotency, async (req, res, next) => {
  try {
    const weekStartDate = dateOnly(req.body?.week_start, 'week_start');
    if (!isMonday(weekStartDate)) throw new ValidationError('week_start must be a Monday');
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) throw new ValidationError('amount must be a non-negative valid amount');
    const department = typeof req.body?.department === 'string' ? req.body.department.trim() : '';
    if (department && department.length > 100) throw new ValidationError('department is too long');
    const locationId = typeof req.body?.location_id === 'string' && req.body.location_id.trim() ? req.body.location_id.trim() : null;
    if (locationId) {
      const location = await prisma.location.findFirst({ where: { id: locationId, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
      if (!location) throw new ValidationError('Choose an active location in this organization');
    }
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { currency: true } });
    const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : org?.currency ?? 'PKR';
    if (!/^[A-Z]{3,10}$/.test(currency)) throw new ValidationError('currency must be a valid currency code');
    if (org?.currency && currency !== org.currency) throw new ValidationError(`Budget currency must match the organization currency (${org.currency})`);
    const where = locationId
      ? { org_id_week_start_department_location_id: { org_id: req.user!.org_id, week_start: weekStartDate, department, location_id: locationId } }
      : { org_id_week_start_department: { org_id: req.user!.org_id, week_start: weekStartDate, department } };
    const budget = await prisma.laborBudget.upsert({
      where,
      create: { org_id: req.user!.org_id, location_id: locationId, week_start: weekStartDate, department, amount, currency, created_by: req.user!.sub, updated_by: req.user!.sub },
      update: { amount, currency, updated_by: req.user!.sub },
    });
    await event(req.user!.org_id, req.user!.sub, 'labor_budget_updated', 'labor_budget', budget.id, { week_start: dayKey(weekStartDate), department: department || null, location_id: locationId, currency });
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    ok(res, budget);
  } catch (error) { next(error); }
});

router.post('/copy-week', requirePermission('shifts.assign'), idempotency, async (req, res, next) => {
  try {
    const from = dateOnly(req.body?.from_week_start, 'from_week_start');
    const to = dateOnly(req.body?.to_week_start, 'to_week_start');
    if (!isMonday(from) || !isMonday(to)) throw new ValidationError('Both dates must be Mondays');
    if (to <= from || to > addDays(from, 370)) throw new ValidationError('Choose a later week within the next 53 weeks');
    const sourceEnd = weekEnd(from); const offset = Math.round((to.getTime() - from.getTime()) / 86400000);
    const employeeIds = await scopedEmployeeIds(req.user!.org_id, req.user!.sub, req.permissions ?? new Set(), 'shifts.manage');
    const source = await prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: sourceEnd }, shift: { org_id: req.user!.org_id }, ...(employeeIds ? { user_id: { in: employeeIds } } : {}) }, select: { user_id: true, shift_id: true, date: true, location_id: true } });
    const candidates = source.map(item => ({ user_id: item.user_id, shift_id: item.shift_id, date: addDays(item.date, offset), location_id: item.location_id }));
    const existing = candidates.length ? await prisma.shiftAssignment.findMany({ where: { user_id: { in: [...new Set(candidates.map(item => item.user_id))] }, date: { gte: to, lte: weekEnd(to) } }, select: { user_id: true, date: true } }) : [];
    const occupied = new Set(existing.map(item => `${item.user_id}:${dayKey(item.date)}`));
    const eligible = candidates.filter(item => !occupied.has(`${item.user_id}:${dayKey(item.date)}`));
    const result = eligible.length ? await prisma.shiftAssignment.createMany({ data: eligible, skipDuplicates: true }) : { count: 0 };
    await event(req.user!.org_id, req.user!.sub, 'week_copied', 'schedule', null, { from_week_start: dayKey(from), to_week_start: dayKey(to), created: result.count, skipped: candidates.length - result.count });
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    ok(res, { created: result.count, skipped: candidates.length - result.count, total: candidates.length, to_week_start: dayKey(to) });
  } catch (error) { next(error); }
});

router.get('/history', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const items = await prisma.shiftScheduleEvent.findMany({ where: { org_id: req.user!.org_id }, include: { actor: { select: { id: true, name: true } } }, orderBy: { created_at: 'desc' }, take: Math.min(Number(req.query.limit) || 100, 250) });
    ok(res, items);
  } catch (error) { next(error); }
});

router.get('/export.ics', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const from = dateOnly(String(req.query.from ?? new Date().toISOString().slice(0, 10)), 'from');
    const to = dateOnly(String(req.query.to ?? dayKey(addDays(from, 90))), 'to');
    if (to < from || to > addDays(from, 366)) throw new ValidationError('Export range must be at most 367 days');
    const employeeIds = await scopedEmployeeIds(req.user!.org_id, req.user!.sub, req.permissions ?? new Set(), 'shifts.manage');
    const assignments = await prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: to }, shift: { org_id: req.user!.org_id }, ...(employeeIds ? { user_id: { in: employeeIds } } : {}) }, include: { shift: true, user: { select: { name: true } } }, orderBy: { date: 'asc' } });
    const organisation = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { timezone: true } });
    const timezone = organisation?.timezone || 'UTC';
    const esc = (text: string) => text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
    const events = assignments.map(item => {
      const date = dayKey(item.date);
      const start = fromZonedTime(`${date}T${item.shift.start_time}:00`, timezone);
      const endDate = toMinutes(item.shift.end_time) <= toMinutes(item.shift.start_time) ? dayKey(addDays(item.date, 1)) : date;
      const end = fromZonedTime(`${endDate}T${item.shift.end_time}:00`, timezone);
      const stamp = (value: Date) => value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      return ['BEGIN:VEVENT', `UID:${item.id}@attenda`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(`${item.shift.name} · ${item.user.name}`)}`, 'END:VEVENT'].join('\r\n');
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="attenda-schedule.ics"');
    res.send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Attenda//Shift Schedule//EN', ...events, 'END:VCALENDAR'].join('\r\n'));
  } catch (error) { next(error); }
});

export default router;
