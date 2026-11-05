export type ComplianceRuleInput = {
  id: string;
  code: string;
  severity: string;
  params: unknown;
  effective_from?: Date;
  effective_to?: Date | null;
};

export type ComplianceAssignmentInput = {
  id: string;
  user_id: string;
  date: Date;
  user: { id: string; name: string };
  shift: {
    id: string;
    name: string;
    start_time: string;
    end_time: string;
    min_rest_hours: number;
    breaks: Array<{ break_minutes: number; after_minutes: number; break_kind?: string; break_start_time?: string | null; is_paid: boolean; applies_days?: number[]; exception_dates?: string[] }>;
  };
};

export type ComplianceFinding = {
  code: string;
  severity: 'info' | 'warning' | 'block';
  user_id: string;
  user_name: string;
  assignment_id: string | null;
  date: string;
  message: string;
  details: Record<string, unknown>;
  dedupe_key: string;
  rule_id: string | null;
};

function minutes(value: string) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

function dateKey(value: Date) { return value.toISOString().slice(0, 10); }
function dayNumber(value: Date) { return Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86400000); }
function wallDuration(start: string, end: string) {
  const delta = minutes(end) - minutes(start);
  return delta <= 0 ? delta + 1440 : delta;
}
function breakApplies(item: ComplianceAssignmentInput['shift']['breaks'][number], date: Date) {
  const key = dateKey(date);
  const weekday = (date.getUTCDay() + 6) % 7;
  return !(item.exception_dates ?? []).includes(key) && (!(item.applies_days?.length) || item.applies_days.includes(weekday));
}
function breakStartOffset(item: ComplianceAssignmentInput['shift']['breaks'][number], shift: ComplianceAssignmentInput['shift']) {
  if (item.break_kind === 'fixed' && item.break_start_time) return (minutes(item.break_start_time) - minutes(shift.start_time) + 1440) % 1440;
  return item.after_minutes;
}
function workDuration(assignment: ComplianceAssignmentInput) {
  return Math.max(0, wallDuration(assignment.shift.start_time, assignment.shift.end_time) - assignment.shift.breaks.filter(item => !item.is_paid && breakApplies(item, assignment.date)).reduce((sum, item) => sum + item.break_minutes, 0));
}
function findingSeverity(value: string): ComplianceFinding['severity'] {
  if (value === 'block') return 'block';
  if (value === 'info') return 'info';
  return 'warning';
}

/** Pure schedule evaluator. It has no database, timezone, or policy-selection side effects. */
export function evaluateScheduleCompliance(
  assignments: ComplianceAssignmentInput[],
  rules: ComplianceRuleInput[],
  weekStart: Date,
  weekEnd: Date,
): ComplianceFinding[] {
  const rulesByCode = new Map<string, ComplianceRuleInput[]>();
  for (const rule of rules) rulesByCode.set(rule.code, [...(rulesByCode.get(rule.code) ?? []), rule]);
  const ruleFor = (code: string, date: Date) => (rulesByCode.get(code) ?? []).find(rule => (!rule.effective_from || rule.effective_from <= date) && (!rule.effective_to || rule.effective_to >= date));
  const findings: ComplianceFinding[] = [];
  const monday = dayNumber(weekStart);
  const sunday = dayNumber(weekEnd);
  const add = (rule: ComplianceRuleInput, assignment: ComplianceAssignmentInput, message: string, details: Record<string, unknown>, suffix = assignment.id) => {
    findings.push({ code: rule.code, severity: findingSeverity(rule.severity), user_id: assignment.user_id, user_name: assignment.user.name, assignment_id: assignment.id, date: dateKey(assignment.date), message, details, dedupe_key: `${dateKey(weekStart)}:${rule.code}:${suffix}`, rule_id: rule.id });
  };

  const weekly = new Map<string, { minutes: number; latest: ComplianceAssignmentInput }>();
  for (const assignment of assignments) {
    const day = dayNumber(assignment.date);
    const workMins = workDuration(assignment);
    const wallMins = wallDuration(assignment.shift.start_time, assignment.shift.end_time);
    if (day >= monday && day <= sunday) {
      const current = weekly.get(assignment.user_id) ?? { minutes: 0, latest: assignment };
      current.minutes += workMins;
      current.latest = assignment;
      weekly.set(assignment.user_id, current);
    }

    if (day >= monday && day <= sunday) {
      const shiftRule = ruleFor('max_shift_hours', assignment.date);
      const shiftLimit = Number((shiftRule?.params as { hours?: number } | null)?.hours);
      if (shiftRule && Number.isFinite(shiftLimit) && workMins > shiftLimit * 60) {
        add(shiftRule, assignment, `${assignment.user.name}'s ${assignment.shift.name} has ${Math.round(workMins / 6) / 10} working hours, above the ${shiftLimit}-hour limit.`, { work_minutes: workMins, limit_hours: shiftLimit });
      }

      const spreadRule = ruleFor('max_spread_over_hours', assignment.date);
      const spreadLimit = Number((spreadRule?.params as { hours?: number } | null)?.hours);
      if (spreadRule && Number.isFinite(spreadLimit) && wallMins > spreadLimit * 60) {
        add(spreadRule, assignment, `${assignment.user.name}'s ${assignment.shift.name} spans ${Math.round(wallMins / 6) / 10} hours, above the ${spreadLimit}-hour spread-over limit.`, { spread_minutes: wallMins, limit_hours: spreadLimit });
      }

      const breakRule = ruleFor('mandatory_break', assignment.date);
      const breakParams = breakRule?.params as { after_hours?: number; break_minutes?: number } | null;
      const afterHours = Number(breakParams?.after_hours);
      const requiredBreak = Number(breakParams?.break_minutes);
      if (breakRule && Number.isFinite(afterHours) && Number.isFinite(requiredBreak) && workMins > afterHours * 60) {
        const hasCompliantBreak = assignment.shift.breaks.some(item => breakApplies(item, assignment.date) && breakStartOffset(item, assignment.shift) <= afterHours * 60 && item.break_minutes >= requiredBreak);
        if (!hasCompliantBreak) add(breakRule, assignment, `${assignment.user.name}'s ${assignment.shift.name} exceeds ${afterHours} working hours without a planned ${requiredBreak}-minute break before that threshold.`, { work_minutes: workMins, after_hours: afterHours, required_break_minutes: requiredBreak });
      }
    }
  }

  const weeklyRule = ruleFor('max_weekly_hours', weekEnd);
  const weeklyLimit = Number((weeklyRule?.params as { hours?: number } | null)?.hours);
  if (weeklyRule && Number.isFinite(weeklyLimit)) for (const [userId, value] of weekly) {
    if (value.minutes > weeklyLimit * 60) {
      const assignment = value.latest;
      add(weeklyRule, assignment, `${assignment.user.name} is scheduled for ${Math.round(value.minutes / 6) / 10} working hours, above the ${weeklyLimit}-hour weekly limit.`, { scheduled_minutes: value.minutes, limit_hours: weeklyLimit }, userId);
    }
  }

  const ordered = [...assignments].sort((a, b) => a.user_id.localeCompare(b.user_id) || dayNumber(a.date) - dayNumber(b.date) || minutes(a.shift.start_time) - minutes(b.shift.start_time));
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const next = ordered[index];
    if (previous.user_id !== next.user_id) continue;
    const previousStart = dayNumber(previous.date) * 1440 + minutes(previous.shift.start_time);
    const previousEnd = previousStart + wallDuration(previous.shift.start_time, previous.shift.end_time);
    const nextStart = dayNumber(next.date) * 1440 + minutes(next.shift.start_time);
    const restMins = nextStart - previousEnd;
    const restRule = ruleFor('min_rest_hours', next.date);
    const restHours = Number((restRule?.params as { hours?: number } | null)?.hours);
    const requiredHours = Math.max(previous.shift.min_rest_hours, next.shift.min_rest_hours, restRule && Number.isFinite(restHours) ? restHours : 0);
    const previousDay = dayNumber(previous.date);
    const nextDay = dayNumber(next.date);
    const touchesSelectedWeek = previousDay >= monday - 1 && previousDay <= sunday && nextDay >= monday && nextDay <= sunday + 1;
    if (restMins < requiredHours * 60 && touchesSelectedWeek) {
      const rule = restRule ?? { id: '', code: 'insufficient_rest', severity: 'warn', params: { hours: requiredHours } };
      const message = restMins < 0
        ? `${next.user.name}'s shifts overlap by ${Math.round(Math.abs(restMins) / 6) / 10} hours.`
        : `${next.user.name} has ${Math.round(restMins / 6) / 10} hours between shifts; the required rest is ${requiredHours} hours.`;
      add(rule, next, message, { rest_minutes: restMins, required_hours: requiredHours, previous_assignment_id: previous.id });
    }
  }
  return findings;
}
