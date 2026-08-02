import { EventEmitter } from 'events';
import prisma from '../utils/prisma';

// ─── Org event bus (SSE invalidation) ─────────────────
// Lightweight in-process pub/sub: mutation handlers emit a coarse "something
// in <scope> changed for <org>" signal and every SSE connection of that org
// forwards it as {type:'invalidate', scope} so clients can refetch.
//
// LIMITATION: in-process only — with 2+ API instances a client connected to
// instance A misses events emitted on instance B (it still has the 15s count
// poll as a fallback). The multi-instance upgrade is Redis pub/sub: publish
// in emitOrgEvent, subscribe per instance, fan out to local connections.

export type OrgEventType =
  | 'attendance_changed'
  | 'leave_changed'
  | 'overtime_changed'
  | 'remote_changed'
  | 'swap_changed'
  | 'expense_changed';

const orgEvents = new EventEmitter();
orgEvents.setMaxListeners(0); // one listener per SSE connection — unbounded

/** Fire-and-forget: never throws, so a failed emit cannot break a handler. */
export function emitOrgEvent(orgId: string, type: OrgEventType): void {
  try {
    orgEvents.emit(`org:${orgId}`, type);
  } catch (e) {
    console.error('[Notifications] emitOrgEvent failed:', e);
  }
  // Second, independent fan-out channel (outbound webhook delivery). Kept
  // outside the SSE try so a webhook listener failure can never affect SSE.
  try {
    orgEvents.emit('org:*', orgId, type);
  } catch (e) {
    console.error('[Notifications] emitOrgEvent wildcard fanout failed:', e);
  }
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
  listener: (type: OrgEventType) => void,
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
  | 'payslip_ready' | 'goal_assigned' | 'review_submitted' | 'shift_reminder'
  | 'account_locked'
  | 'document_added' | 'document_expiring'
  | 'onboarding_assigned' | 'onboarding_complete'
  | 'kudos_received';

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
