import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import prisma from '../utils/prisma';
import { resolveUserPermissions } from './authorization';
import { generateReport } from './reportGeneration';
import { sendEmail } from './email';
import { jobLogger } from '../utils/logger';
import { customReportSchema, type CustomReportInput } from '../schemas/custom-reports';
import { canGenerateCustomDataset, generateCustomReport } from './customReports';

export function nextReportRun(frequency: string, localTime: string, timezone: string, after: Date): Date {
  const [hour, minute] = localTime.split(':').map(Number);
  const zoned = toZonedTime(after, timezone);
  let year = zoned.getFullYear();
  let month = zoned.getMonth();
  let day = zoned.getDate();
  for (let i = 0; i < 3; i++) {
    const candidate = fromZonedTime(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`, timezone);
    if (candidate > after) return candidate;
    if (frequency === 'weekly') {
      const next = new Date(Date.UTC(year, month, day + 7)); year = next.getUTCFullYear(); month = next.getUTCMonth(); day = next.getUTCDate();
    } else if (frequency === 'monthly') {
      const next = new Date(Date.UTC(year, month + 1, 1));
      year = next.getUTCFullYear(); month = next.getUTCMonth();
      day = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    } else {
      const next = new Date(Date.UTC(year, month, day + 1)); year = next.getUTCFullYear(); month = next.getUTCMonth(); day = next.getUTCDate();
    }
  }
  throw new Error('Could not calculate next scheduled report run');
}

function resolvePeriodParams(type: string, params: Record<string, unknown>, frequency: string, timezone: string, scheduledAt: Date): Record<string, unknown> {
  if (params.relative_period !== true) return params;
  const local = toZonedTime(scheduledAt, timezone);
  const localDate = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  if (type === 'payroll' || type === 'performance') {
    const previousMonth = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth() - 1, 1));
    return { month: previousMonth.getUTCMonth() + 1, year: previousMonth.getUTCFullYear() };
  }
  if (frequency === 'monthly') {
    const firstThisMonth = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), 1));
    const lastPreviousMonth = new Date(firstThisMonth.getTime() - 86400000);
    const firstPreviousMonth = new Date(Date.UTC(lastPreviousMonth.getUTCFullYear(), lastPreviousMonth.getUTCMonth(), 1));
    return { start_date: firstPreviousMonth.toISOString().slice(0, 10), end_date: lastPreviousMonth.toISOString().slice(0, 10) };
  }
  const days = frequency === 'weekly' ? 7 : 1;
  const end = new Date(localDate.getTime() - 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) };
}

export async function runDueReportSchedules(now = new Date()): Promise<void> {
  const due = await prisma.reportSchedule.findMany({
    where: { status: 'active', next_run_at: { lte: now } }, orderBy: { next_run_at: 'asc' }, take: 25,
    include: { owner: { select: { id: true, email: true, is_active: true } } },
  });
  for (const schedule of due) {
    const scheduledFor = schedule.next_run_at;
    const next = nextReportRun(schedule.frequency, schedule.local_time, schedule.timezone, now);
    const claimed = await prisma.$transaction(async tx => {
      const result = await tx.reportSchedule.updateMany({
        where: { id: schedule.id, status: 'active', next_run_at: scheduledFor },
        data: { next_run_at: next, last_run_at: now },
      });
      if (!result.count) return null;
      return tx.reportRun.create({ data: {
        org_id: schedule.org_id, owner_id: schedule.owner_id, schedule_id: schedule.id,
        report_type: schedule.report_type, params: schedule.params as object,
        scheduled_for: scheduledFor, status: 'running', started_at: now,
      } });
    }).catch(error => {
      jobLogger.warn({ err: error, scheduleId: schedule.id }, 'could not claim scheduled report run');
      return null;
    });
    if (!claimed) continue;
    try {
      if (!schedule.owner.is_active) throw new Error('The schedule owner is inactive. Reactivate the owner or assign a new schedule.');
      const permissions = await resolveUserPermissions(schedule.owner.id, schedule.org_id);
      let parsedCustomDefinition: CustomReportInput | null = null;
      if (schedule.report_type === 'custom') {
        const definitionId = (schedule.params as Record<string, unknown>)?.definition_id;
        const savedCustomDefinition = typeof definitionId === 'string' ? await prisma.reportDefinition.findFirst({ where: { id: definitionId, org_id: schedule.org_id, owner_id: schedule.owner_id } }) : null;
        const parsed = savedCustomDefinition ? customReportSchema.safeParse(savedCustomDefinition.definition) : null;
        parsedCustomDefinition = parsed?.success ? parsed.data : null;
      }
      if (!permissions.has('reports.export') || (schedule.report_type === 'payroll' && !permissions.has('payroll.view')) || (schedule.report_type === 'custom' && (!parsedCustomDefinition || !canGenerateCustomDataset(parsedCustomDefinition.dataset, permissions)))) {
        await prisma.reportSchedule.update({ where: { id: schedule.id }, data: { status: 'paused' } });
        throw new Error('The schedule owner no longer has permission to export this report or its saved definition is missing. The schedule was paused.');
      }
      let result: { download_url: string; row_count: number };
      if (schedule.report_type === 'custom' && parsedCustomDefinition) {
        const period = resolvePeriodParams('attendance', {}, schedule.frequency, schedule.timezone, scheduledFor);
        const filters = parsedCustomDefinition.dataset === 'employees' ? parsedCustomDefinition.filters : {
          ...parsedCustomDefinition.filters,
          date_from: String(period.start_date),
          date_to: String(period.end_date),
        };
        result = await generateCustomReport(schedule.org_id, schedule.owner_id, permissions, { ...parsedCustomDefinition, filters });
      } else {
        const reportParams = resolvePeriodParams(schedule.report_type, schedule.params as Record<string, unknown>, schedule.frequency, schedule.timezone, scheduledFor);
        result = await generateReport(schedule.org_id, schedule.report_type, reportParams);
      }
      if (!schedule.owner.email) throw new Error('The schedule owner has no email address configured.');
      await sendEmail({
        to: schedule.owner.email,
        subject: `${schedule.name} is ready`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>${schedule.name.replace(/[&<>"']/g, '')} is ready</h2><p>Your scheduled ${schedule.report_type} report contains ${result.row_count} rows.</p><p><a href="${result.download_url}">Download report</a></p><p style="color:#667085">This link expires according to your file-storage settings.</p></div>`,
      });
      await prisma.reportRun.update({ where: { id: claimed.id }, data: { status: 'completed', download_url: result.download_url, row_count: result.row_count, completed_at: new Date() } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scheduled report failed';
      await prisma.reportRun.update({ where: { id: claimed.id }, data: { status: 'failed', error: message.slice(0, 2000), completed_at: new Date() } }).catch(() => {});
      jobLogger.error({ err: error, runId: claimed.id, scheduleId: schedule.id }, 'scheduled report failed');
    }
  }
}
