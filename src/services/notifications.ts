import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import prisma from '../utils/prisma';
import redis from '../utils/redis';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

// Organization event bus: local delivery for this process plus Redis pub/sub
// fan-out so SSE clients connected to any API instance receive invalidations.

export type OrgEventType =
  | 'attendance_changed'
  | 'leave_changed'
  | 'overtime_changed'
  | 'remote_changed'
  | 'swap_changed'
  | 'expense_changed'
  | 'project_changed'
  | 'timesheet_changed'
  | 'shift_changed'
  | 'notification_changed';

const orgEvents = new EventEmitter();
orgEvents.setMaxListeners(0); // one listener per SSE connection — unbounded
const EVENT_CHANNEL = 'attenda:org-events:v1';
const INSTANCE_ID = randomUUID();
let eventSubscriber: Redis | null = null;

const EVENT_TYPES = new Set<OrgEventType>([
  'attendance_changed', 'leave_changed', 'overtime_changed', 'remote_changed',
  'swap_changed', 'expense_changed', 'project_changed', 'shift_changed', 'timesheet_changed', 'notification_changed',
]);

/** Start the cross-instance fan-out subscriber. Safe to call once at startup. */
export async function startOrgEventBus(): Promise<void> {
  if (eventSubscriber) return;
  const subscriber = redis.duplicate();
  subscriber.on('message', (channel, message) => {
    if (channel !== EVENT_CHANNEL) return;
    try {
      const event = JSON.parse(message) as { orgId?: unknown; type?: unknown; eventId?: unknown; source?: unknown };
      if (event.source === INSTANCE_ID || typeof event.orgId !== 'string' || !EVENT_TYPES.has(event.type as OrgEventType)) return;
      orgEvents.emit(`org:${event.orgId}`, event.type as OrgEventType, typeof event.eventId === 'string' ? event.eventId : randomUUID());
    } catch (error) {
      console.error('[Notifications] Invalid Redis organization event:', error);
    }
  });
  subscriber.on('error', error => console.error('[Notifications] Redis event subscriber error:', error.message));
  // ioredis restores subscriptions after reconnects. Keeping the subscriber
  // alive also lets an instance recover if Redis is temporarily unavailable
  // during API startup.
  subscriber.on('ready', () => {
    void subscriber.subscribe(EVENT_CHANNEL).catch(error =>
      console.error('[Notifications] Redis event resubscribe failed:', error.message),
    );
  });

  try {
    if (subscriber.status === 'wait') await subscriber.connect();
    await subscriber.subscribe(EVENT_CHANNEL);
    eventSubscriber = subscriber;
  } catch (error) {
    // Retain ioredis' reconnect loop; local SSE remains available while the
    // cross-instance bus recovers. The ready handler subscribes on recovery.
    eventSubscriber = subscriber;
    console.error('[Notifications] Redis event subscriber is reconnecting; cross-instance SSE fan-out is temporarily delayed:', error);
  }
}

export async function stopOrgEventBus(): Promise<void> {
  const subscriber = eventSubscriber;
  eventSubscriber = null;
  if (!subscriber) return;
  try { await subscriber.quit(); } catch { subscriber.disconnect(); }
}

/** Fire-and-forget: never throws, so a failed emit cannot break a handler. */
export function emitOrgEvent(orgId: string, type: OrgEventType): void {
  const eventId = randomUUID();
  try {
    orgEvents.emit(`org:${orgId}`, type, eventId);
  } catch (e) {
    console.error('[Notifications] emitOrgEvent failed:', e);
  }
  void redis.publish(EVENT_CHANNEL, JSON.stringify({ orgId, type, eventId, source: INSTANCE_ID }))
    .catch(error => console.error('[Notifications] Redis event publish failed:', error));
}

/** Awaitable event publication used after an outbox row is claimed. */
export async function publishOutboxOrgEvent(orgId: string, type: OrgEventType, eventId: string, schemaVersion = 1): Promise<void> {
  try { orgEvents.emit(`org:${orgId}`, type, eventId); } catch (error) {
    console.error('[Notifications] local outbox fanout failed:', error);
  }
  await redis.publish(EVENT_CHANNEL, JSON.stringify({ orgId, type, eventId, schema_version: schemaVersion, source: INSTANCE_ID }));
}

/** Subscribe an SSE connection to its org's events. Returns an unsubscribe fn. */
export function subscribeOrgEvents(
  orgId: string,
  listener: (type: OrgEventType, eventId?: string) => void,
): () => void {
  const key = `org:${orgId}`;
  orgEvents.on(key, listener);
  return () => orgEvents.off(key, listener);
}

export type NotifType =
  | 'attendance_checkin' | 'attendance_checkout' | 'attendance_late' | 'attendance_absent'
  | 'attendance_late_escalation' | 'attendance_early_in' | 'attendance_early_out' | 'late_pattern'
  | 'late_notice' | 'late_notice_ack' | 'leave_checkin_override'
  | 'correction_request' | 'correction_approved' | 'correction_rejected'
  | 'expense_request' | 'expense_approved' | 'expense_rejected' | 'expense_reimbursed'
  | 'leave_request' | 'leave_approved' | 'leave_rejected'
  | 'remote_request' | 'remote_approved' | 'remote_rejected' | 'remote_no_reply'
  | 'remote_morning_nudge' | 'remote_midday_nudge' | 'remote_eod_nudge'
  | 'overtime_approved' | 'overtime_rejected' | 'shift_swap_approved' | 'shift_swap_rejected'
  | 'payslip_ready' | 'goal_assigned' | 'review_submitted' | 'shift_reminder'
  | 'account_locked'
  | 'attendance_checkin_review'
  | 'document_added' | 'document_expiring'
  | 'onboarding_assigned' | 'onboarding_complete'
  | 'kudos_received'
  | 'timesheet_submitted' | 'timesheet_approved' | 'timesheet_rejected'
  | 'project_member_added' | 'project_task_assigned' | 'project_task_comment' | 'project_task_updated' | 'project_task_deadline'
  | 'shift_availability_requested' | 'shift_availability_decision'
  | 'emergency_shift_offer' | 'emergency_shift_claimed' | 'shift_checkpoint_alert'
  | 'announcement' | 'webhook_disabled' | 'offboarding_access_revoked';

export interface NotifPayload {
  userId:      string;
  orgId:       string;
  type:        NotifType;
  title:       string;
  body:        string;
  actionType?: string;
  actionId?:   string;
  metadata?:   Record<string, unknown>;
  dedupeKey?:  string;
}

const DEFAULT_NOTIFICATION_CATEGORIES: Record<string, boolean> = {
  attendance: true, requests: true, shifts: true, projects: true,
  payroll: true, announcements: true, documents: true, security: true,
};

/** Canonical structured preferences; root-level legacy flags are intentionally unsupported. */
export function normalizeNotificationPrefs(value: unknown): Record<string, unknown> {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const categoriesRaw = raw.categories && typeof raw.categories === 'object' && !Array.isArray(raw.categories)
    ? raw.categories as Record<string, unknown> : {};
  const categories: Record<string, boolean> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_NOTIFICATION_CATEGORIES)) {
    categories[key] = typeof categoriesRaw[key] === 'boolean' ? categoriesRaw[key] as boolean : fallback;
  }
  const channelsRaw = raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)
    ? raw.channels as Record<string, unknown> : {};
  const quiet = raw.quiet_hours && typeof raw.quiet_hours === 'object' && !Array.isArray(raw.quiet_hours)
    ? raw.quiet_hours as Record<string, unknown> : {};
  return {
    categories,
    channels: {
      in_app: typeof channelsRaw.in_app === 'boolean' ? channelsRaw.in_app : true,
      push: typeof channelsRaw.push === 'boolean' ? channelsRaw.push : true,
      email: typeof channelsRaw.email === 'boolean' ? channelsRaw.email : false,
      whatsapp: typeof channelsRaw.whatsapp === 'boolean' ? channelsRaw.whatsapp : false,
    },
    quiet_hours: {
      enabled: quiet.enabled === true,
      start: typeof quiet.start === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) ? quiet.start : '22:00',
      end: typeof quiet.end === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end) ? quiet.end : '08:00',
    },
    digest: raw.digest === 'daily' || raw.digest === 'weekly' ? raw.digest : 'off',
  };
}

function notificationCategory(type: NotifType): string | null {
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

export async function createNotification(payload: NotifPayload): Promise<boolean> {
  try {
    const userPrefs = await prisma.user.findFirst({
      where: { id: payload.userId, org_id: payload.orgId, is_active: true },
      select: { notification_prefs: true, email: true, phone: true, whatsapp_opted_in_at: true },
    });
    if (!userPrefs) return true;
    const prefs = normalizeNotificationPrefs(userPrefs.notification_prefs);
    const category = notificationCategory(payload.type);
    const categories = prefs.categories as Record<string, boolean>;
    if (category && categories[category] === false) return true;
    const channels = prefs.channels as Record<string, boolean>;
    const deliveryChannels = [
      ...(channels.push ? ['push'] : []),
      ...(channels.email && userPrefs.email ? ['email'] : []),
      ...(channels.whatsapp && userPrefs.phone && userPrefs.whatsapp_opted_in_at ? ['whatsapp'] : []),
    ];
    const org = deliveryChannels.length
      ? await prisma.organisation.findUnique({ where: { id: payload.orgId }, select: { timezone: true } })
      : null;
    const eventId = payload.dedupeKey && payload.dedupeKey.length <= 36 ? payload.dedupeKey : randomUUID();
    const now = new Date();
    const emailDigest = prefs.digest as string;
    const digestAt = emailDigest === 'off' ? now : nextDigestAt(emailDigest, org?.timezone || 'UTC', now);
    await prisma.$transaction(async tx => {
      if (channels.in_app) {
        const notification = {
          user_id: payload.userId, org_id: payload.orgId, type: payload.type,
          title: payload.title, body: payload.body, action_type: payload.actionType ?? null,
          action_id: payload.actionId ?? null, metadata: (payload.metadata ?? {}) as object,
          dedupe_key: payload.dedupeKey ?? null,
        };
        if (payload.dedupeKey) await tx.inAppNotification.createMany({ data: [notification], skipDuplicates: true });
        else await tx.inAppNotification.create({ data: notification });
      }
      if (deliveryChannels.length) await tx.notificationDelivery.createMany({
        data: deliveryChannels.map(channel => ({
          org_id: payload.orgId, user_id: payload.userId, event_id: eventId,
          event_type: payload.type, channel, title: payload.title, body: payload.body,
          action_type: payload.actionType ?? null, action_id: payload.actionId ?? null,
          available_at: channel === 'email' ? digestAt : now,
        })),
        skipDuplicates: true,
      });
    });
    emitOrgEvent(payload.orgId, 'notification_changed');
    return true;
  } catch (e) {
    console.error('[Notifications] Failed to create notification:', e);
    return false;
  }
}

function nextDigestAt(cadence: string, timezone: string, now: Date): Date {
  const local = toZonedTime(now, timezone);
  let localDate = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  if (cadence === 'weekly') {
    const daysUntilMonday = (8 - local.getDay()) % 7;
    localDate = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate() + daysUntilMonday));
  }
  const toInstant = (date: Date) => {
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    return fromZonedTime(`${key}T08:00:00`, timezone);
  };
  let candidate = toInstant(localDate);
  if (candidate <= now) {
    localDate = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate() + (cadence === 'weekly' ? 7 : 1)));
    candidate = toInstant(localDate);
  }
  return candidate;
}
