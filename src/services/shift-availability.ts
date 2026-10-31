import prisma from '../utils/prisma';
import { createNotification, emitOrgEvent } from './notifications';
import { resolveUserPermissions } from './authorization';
import { ValidationError } from '../utils/response';

export async function submitShiftAvailability(userId: string, orgId: string, input: Record<string, any>) {
  if (!['preferred', 'unavailable'].includes(input.kind)) throw new ValidationError('kind must be preferred or unavailable');
  const hasDate = typeof input.date === 'string';
  const hasWeekday = Number.isInteger(input.weekday) && input.weekday >= 0 && input.weekday <= 6;
  if (hasDate === hasWeekday) throw new ValidationError('Choose one specific date or a recurring weekday');
  const dateOnly = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${name} must be YYYY-MM-DD`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ValidationError(`${name} is invalid`);
    return date;
  };
  const startTime = input.start_time == null || input.start_time === '' ? null : String(input.start_time);
  const endTime = input.end_time == null || input.end_time === '' ? null : String(input.end_time);
  const validTime = (value: string | null) => value == null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(startTime) || !validTime(endTime) || (!!startTime !== !!endTime) || (startTime && endTime && Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3)) <= Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)))) throw new ValidationError('Provide a valid start and end time, or leave both empty for the full day');
  const note = input.note == null ? null : String(input.note).trim();
  if (note && note.length > 500) throw new ValidationError('Note must be 500 characters or fewer');
  const item = await prisma.shiftAvailability.create({ data: {
    org_id: orgId, user_id: userId,
    ...(hasDate ? { date: dateOnly(input.date, 'date') } : { weekday: input.weekday, starts_on: input.starts_on ? dateOnly(input.starts_on, 'starts_on') : null, ends_on: input.ends_on ? dateOnly(input.ends_on, 'ends_on') : null }),
    start_time: startTime, end_time: endTime, kind: input.kind, note,
  } });
  const users = await prisma.user.findMany({ where: { org_id: orgId, is_active: true, deleted_at: null }, select: { id: true } });
  const managers = await Promise.all(users.map(async user => ({ id: user.id, allowed: (await resolveUserPermissions(user.id, orgId)).has('shifts.availability.manage') })));
  const employee = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  await Promise.all(managers.filter(user => user.allowed).map(user => createNotification({ userId: user.id, orgId, type: 'shift_availability_requested', title: 'Availability request', body: `${employee?.name ?? 'An employee'} submitted a ${item.kind} availability request.`, actionType: 'shift_availability', actionId: item.id })));
  emitOrgEvent(orgId, 'shift_changed');
  return item;
}
