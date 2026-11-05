import { Prisma } from '@prisma/client';
import { toZonedTime } from 'date-fns-tz';
import prisma from '../utils/prisma';
import { resolveUserPermissions } from './authorization';
import { emitOrgEvent } from './notifications';

type WhatsAppPolicy = {
  id: string;
  timezone: string;
  currency: string;
  wa_monthly_message_limit: number | null;
  wa_alert_threshold_percent: number;
  wa_estimated_cost_per_message: Prisma.Decimal | null;
};

function localMonthStart(now: Date, timezone: string): Date {
  const local = toZonedTime(now, timezone || 'UTC');
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), 1));
}

async function notifyWhatsAppAdmins(
  orgId: string,
  periodStart: Date,
  kind: 'threshold' | 'limit',
  used: number,
  limit: number,
): Promise<void> {
  try {
    const period = await prisma.whatsAppUsagePeriod.findUnique({
      where: { org_id_period_start: { org_id: orgId, period_start: periodStart } },
      select: { threshold_alerted_at: true, quota_alerted_at: true },
    });
    if (kind === 'threshold' ? period?.threshold_alerted_at : period?.quota_alerted_at) return;
    const users = await prisma.user.findMany({
      where: { org_id: orgId, is_active: true, deleted_at: null },
      select: { id: true },
    });
    const permissionResults = await Promise.all(users.map(async user => ({
      userId: user.id,
      permissions: await resolveUserPermissions(user.id, orgId),
    })));
    const adminIds = permissionResults
      .filter(({ permissions }) => permissions.has('org.whatsapp.update') || permissions.has('whatsapp.logs.view'))
      .map(({ userId }) => userId);

    const month = periodStart.toISOString().slice(0, 7);
    const title = kind === 'limit' ? 'WhatsApp monthly limit reached' : 'WhatsApp usage is nearing its limit';
    const body = kind === 'limit'
      ? `${used.toLocaleString()} of ${limit.toLocaleString()} outbound WhatsApp attempts have been reserved for ${month}. WhatsApp delivery is paused until the monthly limit is raised or resets.`
      : `${used.toLocaleString()} of ${limit.toLocaleString()} outbound WhatsApp attempts have been reserved for ${month}.`;
    const claimed = await prisma.$transaction(async tx => {
      const updated = await tx.whatsAppUsagePeriod.updateMany({
        where: {
          org_id: orgId,
          period_start: periodStart,
          ...(kind === 'limit' ? { quota_alerted_at: null } : { threshold_alerted_at: null }),
        },
        data: kind === 'limit' ? { quota_alerted_at: new Date() } : { threshold_alerted_at: new Date() },
      });
      if (!updated.count) return false;
      if (adminIds.length) await tx.inAppNotification.createMany({
        data: adminIds.map(userId => ({
          user_id: userId,
          org_id: orgId,
          type: kind === 'limit' ? 'whatsapp_usage_limit' : 'whatsapp_usage_warning',
          title,
          body,
          action_type: 'settings',
          action_id: null,
          metadata: { month, used, limit, kind },
          dedupe_key: `whatsapp-usage:${month}:${kind}`,
        })),
      });
      return true;
    });
    if (claimed && adminIds.length) emitOrgEvent(orgId, 'notification_changed');
  } catch (error) {
    console.error('[WhatsApp] Could not create usage alert:', error);
  }
}

/**
 * Reserve one outbound provider request before sending. Retries count as
 * separate attempts because a timed-out request may still have reached Meta.
 */
export async function reserveWhatsAppAttempt(policy: WhatsAppPolicy, now = new Date()) {
  const periodStart = localMonthStart(now, policy.timezone);
  const limit = policy.wa_monthly_message_limit;
  const threshold = limit === null
    ? null
    : Math.min(limit, Math.ceil(limit * Math.max(1, Math.min(100, policy.wa_alert_threshold_percent)) / 100));
  const reserved = await prisma.$transaction(async tx => {
    await tx.whatsAppUsagePeriod.upsert({
      where: { org_id_period_start: { org_id: policy.id, period_start: periodStart } },
      create: { org_id: policy.id, period_start: periodStart },
      update: {},
    });
    const result = await tx.whatsAppUsagePeriod.updateMany({
      where: {
        org_id: policy.id,
        period_start: periodStart,
        ...(limit !== null ? { messages_reserved: { lt: limit } } : {}),
      },
      data: {
        messages_reserved: { increment: 1 },
        ...(policy.wa_estimated_cost_per_message !== null && {
          priced_messages: { increment: 1 },
          estimated_cost: { increment: policy.wa_estimated_cost_per_message },
        }),
      },
    });
    const usage = await tx.whatsAppUsagePeriod.findUniqueOrThrow({
      where: { org_id_period_start: { org_id: policy.id, period_start: periodStart } },
    });
    return { allowed: result.count === 1, usage };
  });

  if (threshold !== null && limit !== null && threshold < limit && reserved.usage.messages_reserved >= threshold) {
    await notifyWhatsAppAdmins(policy.id, periodStart, 'threshold', reserved.usage.messages_reserved, limit);
  }
  if (limit !== null && reserved.usage.messages_reserved >= limit) {
    await notifyWhatsAppAdmins(policy.id, periodStart, 'limit', reserved.usage.messages_reserved, limit);
  }

  return {
    allowed: reserved.allowed,
    period_start: periodStart,
    messages_reserved: reserved.usage.messages_reserved,
    remaining: limit === null ? null : Math.max(0, limit - reserved.usage.messages_reserved),
  };
}

export async function getWhatsAppUsage(orgId: string, requestedMonth?: string) {
  const org = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: {
      timezone: true,
      currency: true,
      wa_monthly_message_limit: true,
      wa_alert_threshold_percent: true,
      wa_estimated_cost_per_message: true,
    },
  });
  if (!org) throw new Error('Organisation not found');
  const periodStart = requestedMonth
    ? new Date(`${requestedMonth}-01T00:00:00.000Z`)
    : localMonthStart(new Date(), org.timezone);
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  const usage = await prisma.whatsAppUsagePeriod.findMany({
    where: { org_id: orgId, period_start: { gte: new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() - 11, 1)), lt: periodEnd } },
    orderBy: { period_start: 'desc' },
  });
  const current = usage.find(row => row.period_start.getTime() === periodStart.getTime());
  const serialize = (row: typeof usage[number]) => ({
    period_start: row.period_start,
    messages_reserved: row.messages_reserved,
    priced_messages: row.priced_messages,
    estimated_cost: row.priced_messages === 0 ? null : Number(row.estimated_cost),
    threshold_alerted_at: row.threshold_alerted_at,
    quota_alerted_at: row.quota_alerted_at,
  });
  const used = current?.messages_reserved ?? 0;
  return {
    month: periodStart.toISOString().slice(0, 7),
    timezone: org.timezone,
    currency: org.currency,
    quota: org.wa_monthly_message_limit,
    warning_threshold_percent: org.wa_alert_threshold_percent,
    estimated_cost_per_message: org.wa_estimated_cost_per_message === null ? null : Number(org.wa_estimated_cost_per_message),
    usage: current ? serialize(current) : {
      period_start: periodStart,
      messages_reserved: 0,
      priced_messages: 0,
      estimated_cost: org.wa_estimated_cost_per_message === null ? null : 0,
      threshold_alerted_at: null,
      quota_alerted_at: null,
    },
    remaining: org.wa_monthly_message_limit === null ? null : Math.max(0, org.wa_monthly_message_limit - used),
    recent_periods: usage.map(serialize),
  };
}
