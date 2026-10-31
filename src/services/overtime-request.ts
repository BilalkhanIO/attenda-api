import prisma from '../utils/prisma';
import { overtimeRequestSchema } from '../schemas';
import { NotFoundError, ValidationError } from '../utils/response';
import { emitOrgEvent } from './notifications';

export async function submitOvertimeRequest(userId: string, orgId: string, args: unknown) {
  const input = overtimeRequestSchema.parse(args);
  const attendance = await prisma.attendanceRecord.findFirst({ where: { id: input.attendance_id, user_id: userId, org_id: orgId }, include: { shift: true } });
  if (!attendance) throw new NotFoundError('Attendance record');
  if (!attendance.shift?.overtime_enabled || !attendance.shift.overtime_requires_approval || attendance.extra_office_minutes <= 0) throw new ValidationError('No approval-eligible overtime is available for this attendance record');
  const existing = await prisma.overtimeRequest.findUnique({ where: { attendance_id: attendance.id } });
  if (existing && ['pending', 'approved'].includes(existing.status)) throw new ValidationError('An overtime request already exists for this attendance record');
  const request = await prisma.overtimeRequest.upsert({ where: { attendance_id: attendance.id }, update: { requested_minutes: attendance.extra_office_minutes, reason: input.reason?.trim() || null, status: 'pending', reviewed_by: null, reviewed_at: null, rejection_reason: null }, create: { attendance_id: attendance.id, user_id: userId, org_id: orgId, requested_minutes: attendance.extra_office_minutes, reason: input.reason?.trim() || null } });
  emitOrgEvent(orgId, 'overtime_changed');
  return request;
}
