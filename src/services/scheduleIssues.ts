import prisma from '../utils/prisma';
import { scopedEmployeeIds } from './locationScope';
import { evaluateScheduleCompliance } from './compliance/evaluateSchedule';

function dayKey(date: Date) { return date.toISOString().slice(0, 10); }
function addDays(date: Date, days: number) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }
function weekEnd(start: Date) { return addDays(start, 6); }
function toMinutes(value: string) { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
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
  return Math.max(0, duration - (shift.breaks ?? []).filter(item => !item.is_paid).reduce((sum, item) => sum + item.break_minutes, 0));
}

/** Shared source for planning-page warnings and the dashboard schedule summary. */
export async function getScheduleIssues(orgId: string, userId: string, permissions: Set<string>, from: Date) {
  const to = weekEnd(from);
  const employeeIds = await scopedEmployeeIds(orgId, userId, permissions, 'shifts.manage');
  const [assignments, leaves, availability, coverage, complianceRules] = await Promise.all([
    prisma.shiftAssignment.findMany({ where: { date: { gte: addDays(from, -1), lte: addDays(to, 1) }, shift: { org_id: orgId }, ...(employeeIds ? { user_id: { in: employeeIds } } : {}) }, include: { shift: { include: { breaks: true } }, user: { select: { id: true, name: true, department: true } } }, orderBy: { date: 'asc' } }),
    prisma.leaveRequest.findMany({ where: { org_id: orgId, status: 'approved', start_date: { lte: to }, end_date: { gte: from } }, select: { user_id: true, start_date: true, end_date: true } }),
    prisma.shiftAvailability.findMany({ where: { org_id: orgId, status: 'approved', OR: [{ date: { gte: from, lte: to } }, { weekday: { not: null } }] } }),
    prisma.shiftCoverageRule.findMany({ where: { org_id: orgId }, include: { shift: true } }),
    prisma.complianceRule.findMany({ where: { org_id: orgId, effective_from: { lte: to }, OR: [{ effective_to: null }, { effective_to: { gte: from } }] }, orderBy: { effective_from: 'desc' } }),
  ]);
  const issues: Array<{ code: string; severity: 'info' | 'warning' | 'block'; assignment_id?: string; user_id?: string; user_name?: string; date?: string; message: string }> = [];
  const current = assignments.filter(item => item.date >= from && item.date <= to);
  const scheduledMinutesByUser = new Map<string, { name: string; minutes: number }>();
  for (const item of current) {
    const weeklyLoad = scheduledMinutesByUser.get(item.user_id) ?? { name: item.user.name, minutes: 0 };
    weeklyLoad.minutes += shiftMinutes(item.shift);
    scheduledMinutesByUser.set(item.user_id, weeklyLoad);
    const date = dayKey(item.date);
    if (leaves.some(leave => leave.user_id === item.user_id && leave.start_date <= item.date && leave.end_date >= item.date)) issues.push({ code: 'approved_leave', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name} is scheduled during approved leave.` });
    const weekday = (item.date.getUTCDay() + 6) % 7;
    const unavailable = availability.some(rule => rule.user_id === item.user_id && rule.kind === 'unavailable' && ((rule.date && dayKey(rule.date) === date) || (rule.weekday === weekday && (!rule.starts_on || rule.starts_on <= item.date) && (!rule.ends_on || rule.ends_on >= item.date))) && timeRangesOverlap(item.shift, rule));
    if (unavailable) issues.push({ code: 'unavailable', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.user.name} is scheduled during approved unavailable time.` });
    const activeDay = (item.date.getUTCDay() + 6) % 7;
    if (item.shift.active_days.length && !item.shift.active_days.includes(activeDay)) issues.push({ code: 'off_day', severity: 'warning', assignment_id: item.id, user_id: item.user_id, user_name: item.user.name, date, message: `${item.shift.name} is assigned outside its active weekdays.` });
  }
  const complianceFindings = evaluateScheduleCompliance(assignments, complianceRules, from, to);
  for (const finding of complianceFindings) issues.push({ code: finding.code, severity: finding.severity, assignment_id: finding.assignment_id ?? undefined, user_id: finding.user_id, user_name: finding.user_name, date: finding.date, message: finding.message });
  for (const [userId, load] of scheduledMinutesByUser) {
    if (!complianceRules.some(rule => rule.code === 'max_weekly_hours' && rule.effective_from <= to && (!rule.effective_to || rule.effective_to >= to)) && load.minutes > 48 * 60) issues.push({ code: 'weekly_hours_reference', severity: 'warning', user_id: userId, user_name: load.name, message: `${load.name} is scheduled for ${Math.round(load.minutes / 6) / 10} hours this week, above the 48-hour planning reference. Configure an approved rule pack to use an organization-specific limit.` });
  }
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(from, offset); const weekday = (date.getUTCDay() + 6) % 7;
    for (const rule of coverage.filter(value => value.weekday === weekday)) {
      const assigned = current.filter(item => item.shift_id === rule.shift_id && dayKey(item.date) === dayKey(date) && (!rule.department || item.user.department === rule.department)).length;
      if (assigned < rule.required_count) issues.push({ code: 'understaffed', severity: 'warning', date: dayKey(date), message: `${rule.shift.name} needs ${rule.required_count} ${rule.department ? `${rule.department} ` : ''}people on ${dayKey(date)}; ${assigned} assigned.` });
    }
  }
  return { week_start: dayKey(from), assignment_count: current.length, issues };
}
