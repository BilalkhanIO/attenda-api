import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import prisma from '../utils/prisma';
import redis from '../utils/redis';

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
  | 'shift_changed';

const orgEvents = new EventEmitter();
orgEvents.setMaxListeners(0); // one listener per SSE connection — unbounded
const EVENT_CHANNEL = 'attenda:org-events:v1';
const INSTANCE_ID = randomUUID();
let eventSubscriber: Redis | null = null;

const EVENT_TYPES = new Set<OrgEventType>([
  'attendance_changed', 'leave_changed', 'overtime_changed', 'remote_changed',
  'swap_changed', 'expense_changed', 'project_changed', 'shift_changed',
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
  // Second, independent fan-out channel (outbound webhook delivery). Kept
  // outside the SSE try so a webhook listener failure can never affect SSE.
  try {
    orgEvents.emit('org:*', orgId, type);
  } catch (e) {
    console.error('[Notifications] emitOrgEvent wildcard fanout failed:', e);
  }
}

/** Awaitable event publication used after an outbox row is claimed. */
export async function publishOutboxOrgEvent(orgId: string, type: OrgEventType, eventId: string): Promise<void> {
  try { orgEvents.emit(`org:${orgId}`, type, eventId); } catch (error) {
    console.error('[Notifications] local outbox fanout failed:', error);
  }
  await redis.publish(EVENT_CHANNEL, JSON.stringify({ orgId, type, eventId, source: INSTANCE_ID }));
}

/** Subscribe to every org's events (used by the outbound-webhook fan-out).
 *  Returns an unsubscribe fn. */
export function subscribeAllOrgEvents(
  listener: (orgId: string, type: OrgEventType) => void,
): () => void {
  orgEvents.on('org:*', listener);
  return () => orgEvents.off('org:*', listener);
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
  | 'overtime_approved' | 'overtime_rejected' | 'shift_swap_approved' | 'shift_swap_rejected'
  | 'payslip_ready' | 'goal_assigned' | 'review_submitted' | 'shift_reminder'
  | 'account_locked'
  | 'attendance_checkin_review'
  | 'document_added' | 'document_expiring'
  | 'onboarding_assigned' | 'onboarding_complete'
  | 'kudos_received'
  | 'project_member_added' | 'project_task_assigned' | 'project_task_comment' | 'project_task_updated' | 'project_task_deadline'
  | 'shift_availability_requested' | 'shift_availability_decision'
  | 'emergency_shift_offer' | 'emergency_shift_claimed' | 'shift_checkpoint_alert'
  | 'announcement';

export interface NotifPayload {
  userId:      string;
  orgId:       string;
  type:        NotifType;
  title:       string;
  body:        string;
  actionType?: string;
  actionId?:   string;
  metadata?:   Record<string, unknown>;
}

export async function createNotification(payload: NotifPayload): Promise<void> {
  try {
    await prisma.inAppNotification.create({
      data: {
        user_id:     payload.userId,
        org_id:      payload.orgId,
        type:        payload.type,
        title:       payload.title,
        body:        payload.body,
        action_type: payload.actionType ?? null,
        action_id:   payload.actionId   ?? null,
        metadata:    (payload.metadata ?? {}) as object,
      },
    });
  } catch (e) {
    console.error('[Notifications] Failed to create notification:', e);
  }
}
