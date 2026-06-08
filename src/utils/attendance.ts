// Shared attendance finalization helpers used by every checkout path
// (manual checkout, shift auto-checkout, IP grace-period checkout, midnight
// safety net) so break accounting and net-hours math stay consistent.
import prisma from './prisma';

export interface BreakSettlement {
  paidMins:  number;
  unpaidMins: number;
  totalMins: number;
}

/**
 * Compute how many minutes late an employee returned from a break.
 * Returns null when there is no linked policy (ad-hoc break) or the
 * information needed to compute lateness is unavailable.
 */
function calcLateReturnMins(
  shiftBreak: { break_kind: string; break_minutes: number; break_end_time?: string | null } | null,
  breakEnd: Date,
  orgTimezone: string,
  durationMins: number,
): number | null {
  if (!shiftBreak) return null;

  if (shiftBreak.break_kind === 'fixed' && shiftBreak.break_end_time) {
    const { fromZonedTime, toZonedTime } = require('date-fns-tz');
    const [h, m] = shiftBreak.break_end_time.split(':').map(Number);
    const localNow  = toZonedTime(breakEnd, orgTimezone);
    const localEnd  = new Date(localNow);
    localEnd.setHours(h, m, 0, 0);
    const scheduledEndUtc = fromZonedTime(localEnd, orgTimezone);
    return Math.max(0, Math.round((breakEnd.getTime() - scheduledEndUtc.getTime()) / 60000));
  }

  if (shiftBreak.break_kind === 'flexible') {
    return Math.max(0, durationMins - shiftBreak.break_minutes);
  }

  return null;
}

/**
 * Close any still-open break for an attendance record (marking it auto_ended),
 * then return the paid / unpaid / total break minutes for the day.
 * Called at checkout so an employee who forgot to end a break isn't credited
 * for break time as work time.
 *
 * @param orgTimezone  IANA timezone string used to convert fixed break wall-clock
 *                     end times to UTC for late-return calculation.
 */
export async function settleBreaks(attendanceId: string, at: Date, orgTimezone = 'UTC'): Promise<BreakSettlement> {
  const open = await prisma.breakRecord.findMany({
    where: { attendance_id: attendanceId, break_end: null },
    include: { shift_break: true },
  });
  for (const b of open) {
    const mins           = Math.max(0, Math.round((at.getTime() - b.break_start.getTime()) / 60000));
    const lateReturnMins = calcLateReturnMins(b.shift_break as any, at, orgTimezone, mins);
    await prisma.breakRecord.update({
      where: { id: b.id },
      data:  { break_end: at, duration_mins: mins, auto_ended: true, late_return_minutes: lateReturnMins, wifi_on_at_end: false } as any,
    });
  }

  const all = await prisma.breakRecord.findMany({
    where: { attendance_id: attendanceId, break_end: { not: null } },
  });
  
  const paidMins   = all.filter(b => b.is_paid).reduce((s, b) => s + (b.duration_mins || 0), 0);
  let unpaidMins = all.filter(b => !b.is_paid).reduce((s, b) => s + (b.duration_mins || 0), 0);

  // Auto-deduct any mandatory flexible shift breaks that the employee missed taking.
  const attendance = await prisma.attendanceRecord.findUnique({
    where: { id: attendanceId },
    include: { shift: { include: { breaks: true } } }
  });

  if (attendance?.shift?.breaks && attendance.check_in_at) {
    const minutesSinceCheckIn = Math.round((at.getTime() - attendance.check_in_at.getTime()) / 60000);
    let missingUnpaid = 0;

    for (const shiftBreak of (attendance.shift.breaks as any[])) {
      if (shiftBreak.break_kind === 'flexible') continue;
      const deductIfSkipped = (shiftBreak as any).deduct_if_skipped ?? true;
      if (!deductIfSkipped) continue;
      if (shiftBreak.is_paid) continue;

      // Gate: use the wall-clock break_end_time when available (same anchor as
      // startShiftBreakAutoManager), so deduction and auto-start share one reference.
      // Fall back to after_minutes when the break has no wall-clock window defined.
      if (shiftBreak.break_end_time) {
        const { fromZonedTime, toZonedTime } = require('date-fns-tz');
        const [h, m] = (shiftBreak.break_end_time as string).split(':').map(Number);
        const localAt = toZonedTime(at, orgTimezone);
        const localEnd = new Date(localAt);
        localEnd.setHours(h, m, 0, 0);
        const breakEndUtc = fromZonedTime(localEnd, orgTimezone);
        if (at <= breakEndUtc) continue; // break window hasn't passed yet — don't deduct
      } else {
        if (minutesSinceCheckIn <= shiftBreak.after_minutes) continue;
      }
      const takenForTemplate = all
        .filter(b => b.shift_break_id === shiftBreak.id)
        .reduce((s, b) => s + (b.duration_mins || 0), 0);
      const templateMissing = Math.max(0, shiftBreak.break_minutes - takenForTemplate);
      if (templateMissing <= 0) continue;

      const compStart = new Date(at.getTime() - templateMissing * 60000);
      await prisma.breakRecord.create({
        data: {
          attendance_id: attendanceId,
          shift_break_id: shiftBreak.id,
          break_start: compStart,
          break_end: at,
          duration_mins: templateMissing,
          is_paid: false,
          break_type: 'auto_deducted',
          auto_started: true,
          auto_ended: true,
        },
      });
      missingUnpaid += templateMissing;
    }
    unpaidMins += missingUnpaid;
  }

  return { paidMins, unpaidMins, totalMins: paidMins + unpaidMins };
}

/**
 * Net hours actually worked = gross hours minus UNPAID break time.
 * Paid breaks count as work time, so they're not subtracted.
 */
export function netHoursWorked(grossHours: number, unpaidBreakMins: number): number {
  const net = grossHours - unpaidBreakMins / 60;
  return parseFloat(Math.max(0, net).toFixed(2));
}
