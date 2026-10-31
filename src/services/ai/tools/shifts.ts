import { PrismaClient } from '@prisma/client';

function minutes(value: string) { const [hours, mins] = value.split(':').map(Number); return hours * 60 + mins; }
function wallMinutes(shift: { start_time: string; end_time: string }) { const length = minutes(shift.end_time) - minutes(shift.start_time); return length <= 0 ? length + 1440 : length; }
function overlapsUnavailable(shift: { start_time: string; end_time: string }, range: { start_time: string | null; end_time: string | null }) {
  if (!range.start_time || !range.end_time) return true;
  const split = (start: number, end: number) => end > start ? [[start, end]] : [[start, 1440], [0, end]];
  return split(minutes(shift.start_time), minutes(shift.end_time)).some(([start, end]) =>
    split(minutes(range.start_time!), minutes(range.end_time!)).some(([otherStart, otherEnd]) => start < otherEnd && end > otherStart));
}

export interface ShiftScheduleInput {
  userId?: string;
  start?: string; // ISO date string
  end?: string; // ISO date string
  department?: string;
}

export async function shiftScheduleTool(
  prisma: PrismaClient,
  orgId: string,
  input: ShiftScheduleInput
) {
  const { userId, start, end, department } = input;
  const where: any = { shift: { org_id: orgId } };
  if (userId) where.user_id = userId;
  if (department) where.user = { department };
  if (start || end) {
    where.date = {};
    if (start) where.date.gte = new Date(start);
    if (end) {
      const endDate = new Date(end);
      where.date.lte = endDate;
    }
  }

  const shifts = await prisma.shiftAssignment.findMany({ where, include: { shift: true, user: { select: { id: true, name: true, department: true } } }, orderBy: { date: 'asc' }, take: 200 });

  return shifts.map(s => ({
    id: s.id, date: s.date, name: s.shift.name,
    startTime: s.shift.start_time, endTime: s.shift.end_time,
    userId: s.user_id, userName: s.user.name, department: s.user.department,
  }));
};

export async function shiftPlanningInsightsTool(prisma: PrismaClient, orgId: string, weekStart?: string) {
  const from = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)
    ? new Date(`${weekStart}T00:00:00.000Z`)
    : (() => { const d = new Date(); const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); return date; })();
  const to = new Date(from); to.setUTCDate(to.getUTCDate() + 6);
  const [assignments, leaves, availability, coverage] = await Promise.all([
    prisma.shiftAssignment.findMany({ where: { date: { gte: new Date(from.getTime() - 86400000), lte: new Date(to.getTime() + 86400000) }, shift: { org_id: orgId } }, include: { shift: { include: { breaks: true } }, user: { select: { id: true, name: true, department: true } } }, orderBy: { date: 'asc' } }),
    prisma.leaveRequest.findMany({ where: { org_id: orgId, status: 'approved', start_date: { lte: to }, end_date: { gte: from } }, select: { user_id: true, start_date: true, end_date: true } }),
    prisma.shiftAvailability.findMany({ where: { org_id: orgId, status: 'approved', kind: 'unavailable' } }),
    prisma.shiftCoverageRule.findMany({ where: { org_id: orgId }, include: { shift: true } }),
  ]);
  const currentAssignments = assignments.filter(item => item.date >= from && item.date <= to);
  const issues: Array<{ type: string; date: string; employee?: string; message: string }> = [];
  const workload = new Map<string, { name: string; department: string | null; hours: number; shifts: number }>();
  for (const item of currentAssignments) {
    const date = item.date.toISOString().slice(0, 10); const weekday = (item.date.getUTCDay() + 6) % 7;
    if (leaves.some(leave => leave.user_id === item.user_id && leave.start_date <= item.date && leave.end_date >= item.date)) issues.push({ type: 'approved_leave', date, employee: item.user.name, message: `${item.user.name} is scheduled during approved leave.` });
    if (availability.some(rule => rule.user_id === item.user_id && ((rule.date && rule.date.toISOString().slice(0, 10) === date) || (rule.weekday === weekday && (!rule.starts_on || rule.starts_on <= item.date) && (!rule.ends_on || rule.ends_on >= item.date))) && overlapsUnavailable(item.shift, rule))) issues.push({ type: 'unavailable', date, employee: item.user.name, message: `${item.user.name} is scheduled during approved unavailable time.` });
    if (item.shift.active_days.length && !item.shift.active_days.includes(weekday)) issues.push({ type: 'off_day', date, employee: item.user.name, message: `${item.shift.name} is assigned outside its active weekdays.` });
    const duration = (() => { const [sh, sm] = item.shift.start_time.split(':').map(Number); const [eh, em] = item.shift.end_time.split(':').map(Number); let minutes = eh * 60 + em - sh * 60 - sm; if (minutes <= 0) minutes += 1440; minutes -= item.shift.breaks.filter(b => !b.is_paid).reduce((sum, b) => sum + b.break_minutes, 0); return Math.max(0, minutes); })();
    const priorDate = new Date(item.date); priorDate.setUTCDate(priorDate.getUTCDate() - 1);
    const previous = assignments.find(other => other.user_id === item.user_id && other.id !== item.id && other.date.toISOString().slice(0, 10) === priorDate.toISOString().slice(0, 10));
    if (previous) {
      const previousEnd = minutes(previous.shift.start_time) - 1440 + wallMinutes(previous.shift);
      const rest = minutes(item.shift.start_time) - previousEnd;
      const required = Math.max(previous.shift.min_rest_hours, item.shift.min_rest_hours) * 60;
      if (rest < 0) issues.push({ type: 'overlap', date, employee: item.user.name, message: `${item.user.name}'s shifts overlap across these dates.` });
      else if (rest < required) issues.push({ type: 'insufficient_rest', date, employee: item.user.name, message: `${item.user.name} has ${Math.round(rest / 60)} hours rest before this shift; policy requires ${required / 60}.` });
    }
    const current = workload.get(item.user_id) ?? { name: item.user.name, department: item.user.department, hours: 0, shifts: 0 };
    current.hours += duration / 60; current.shifts += 1; workload.set(item.user_id, current);
  }
  const coverageGaps = coverage.flatMap(rule => Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(from); date.setUTCDate(date.getUTCDate() + offset); const weekday = (date.getUTCDay() + 6) % 7;
    if (weekday !== rule.weekday) return null;
    const count = currentAssignments.filter(item => item.shift_id === rule.shift_id && item.date.toISOString().slice(0, 10) === date.toISOString().slice(0, 10) && (!rule.department || item.user.department === rule.department)).length;
    return count < rule.required_count ? { shift: rule.shift.name, date: date.toISOString().slice(0, 10), assigned: count, required: rule.required_count, department: rule.department || null } : null;
  }).filter(Boolean));
  return { week_start: from.toISOString().slice(0, 10), scheduled_shifts: currentAssignments.length, workload: [...workload.values()].map(item => ({ ...item, hours: Math.round(item.hours * 10) / 10 })), issues, coverage_gaps: coverageGaps };
}
