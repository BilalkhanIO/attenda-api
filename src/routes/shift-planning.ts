import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { AppError, created, NotFoundError, ok, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import { createNotification, emitOrgEvent } from '../services/notifications';
import { submitShiftAvailability } from '../services/shift-availability';
import { fromZonedTime } from 'date-fns-tz';

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
function timeRangesOverlap(shift: { start_time: string; end_time: string }, rule: { start_time: string | null; end_time: string | null }) {
  if (!rule.start_time || !rule.end_time) return true;
  const split = (start: number, end: number) => end > start ? [[start, end]] : [[start, 1440], [0, end]];
  const left = split(toMinutes(shift.start_time), toMinutes(shift.end_time));
  const right = split(toMinutes(rule.start_time), toMinutes(rule.end_time));
  return left.some(([a, b]) => right.some(([c, d]) => a < d && b > c));
}
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

router.post('/availability', async (req, res, next) => {
  try {
    const item = await submitShiftAvailability(req.user!.sub, req.user!.org_id, req.body ?? {});
    await event(req.user!.org_id, req.user!.sub, 'availability_submitted', 'availability', item.id, { kind: item.kind, date: item.date, weekday: item.weekday });
    emitOrgEvent(req.user!.org_id, 'shift_changed');
    created(res, item);
  } catch (error) { next(error); }
});

router.delete('/availability/:id', async (req, res, next) => {
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

router.put('/availability/:id/review', requirePermission('shifts.availability.manage'), async (req, res, next) => {
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

router.put('/coverage', requirePermission('shifts.coverage.manage'), async (req, res, next) => {
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
    const to = weekEnd(from);
    const [assignments, leaves, availability, coverage] = await Promise.all([
      prisma.shiftAssignment.findMany({ where: { date: { gte: addDays(from, -1), lte: addDays(to, 1) }, shift: { org_id: req.user!.org_id } }, include: { shift: { include: { breaks: true } }, user: { select: { id: true, name: true, department: true } } }, orderBy: { date: 'asc' } }),
      prisma.leaveRequest.findMany({ where: { org_id: req.user!.org_id, status: 'approved', start_date: { lte: to }, end_date: { gte: from } }, select: { user_id: true, start_date: true, end_date: true } }),
      prisma.shiftAvailability.findMany({ where: { org_id: req.user!.org_id, status: 'approved', OR: [{ date: { gte: from, lte: to } }, { weekday: { not: null } }] } }),
      prisma.shiftCoverageRule.findMany({ where: { org_id: req.user!.org_id }, include: { shift: true } }),
    ]);
    const issues: Array<{ code: string; severity: 'warning'; assignment_id?: string; user_id?: string; user_name?: string; date?: string; message: string }> = [];
    const current = assignments.filter(item => item.date >= from && item.date <= to);
    for (const item of current) {
      const date = dayKey(item.date);
      if (leaves.some(leave => leave.user_id === item.user_id && leave.start_date <= item.date && leave.end_date >= item.date)) issues.push({ code: 'approved_leave', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name} is scheduled during approved leave.` });
      const weekday = (item.date.getUTCDay() + 6) % 7;
      const unavailable = availability.some(rule => rule.user_id === item.user_id && rule.kind === 'unavailable' && ((rule.date && dayKey(rule.date) === date) || (rule.weekday === weekday && (!rule.starts_on || rule.starts_on <= item.date) && (!rule.ends_on || rule.ends_on >= item.date))) && timeRangesOverlap(item.shift, rule));
      if (unavailable) issues.push({ code: 'unavailable', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name} is scheduled during approved unavailable time.` });
      const activeDay = (item.date.getUTCDay() + 6) % 7;
      if (item.shift.active_days.length && !item.shift.active_days.includes(activeDay)) issues.push({ code: 'off_day', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.shift.name} is assigned outside its active weekdays.` });
      const previous = assignments.find(other => other.user_id === item.user_id && other.id !== item.id && dayKey(other.date) === dayKey(addDays(item.date, -1)));
      const next = assignments.find(other => other.user_id === item.user_id && other.id !== item.id && dayKey(other.date) === dayKey(addDays(item.date, 1)));
      const start = toMinutes(item.shift.start_time);
      const end = start + wallMinutes(item.shift);
      if (previous) {
        const prevStart = toMinutes(previous.shift.start_time) - 1440;
        const prevEnd = prevStart + wallMinutes(previous.shift);
        const gap = start - prevEnd;
        const needed = Math.max(previous.shift.min_rest_hours, item.shift.min_rest_hours) * 60;
        if (gap < 0) issues.push({ code: 'overlap', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name}'s shifts overlap across these dates.` });
        else if (gap < needed) issues.push({ code: 'insufficient_rest', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name} has only ${Math.round(gap / 60)}h rest before this shift; policy requires ${needed / 60}h.` });
      }
      if (next) {
        const nextStart = 1440 + toMinutes(next.shift.start_time);
        const gap = nextStart - end;
        const needed = Math.max(next.shift.min_rest_hours, item.shift.min_rest_hours) * 60;
        if (gap < 0) issues.push({ code: 'overlap', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name}'s shifts overlap across these dates.` });
        else if (gap < needed) issues.push({ code: 'insufficient_rest', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name} has only ${Math.round(gap / 60)}h rest after this shift; policy requires ${needed / 60}h.` });
      }
    }
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(from, offset); const weekday = (date.getUTCDay() + 6) % 7;
      for (const rule of coverage.filter(value => value.weekday === weekday)) {
        const assigned = current.filter(item => item.shift_id === rule.shift_id && dayKey(item.date) === dayKey(date) && (!rule.department || item.user.department === rule.department)).length;
        if (assigned < rule.required_count) issues.push({ code: 'understaffed', severity: 'warning', date: dayKey(date), message: `${rule.shift.name} needs ${rule.required_count} ${rule.department ? `${rule.department} ` : ''}people on ${dayKey(date)}; ${assigned} assigned.` });
      }
    }
    ok(res, { week_start: dayKey(from), issues });
  } catch (error) { next(error); }
});

router.get('/workload', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const from = dateOnly(String(req.query.week_start ?? new Date().toISOString().slice(0, 10)), 'week_start');
    const to = weekEnd(from);
    const assignments = await prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: to }, shift: { org_id: req.user!.org_id } }, include: { shift: { include: { breaks: true } }, user: { select: { id: true, name: true, department: true } } }, orderBy: { date: 'asc' } });
    const grouped = new Map<string, { user: { id: string; name: string; department: string | null }; assignments: number; minutes: number; days: Set<string> }>();
    for (const item of assignments) {
      const current = grouped.get(item.user_id) ?? { user: item.user, assignments: 0, minutes: 0, days: new Set<string>() };
      current.assignments++; current.minutes += shiftMinutes(item.shift); current.days.add(dayKey(item.date)); grouped.set(item.user_id, current);
    }
    ok(res, [...grouped.values()].map(value => ({ user: value.user, assignments: value.assignments, days_worked: value.days.size, scheduled_hours: Math.round(value.minutes / 6) / 10 })).sort((a, b) => b.scheduled_hours - a.scheduled_hours));
  } catch (error) { next(error); }
});

router.post('/copy-week', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const from = dateOnly(req.body?.from_week_start, 'from_week_start');
    const to = dateOnly(req.body?.to_week_start, 'to_week_start');
    if (!isMonday(from) || !isMonday(to)) throw new ValidationError('Both dates must be Mondays');
    if (to <= from || to > addDays(from, 370)) throw new ValidationError('Choose a later week within the next 53 weeks');
    const sourceEnd = weekEnd(from); const offset = Math.round((to.getTime() - from.getTime()) / 86400000);
    const source = await prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: sourceEnd }, shift: { org_id: req.user!.org_id } }, select: { user_id: true, shift_id: true, date: true } });
    const candidates = source.map(item => ({ user_id: item.user_id, shift_id: item.shift_id, date: addDays(item.date, offset) }));
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
    const assignments = await prisma.shiftAssignment.findMany({ where: { date: { gte: from, lte: to }, shift: { org_id: req.user!.org_id } }, include: { shift: true, user: { select: { name: true } } }, orderBy: { date: 'asc' } });
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
