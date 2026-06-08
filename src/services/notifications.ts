import prisma from '../utils/prisma';

export type NotifType =
  | 'attendance_checkin' | 'attendance_checkout' | 'attendance_late' | 'attendance_absent'
  | 'attendance_late_escalation'
  | 'leave_request' | 'leave_approved' | 'leave_rejected'
  | 'remote_request' | 'remote_approved' | 'remote_rejected' | 'remote_no_reply'
  | 'payslip_ready' | 'goal_assigned' | 'review_submitted' | 'shift_reminder'
  | 'account_locked';

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
