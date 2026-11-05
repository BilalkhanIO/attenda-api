import { AppError } from './response';
import { verifyAttendanceClockAnchor } from './attendanceClock';

type OfflineEventInput = {
  offline?: boolean;
  idempotency_key?: string;
  client_event_at?: string;
  attendance_clock_anchor?: string;
  device_uptime_ms?: number;
  server_anchor_uptime_ms?: number;
  clock_epoch?: string;
  server_anchor_epoch?: string;
};

/** Resolve offline action time from the signed server anchor and monotonic device clock. */
export function resolveAttendanceEventTime(input: OfflineEventInput, userId: string, orgId: string, receivedAt = new Date()) {
  if (!input.offline) return { eventAt: receivedAt, requiresReview: false, anchorAt: null as Date | null };
  if (!input.idempotency_key || !input.client_event_at || !input.attendance_clock_anchor || input.device_uptime_ms === undefined || input.server_anchor_uptime_ms === undefined || !input.clock_epoch || !input.server_anchor_epoch) {
    throw new AppError('Offline attendance action needs a trusted time anchor. Reconnect before retrying.', 409, 'OFFLINE_EVENT_REVIEW');
  }

  const clientEventAt = new Date(input.client_event_at);
  if (Number.isNaN(clientEventAt.getTime())) throw new AppError('Offline event time is invalid.', 400, 'INVALID_OFFLINE_EVENT_TIME');
  const anchor = verifyAttendanceClockAnchor(input.attendance_clock_anchor, userId, orgId);
  const anchorAt = new Date(anchor.server_time);
  const elapsedMs = input.device_uptime_ms - input.server_anchor_uptime_ms;
  const anchorAgeMs = receivedAt.getTime() - anchorAt.getTime();
  const monotonicValid = input.clock_epoch === input.server_anchor_epoch && elapsedMs >= 0 && elapsedMs <= 12 * 60 * 60_000 && anchorAgeMs >= 0 && anchorAgeMs <= 12 * 60 * 60_000;
  if (!monotonicValid) return { eventAt: receivedAt, requiresReview: true, anchorAt };

  const eventAt = new Date(anchorAt.getTime() + elapsedMs);
  if (eventAt.getTime() > receivedAt.getTime() + 2 * 60_000) throw new AppError('Offline time proof is outside the valid range. Contact your manager.', 409, 'OFFLINE_EVENT_REVIEW');
  const requiresReview = Math.abs(eventAt.getTime() - clientEventAt.getTime()) > 2 * 60_000 || receivedAt.getTime() - eventAt.getTime() > 10 * 60_000 || anchorAgeMs > 10 * 60_000;
  return { eventAt, requiresReview, anchorAt };
}
