import prisma from '../utils/prisma';
import { correctionRequestSchema } from '../schemas';
import { ValidationError } from '../utils/response';
import { createNotification, emitOrgEvent } from './notifications';

export async function submitAttendanceCorrection(userId: string, orgId: string, args: unknown) {
  const input = correctionRequestSchema.parse(args);
  const day = new Date(`${input.date}T00:00:00.000Z`);
  const checkIn = input.requested_check_in ? new Date(input.requested_check_in) : null;
  const checkOut = input.requested_check_out ? new Date(input.requested_check_out) : null;
  if (isNaN(day.getTime()) || day > new Date() || (!checkIn && !checkOut) || (checkIn && isNaN(checkIn.getTime())) || (checkOut && isNaN(checkOut.getTime())) || (checkIn && checkOut && checkOut <= checkIn)) throw new ValidationError('Provide a valid past date and corrected check-in or check-out time');
  if (await prisma.attendanceCorrection.findFirst({ where: { user_id: userId, org_id: orgId, date: day, status: 'pending' } })) throw new ValidationError('You already have a pending correction for this date');
  const attendance = await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: userId, date: day } } });
  const request = await prisma.attendanceCorrection.create({ data: { user_id: userId, org_id: orgId, attendance_id: attendance?.id, date: day, requested_check_in: checkIn, requested_check_out: checkOut, reason: input.reason }, include: { user: { select: { id: true, name: true, avatar_url: true, department: true } }, reviewer: { select: { id: true, name: true } } } });
  const user = await prisma.user.findFirst({ where: { id: userId, org_id: orgId }, select: { name: true, manager_id: true } });
  if (user?.manager_id) await createNotification({ userId: user.manager_id, orgId, type: 'correction_request', title: 'Attendance correction requested', body: `${user.name} requested a correction for ${input.date}`, actionType: 'attendance_correction', actionId: request.id }).catch(console.error);
  emitOrgEvent(orgId, 'attendance_changed');
  return request;
}
