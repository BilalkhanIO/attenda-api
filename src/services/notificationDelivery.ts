import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { sendEmail } from './email';
import { isPushConfigured, sendUserNotification } from './pushChallenge';
import { normalizeNotificationPrefs } from './notifications';
import { jobLogger } from '../utils/logger';

const MAX_ATTEMPTS = 8;
type DeliveryWithRelations = Prisma.NotificationDeliveryGetPayload<{
  include: {
    user: { select: { id: true; email: true; phone: true; whatsapp_opted_in_at: true; is_active: true; notification_prefs: true } };
    organisation: { select: { timezone: true } };
  };
}>;

function quietHoursEnd(now: Date, timezone: string, settings: Record<string, unknown>): Date | null {
  if (settings.enabled !== true) return null;
  const start = String(settings.start || '22:00'); const end = String(settings.end || '08:00');
  const [sh, sm] = start.split(':').map(Number); const [eh, em] = end.split(':').map(Number);
  const local = toZonedTime(now, timezone); const minute = local.getHours() * 60 + local.getMinutes();
  const startMinute = sh * 60 + sm; const endMinute = eh * 60 + em;
  const isQuiet = startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
  if (!isQuiet) return null;
  const endDay = startMinute >= endMinute && minute >= startMinute
    ? new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate() + 1))
    : new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  const dateKey = `${endDay.getUTCFullYear()}-${String(endDay.getUTCMonth() + 1).padStart(2, '0')}-${String(endDay.getUTCDate()).padStart(2, '0')}`;
  return fromZonedTime(`${dateKey}T${end}`, timezone);
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export async function deliverNotificationBatch(now = new Date()): Promise<void> {
  await prisma.notificationDelivery.updateMany({
    where: { status: 'sending', updated_at: { lte: new Date(now.getTime() - 10 * 60_000) } },
    data: { status: 'queued', available_at: now, last_error: 'Recovered after an interrupted delivery attempt' },
  });
  const due = await prisma.notificationDelivery.findMany({
    where: { status: 'queued', available_at: { lte: now } }, orderBy: { available_at: 'asc' }, take: 100,
    include: { user: { select: { id: true, email: true, phone: true, whatsapp_opted_in_at: true, fcm_token: true, is_active: true, notification_prefs: true } }, organisation: { select: { timezone: true } } },
  });
  const processedDigestUsers = new Set<string>();
  for (const item of due) {
    if (!item.user.is_active) {
      await prisma.notificationDelivery.updateMany({ where: { id: item.id, status: 'queued' }, data: { status: 'suppressed' } });
      continue;
    }
    const prefs = normalizeNotificationPrefs(item.user.notification_prefs);
    const channels = prefs.channels as Record<string, boolean>;
    const categories = prefs.categories as Record<string, boolean>;
    const category = categoryFor(item.event_type);
    if ((category && categories[category] === false) || channels[item.channel] === false) {
      await prisma.notificationDelivery.updateMany({ where: { id: item.id, status: 'queued' }, data: { status: 'suppressed' } });
      continue;
    }
    const delay = quietHoursEnd(now, item.organisation.timezone || 'UTC', prefs.quiet_hours as Record<string, unknown>);
    if (delay) {
      await prisma.notificationDelivery.updateMany({ where: { id: item.id, status: 'queued' }, data: { available_at: delay } });
      continue;
    }
    if (item.channel === 'email' && prefs.digest !== 'off') {
      if (processedDigestUsers.has(item.user_id)) continue;
      processedDigestUsers.add(item.user_id);
      await sendEmailDigest(item.user_id, item.org_id, now);
      continue;
    }
    await sendOne(item, now);
  }
}

function categoryFor(type: string): string | null {
  if (type === 'account_locked' || type === 'webhook_disabled' || type === 'offboarding_access_revoked') return 'security';
  if (type.startsWith('attendance_') || type.startsWith('late_') || type.endsWith('_nudge') || type === 'leave_checkin_override') return 'attendance';
  if (type.startsWith('leave_') || type.startsWith('remote_') || type.startsWith('correction_') || type.startsWith('expense_') || type.startsWith('overtime_') || type.startsWith('shift_swap_')) return 'requests';
  if (type.startsWith('shift_') || type.startsWith('emergency_shift_')) return 'shifts';
  if (type.startsWith('project_') || type.startsWith('timesheet_')) return 'projects';
  if (type.startsWith('document_') || type.startsWith('onboarding_')) return 'documents';
  if (type === 'payslip_ready') return 'payroll';
  if (type === 'announcement') return 'announcements';
  return null;
}

async function sendOne(item: DeliveryWithRelations, now: Date): Promise<void> {
  const claimed = await prisma.notificationDelivery.updateMany({
    where: { id: item.id, status: 'queued', available_at: { lte: now } },
    data: { status: 'sending', attempts: { increment: 1 } },
  });
  if (!claimed.count) return;
  try {
    if (item.channel === 'push') {
      if (!isPushConfigured()) throw Object.assign(new Error('Push delivery is not configured'), { permanent: true });
      const result = await sendUserNotification(item.user_id, item.title, item.body, { type: item.action_type ?? undefined, id: item.action_id ?? undefined });
      if (!result.sent) throw Object.assign(new Error(result.permanentFailure ? 'No valid push device is registered' : 'Push provider temporarily failed'), { permanent: result.permanentFailure });
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { status: 'sent', provider_ref: result.providerRef, sent_at: new Date(), last_error: null } });
    } else if (item.channel === 'whatsapp') {
      if (!item.user.phone || !item.user.whatsapp_opted_in_at) throw Object.assign(new Error('WhatsApp consent or phone number is missing'), { permanent: true });
      const { sendPersonalWhatsAppNotification } = await import('./whatsapp');
      const result = await sendPersonalWhatsAppNotification(item.org_id, item.user.phone, `${item.title}\n${item.body}`);
      if (!result.sent) throw Object.assign(new Error('WhatsApp provider could not deliver the message'), { permanent: result.permanentFailure });
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { status: 'sent', sent_at: new Date(), last_error: null } });
    } else {
      if (!item.user.email) throw Object.assign(new Error('No email address is configured'), { permanent: true });
      await sendEmail({ to: item.user.email, subject: item.title, text: item.body, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.body)}</p><p style="color:#667085">Sent by Attenda</p></div>` });
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { status: 'sent', sent_at: new Date(), last_error: null } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Notification delivery failed';
    const permanent = Boolean((error as { permanent?: boolean }).permanent);
    const attempts = item.attempts + 1;
    await prisma.notificationDelivery.update({ where: { id: item.id }, data: {
      status: permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      available_at: new Date(now.getTime() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7))),
      last_error: message.slice(0, 1000),
    } });
    jobLogger.warn({ deliveryId: item.id, channel: item.channel, attempts, permanent, error: message }, 'notification channel delivery failed');
  }
}

async function sendEmailDigest(userId: string, orgId: string, now: Date): Promise<void> {
  const queued = await prisma.notificationDelivery.findMany({
    where: { user_id: userId, org_id: orgId, channel: 'email', status: 'queued', available_at: { lte: now } },
    orderBy: { created_at: 'asc' }, take: 100,
    include: { user: { select: { email: true, notification_prefs: true } }, organisation: { select: { timezone: true } } },
  });
  if (!queued.length) return;
  const first = queued[0];
  const prefs = normalizeNotificationPrefs(first.user.notification_prefs);
  const categories = prefs.categories as Record<string, boolean>;
  const eligible = queued.filter(row => {
    const category = categoryFor(row.event_type);
    return (category === null || categories[category] !== false) && (prefs.channels as Record<string, boolean>).email !== false;
  });
  const suppressed = queued.filter(row => !eligible.some(item => item.id === row.id));
  if (suppressed.length) await prisma.notificationDelivery.updateMany({ where: { id: { in: suppressed.map(row => row.id) }, status: 'queued' }, data: { status: 'suppressed' } });
  if (!eligible.length) return;
  const delay = quietHoursEnd(now, first.organisation.timezone || 'UTC', prefs.quiet_hours as Record<string, unknown>);
  if (delay) {
    await prisma.notificationDelivery.updateMany({ where: { id: { in: eligible.map(row => row.id) }, status: 'queued' }, data: { available_at: delay } });
    return;
  }
  if (!first.user.email) {
    await prisma.notificationDelivery.updateMany({ where: { id: { in: eligible.map(row => row.id) }, status: 'queued' }, data: { status: 'failed', last_error: 'No email address is configured' } });
    return;
  }
  const claimed = await prisma.notificationDelivery.updateMany({ where: { id: { in: eligible.map(row => row.id) }, status: 'queued' }, data: { status: 'sending', attempts: { increment: 1 } } });
  if (!claimed.count) return;
  try {
    const items = eligible.map(row => `<li style="margin:0 0 14px"><strong>${escapeHtml(row.title)}</strong><br>${escapeHtml(row.body)}</li>`).join('');
    await sendEmail({ to: first.user.email, subject: `Attenda notification digest (${eligible.length})`, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Your Attenda updates</h2><ul>${items}</ul></div>` });
    await prisma.notificationDelivery.updateMany({ where: { id: { in: eligible.map(row => row.id) }, status: 'sending' }, data: { status: 'sent', sent_at: new Date(), last_error: null } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email digest delivery failed';
    await Promise.all(eligible.map(row => prisma.notificationDelivery.updateMany({
      where: { id: row.id, status: 'sending' },
      data: {
        status: row.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued',
        available_at: new Date(now.getTime() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(row.attempts, 7))),
        last_error: message.slice(0, 1000),
      },
    })));
    jobLogger.warn({ userId, deliveries: eligible.length, error: message }, 'notification digest failed');
  }
}
