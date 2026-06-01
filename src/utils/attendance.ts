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
 * Close any still-open break for an attendance record (marking it auto_ended),
 * then return the paid / unpaid / total break minutes for the day.
 * Called at checkout so an employee who forgot to end a break isn't credited
 * for break time as work time.
 */
export async function settleBreaks(attendanceId: string, at: Date): Promise<BreakSettlement> {
  const open = await prisma.breakRecord.findMany({ where: { attendance_id: attendanceId, break_end: null } });
  for (const b of open) {
    const mins = Math.max(0, Math.round((at.getTime() - b.break_start.getTime()) / 60000));
    await prisma.breakRecord.update({
      where: { id: b.id },
      data:  { break_end: at, duration_mins: mins, auto_ended: true },
    });
  }

  const all = await prisma.breakRecord.findMany({
    where: { attendance_id: attendanceId, break_end: { not: null } },
  });
  const paidMins   = all.filter(b => b.is_paid).reduce((s, b) => s + (b.duration_mins || 0), 0);
  const unpaidMins = all.filter(b => !b.is_paid).reduce((s, b) => s + (b.duration_mins || 0), 0);
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
