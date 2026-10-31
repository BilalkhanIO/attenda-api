import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './response';

const SECRET = process.env.JWT_SECRET || 'dev-secret';
export interface AttendanceClockAnchor { user_id: string; org_id: string; server_time: string; nonce: string }

function signature(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueAttendanceClockAnchor(userId: string, orgId: string, now = new Date()): string {
  const payload = Buffer.from(JSON.stringify({ user_id: userId, org_id: orgId, server_time: now.toISOString(), nonce: randomUUID() })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyAttendanceClockAnchor(token: string, userId: string, orgId: string): AttendanceClockAnchor {
  const [payload, provided] = token.split('.');
  if (!payload || !provided) throw new AppError('Offline time proof is missing or invalid. Reconnect and try again.', 409, 'OFFLINE_CHECKIN_REVIEW');
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AppError('Offline time proof is invalid. Reconnect and try again.', 409, 'OFFLINE_CHECKIN_REVIEW');
  try {
    const anchor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AttendanceClockAnchor;
    if (anchor.user_id !== userId || anchor.org_id !== orgId || !Number.isFinite(Date.parse(anchor.server_time))) throw new Error('invalid claims');
    return anchor;
  } catch {
    throw new AppError('Offline time proof is invalid. Reconnect and try again.', 409, 'OFFLINE_CHECKIN_REVIEW');
  }
}
