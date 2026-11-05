import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import prisma from '../utils/prisma';

export const ORG_SCHEDULED_JOBS = {
  projectDeadlines: 'project_deadline_reminders',
  dailyRemoteNudges: 'daily_remote_nudge',
  leaveAccrual: 'leave_accrual',
  payrollAutoGenerate: 'payroll_auto_generate',
} as const;

type ScheduleDefinition = { jobKey: string; config: string; next: (now: Date, timezone: string) => Date };
const localDayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localDate = (date: Date, deltaDays: number) => {
  const shifted = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + deltaDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
};
const atLocal = (dateKey: string, time: string, timezone: string) => fromZonedTime(`${dateKey}T${time}:00`, timezone);
const safeTimezone = (timezone: string | null | undefined) => {
  try { toZonedTime(new Date(), timezone || 'UTC'); return timezone || 'UTC'; }
  catch { return 'UTC'; }
};

function definitionsFor(now: Date, orgs: Array<{ id: string; timezone: string; payroll_day: number }>): ScheduleDefinition[] {
  const out: ScheduleDefinition[] = [];
  for (const org of orgs) {
    const timezone = safeTimezone(org.timezone);
    const payrollDay = Math.max(1, Math.min(31, org.payroll_day));
    const config = `${timezone}|${payrollDay}`;
    out.push(
      { jobKey: ORG_SCHEDULED_JOBS.projectDeadlines, config: timezone, next: (at, tz) => { const local = toZonedTime(at, tz); return atLocal(localDayKey(local), '08:00', tz); } },
      { jobKey: ORG_SCHEDULED_JOBS.dailyRemoteNudges, config: timezone, next: (at, tz) => { const local = toZonedTime(at, tz); return atLocal(localDayKey(local), '08:00', tz); } },
      { jobKey: ORG_SCHEDULED_JOBS.leaveAccrual, config: `${timezone}|employee-local-period-v1`, next: (at, tz) => {
        const local = toZonedTime(at, tz);
        const todayRun = atLocal(localDayKey(local), '02:00', tz);
        return todayRun > at ? todayRun : atLocal(localDate(local, 1), '02:00', tz);
      } },
      { jobKey: ORG_SCHEDULED_JOBS.payrollAutoGenerate, config, next: (at, tz) => {
        const local = toZonedTime(at, tz);
        const last = new Date(local.getFullYear(), local.getMonth() + 1, 0).getDate();
        const day = Math.min(payrollDay, last);
        return atLocal(`${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, '08:00', tz);
      } },
    );
  }
  return out;
}

/**
 * Reconcile only on startup and the 15-minute maintenance tick. The minute workers
 * read indexed due rows rather than scanning every organization on every tick.
 */
export async function reconcileOrganizationJobSchedules(now = new Date()): Promise<void> {
  const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true, payroll_day: true } });
  if (!orgs.length) return;
  const jobKeys = Object.values(ORG_SCHEDULED_JOBS);
  const existing = await prisma.organizationJobSchedule.findMany({ where: { org_id: { in: orgs.map(org => org.id) }, job_key: { in: jobKeys } } });
  const byKey = new Map(existing.map(row => [`${row.org_id}:${row.job_key}`, row]));
  const definitions = new Map<string, ScheduleDefinition[]>();
  for (const org of orgs) {
    const rows = definitionsFor(now, [org]);
    definitions.set(org.id, rows);
  }
  const missing: Array<{ org_id: string; job_key: string; timezone: string; schedule_config: string; next_run_at: Date; updated_at: Date }> = [];
  for (const org of orgs) {
    const timezone = safeTimezone(org.timezone);
    for (const def of definitions.get(org.id) ?? []) {
      const current = byKey.get(`${org.id}:${def.jobKey}`);
      if (!current) {
        missing.push({ org_id: org.id, job_key: def.jobKey, timezone, schedule_config: def.config, next_run_at: def.next(now, timezone), updated_at: now });
      } else if (current.timezone !== timezone || current.schedule_config !== def.config) {
        await prisma.organizationJobSchedule.update({ where: { org_id_job_key: { org_id: org.id, job_key: def.jobKey } }, data: { timezone, schedule_config: def.config, next_run_at: def.next(now, timezone) } });
      }
    }
  }
  if (missing.length) await prisma.organizationJobSchedule.createMany({ data: missing, skipDuplicates: true });
}

export async function getDueOrganizationJobs(jobKey: string, now = new Date(), take = 200) {
  return prisma.organizationJobSchedule.findMany({ where: { job_key: jobKey, next_run_at: { lte: now } }, orderBy: { next_run_at: 'asc' }, take });
}

export async function markOrganizationJobComplete(orgId: string, jobKey: string, now = new Date()): Promise<void> {
  const schedule = await prisma.organizationJobSchedule.findUnique({ where: { org_id_job_key: { org_id: orgId, job_key: jobKey } } });
  if (!schedule) return;
  const timezone = safeTimezone(schedule.timezone);
  const localNow = toZonedTime(now, timezone);
  let nextRun: Date;
  if (jobKey === ORG_SCHEDULED_JOBS.projectDeadlines || jobKey === ORG_SCHEDULED_JOBS.dailyRemoteNudges) {
    nextRun = atLocal(localDate(localNow, 1), '08:00', timezone);
  } else if (jobKey === ORG_SCHEDULED_JOBS.leaveAccrual) {
    nextRun = atLocal(localDate(localNow, 1), '02:00', timezone);
  } else {
    const configDay = Number(schedule.schedule_config.split('|')[1] ?? '1');
    const nextMonth = new Date(Date.UTC(localNow.getFullYear(), localNow.getMonth() + 1, 1));
    const last = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).getUTCDate();
    const day = Math.min(Math.max(1, configDay), last);
    nextRun = atLocal(`${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, '08:00', timezone);
  }
  await prisma.organizationJobSchedule.updateMany({ where: { org_id: orgId, job_key: jobKey, next_run_at: { lte: now } }, data: { last_run_at: now, next_run_at: nextRun } });
}
