import prisma from '../utils/prisma';
import { ValidationError } from '../utils/response';
import { dateOnlyInTz } from '../utils/shift';
import { createNotification, emitOrgEvent } from './notifications';

export async function submitLeaveRequest(userId: string, orgId: string, args: unknown) {
        const { leaveRequestSchema } = await import('../schemas');
        const parsed = leaveRequestSchema.parse(args);
        const start = new Date(`${parsed.start_date}T00:00:00.000Z`);
        const end = new Date(`${parsed.end_date}T00:00:00.000Z`);
        const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } });
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end || start < dateOnlyInTz(new Date(), org.timezone)) throw new ValidationError('Provide valid future leave dates');
        if (parsed.is_half_day && (parsed.start_date !== parsed.end_date || !['morning', 'afternoon'].includes(parsed.half_day_period ?? ''))) throw new ValidationError('A half-day request requires one date and a morning or afternoon period');
        const hasTime = !!parsed.leave_start_time || !!parsed.leave_end_time;
        if (hasTime && (!parsed.leave_start_time || !parsed.leave_end_time || parsed.start_date !== parsed.end_date || parsed.leave_end_time <= parsed.leave_start_time)) throw new ValidationError('Timed leave requires one date and a valid start and end time');
        if (hasTime && parsed.is_half_day) throw new ValidationError('Choose either timed or half-day leave');
        const { workingDaysForOrg } = await import('./holidays');
        const minutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
        const workingDays = hasTime ? Math.max(0.1, Math.round((minutes(parsed.leave_end_time!) - minutes(parsed.leave_start_time!)) / 480 * 100) / 100) : parsed.is_half_day ? 0.5 : await workingDaysForOrg(orgId, start, end);
        if (workingDays <= 0) throw new ValidationError('The selected dates do not include working days');
        // An AI confirmation can succeed on the server while the mobile client
        // times out before receiving the response. Treat a repeat of the exact
        // pending request as a read of the original submission, not a new one.
        const existingExactRequest = await prisma.leaveRequest.findFirst({
          where: {
            user_id: userId, org_id: orgId, status: 'pending', leave_type: parsed.leave_type,
            start_date: start, end_date: end, is_half_day: !!parsed.is_half_day,
            half_day_period: parsed.is_half_day ? parsed.half_day_period : null,
            leave_start_time: hasTime ? parsed.leave_start_time : null,
            leave_end_time: hasTime ? parsed.leave_end_time : null,
            reason: parsed.reason ?? null,
          },
          include: { user: { select: { id: true, name: true, avatar_url: true, department: true, email: true } }, reviewer: { select: { id: true, name: true } } },
        });
        if (existingExactRequest) return existingExactRequest;
        const overlap = await prisma.leaveRequest.findFirst({ where: { user_id: userId, org_id: orgId, status: { in: ['pending', 'approved'] }, start_date: { lte: end }, end_date: { gte: start }, ...(parsed.is_half_day ? { OR: [{ is_half_day: false }, { is_half_day: true, half_day_period: parsed.half_day_period }] } : {}) } });
        if (overlap) throw new ValidationError('You already have a leave request overlapping these dates');
        if (parsed.leave_type !== 'unpaid') {
          const balance = await prisma.leaveBalance.findFirst({ where: { user_id: userId, org_id: orgId, leave_type: parsed.leave_type, year: start.getUTCFullYear() } });
          if (balance) { const { availableDays } = await import('./leaveAccrual'); if (workingDays > availableDays(balance.total_days, balance.used_days)) throw new ValidationError('Insufficient leave balance'); }
        }
        const request = await prisma.leaveRequest.create({ data: { user_id: userId, org_id: orgId, leave_type: parsed.leave_type, start_date: start, end_date: end, working_days: workingDays, reason: parsed.reason, is_half_day: !!parsed.is_half_day, half_day_period: parsed.is_half_day ? parsed.half_day_period : null, leave_start_time: hasTime ? parsed.leave_start_time : null, leave_end_time: hasTime ? parsed.leave_end_time : null }, include: { user: { select: { id: true, name: true, avatar_url: true, department: true, email: true } }, reviewer: { select: { id: true, name: true } } } });
        const user = await prisma.user.findFirst({ where: { id: userId, org_id: orgId }, select: { name: true, manager_id: true, manager: { select: { phone: true } } } });
        if (user?.manager_id) await createNotification({ userId: user.manager_id, orgId: orgId, type: 'leave_request', title: 'New leave request', body: `${user.name} requested ${workingDays} day(s) of ${parsed.leave_type} leave`, actionType: 'leave_request', actionId: request.id }).catch(console.error);
        if (user?.manager?.phone) { const { notifyLeaveRequest } = await import('./whatsapp'); notifyLeaveRequest(orgId, user.name, parsed.leave_type, `${parsed.start_date} – ${parsed.end_date}`, user.manager.phone).catch(console.error); }
        emitOrgEvent(orgId, 'leave_changed');
        return request;
}
