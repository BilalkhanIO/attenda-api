// @ts-nocheck
import cron from 'node-cron';
import { toZonedTime } from 'date-fns-tz';
import prisma from '../utils/prisma';
import {
  notifyLateArrival, notifyAbsent, notifyCheckOut,
  sendRemoteNudge, notifyShiftReminder, formatTime12h, notify
} from '../services/whatsapp';
import {
  minutesOfDayInTz, hhmmToMins, lateThresholdFor, earlyOutMinutes, adherenceScore, dateOnlyInTz
} from '../utils/shift';
import { settleBreaks, netHoursWorked } from '../utils/attendance';

// ─── Job: Late Arrival Detector ───────────────────────
export function startLateArrivalDetector() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true, late_threshold: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();

        const employees = await prisma.user.findMany({
          where: { org_id: org.id, is_active: true, deleted_at: null },
          include: { manager: true },
        });

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });
        const orgWideShift = shifts.find(s => s.is_org_wide);
        const defaultShift = shifts.find(s => s.is_default);

        const assignments = await prisma.shiftAssignment.findMany({
          where: { date: orgToday, user_id: { in: employees.map(e => e.id) } },
          include: { shift: true },
        });
        const assignMap = new Map(assignments.map(a => [a.user_id, a.shift]));

        const [records, lateNotices] = await Promise.all([
          prisma.attendanceRecord.findMany({ where: { org_id: org.id, date: orgToday } }),
          prisma.lateArrivalNotice.findMany({ where: { org_id: org.id, date: orgToday, status: { not: 'cancelled' } } }),
        ]);
        const recordMap = new Map(records.map(r => [r.user_id, r]));
        const noticeMap = new Map(lateNotices.map(n => [n.user_id, n]));

        for (const user of employees) {
          const shift = assignMap.get(user.id) || orgWideShift || defaultShift;
          if (!shift) continue;

          const record = recordMap.get(user.id);
          if (record?.check_in_at) continue;
          if (record && ['leave', 'half_leave', 'absent'].includes(record.status)) continue;

          const shiftStartMins = hhmmToMins(shift.start_time);
          const nowMins = minutesOfDayInTz(now, tz);
          let diffMins = nowMins - shiftStartMins;
          if (diffMins < -720) diffMins += 1440;

          const tolerance = lateThresholdFor(shift, org);
          if (diffMins <= tolerance || diffMins >= 720) continue;

          const notice = noticeMap.get(user.id);
          if (notice && nowMins <= hhmmToMins(notice.expected_time)) continue;

          if (!record || record.status !== 'late') {
            await prisma.attendanceRecord.upsert({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              update: { status: 'late' },
              create: { user_id: user.id, org_id: org.id, date: orgToday, check_in_type: 'manual', status: 'late', shift_id: shift.id },
            });
          }

          const shouldAlert = diffMins >= 30;
          const shouldEscalate = diffMins >= 60;
          const wasPreAnnounced = !!notice;
          const preAnnouncedSuffix = wasPreAnnounced ? ` (had a late notice — expected by ${notice!.expected_time})` : '';

          if (shouldAlert && !record?.late_alerted) {
            if (user.manager?.phone) {
              await notifyLateArrival(org.id, user.name, diffMins, user.manager.phone).catch(() => {});
            }
            if (user.manager_id) {
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: user.manager_id, orgId: org.id,
                type: 'attendance_late',
                title: wasPreAnnounced ? 'Employee late (past expected time)' : 'Employee late',
                body: `${user.name} is ${diffMins} minutes late and has not checked in${preAnnouncedSuffix}`,
                actionType: 'attendance', actionId: user.id,
              }).catch(console.error);
            }
            await prisma.attendanceRecord.update({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              data: { late_alerted: true },
            }).catch(() => {});
          }

          if (shouldEscalate && !record?.hour_alerted) {
            const hrAdmins = await prisma.user.findMany({
              where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true },
              select: { id: true, phone: true },
            });
            const escalMsg = `🚨 *1-Hour Late Alert*\n${user.name} has not checked in 60+ minutes past shift start${preAnnouncedSuffix}.\nPlease check on them.`;

            for (const admin of hrAdmins) {
              if (admin.phone) {
                await notify({ orgId: org.id, event: 'shift_reminder', message: escalMsg, recipientType: 'individual', recipientId: admin.phone }).catch(() => {});
              }
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: admin.id, orgId: org.id,
                type: 'attendance_late_escalation',
                title: '1-hour late escalation',
                body: `${user.name} still has not checked in — 60+ min past shift start${preAnnouncedSuffix}`,
                actionType: 'attendance', actionId: user.id,
              }).catch(console.error);
            }
            if (user.manager?.phone) {
              await notify({ orgId: org.id, event: 'shift_reminder', message: escalMsg, recipientType: 'individual', recipientId: user.manager.phone }).catch(() => {});
            }
            await prisma.attendanceRecord.update({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              data: { hour_alerted: true },
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Late arrival detector error:', err);
    }
  });
  console.log('⏰ Late arrival detector started');
}

// ─── Job: Absent Detector ─────────────────────────────
export function startAbsentDetector() {
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();

        const employees = await prisma.user.findMany({
          where: { org_id: org.id, is_active: true, deleted_at: null },
          include: { manager: true },
        });

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });
        const orgWideShift = shifts.find(s => s.is_org_wide);
        const defaultShift = shifts.find(s => s.is_default);

        const assignments = await prisma.shiftAssignment.findMany({
          where: { date: orgToday, user_id: { in: employees.map(e => e.id) } },
          include: { shift: true },
        });
        const assignMap = new Map(assignments.map(a => [a.user_id, a.shift]));

        const records = await prisma.attendanceRecord.findMany({ where: { org_id: org.id, date: orgToday } });
        const recordMap = new Map(records.map(r => [r.user_id, r]));

        for (const user of employees) {
          const shift = assignMap.get(user.id) || orgWideShift || defaultShift;
          if (!shift) continue;

          const shiftStartMins = hhmmToMins(shift.start_time);
          const nowMins = minutesOfDayInTz(now, tz);
          let diffMins = nowMins - shiftStartMins;
          if (diffMins < -720) diffMins += 1440;

          if (diffMins < 120 || diffMins >= 720) continue;

          const record = recordMap.get(user.id);
          if (!record || !record.check_in_at) {
            if (record?.status === 'leave' || record?.status === 'half_leave' || record?.status === 'absent') continue;

            const alreadyAlerted = record?.absent_alerted ?? false;
            await prisma.attendanceRecord.upsert({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              update: { status: 'absent' },
              create: { user_id: user.id, org_id: org.id, date: orgToday, check_in_type: 'manual', status: 'absent' },
            });

            if (!alreadyAlerted) {
              await prisma.attendanceRecord.update({
                where: { user_id_date: { user_id: user.id, date: orgToday } },
                data: { absent_alerted: true },
              });

              if (user.manager?.phone) {
                await notifyAbsent(org.id, user.name, user.manager.phone);
              }
              if (user.manager_id) {
                const { createNotification } = await import('../services/notifications');
                createNotification({
                  userId: user.manager_id, orgId: org.id,
                  type: 'attendance_absent',
                  title: 'Employee absent',
                  body: `${user.name} has not checked in — marked absent`,
                  actionType: 'attendance', actionId: user.id,
                }).catch(console.error);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Absent detector error:', err);
    }
  });
  console.log('❌ Absent detector started');
}

// ─── Job: Heartbeat Expiry Monitor ────────────────────
export function startHeartbeatExpiryMonitor() {
  cron.schedule('*/5 * * * *', async () => {
    const now = new Date();
    try {
      const expired = await prisma.attendanceRecord.findMany({
        where: {
          check_out_at: null,
          status: { in: ['in', 'late'] },
          last_heartbeat_at: { not: null, lte: new Date(now.getTime() - 10 * 60 * 1000) },
        },
        include: { user: { include: { org: { select: { id: true, timezone: true } } } }, shift: true },
      });

      for (const record of expired) {
        const tz = record.user.org?.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        if (record.date.getTime() !== orgToday.getTime()) continue;

        const checkOut = record.last_heartbeat_at!;
        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;
        const breaks = await settleBreaks(record.id, checkOut);
        const earlyMins = earlyOutMinutes(checkOut, record.shift, tz);
        const score = adherenceScore(record.late_minutes ?? 0, earlyMins, record.shift);

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at: checkOut,
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            status: 'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            break_minutes: breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            early_out_minutes: earlyMins,
            ...(score != null && { adherence_score: score }),
            last_heartbeat_at: null,
          },
        });
        await notifyCheckOut(record.user.org_id, record.user.name, formatTime12h(checkOut)).catch(() => {});
      }
    } catch (err) {
      console.error('[JOB] Heartbeat expiry monitor error:', err);
    }
  });
  console.log('💓 Heartbeat expiry monitor started');
}

// ─── Job: Stale Record Sweep ──────────────────────────
export function startStaleRecordSweep() {
  cron.schedule('0 6 * * *', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    try {
      const stale = await prisma.attendanceRecord.findMany({
        where: { date: yesterday, check_in_at: { not: null }, check_out_at: null },
        include: { shift: true },
      });

      for (const record of stale) {
        const checkOut = record.scheduled_end ? new Date(record.scheduled_end) : new Date(yesterday.getTime() + 23 * 3600000 + 59 * 60000);
        const effectiveOut = checkOut > record.check_in_at! ? checkOut : record.check_in_at!;
        const hoursWorked = (effectiveOut.getTime() - record.check_in_at!.getTime()) / 3600000;
        const breaks = await settleBreaks(record.id, effectiveOut);

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at: effectiveOut,
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            status: 'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            break_minutes: breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            last_heartbeat_at: null,
          },
        });
      }
    } catch (err) {
      console.error('[JOB] Stale record sweep error:', err);
    }
  });
  console.log('🧹 Stale record sweep started (06:00)');
}

// ─── Job: Shift Reminders ─────────────────────────────
const _shiftReminderSent = new Set<string>();
export function startShiftReminderJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });

        for (const shift of shifts) {
          const nowMins = minutesOfDayInTz(now, tz);
          const startMins = hhmmToMins(shift.start_time);
          const minsUntilStart = startMins - nowMins;
          if (minsUntilStart < 28 || minsUntilStart >= 32) continue;

          const assignments = await prisma.shiftAssignment.findMany({
            where: { shift_id: shift.id, date: orgToday },
            include: { user: true },
          });

          for (const assignment of assignments) {
            const { user } = assignment;
            if (!user.phone) continue;
            const cacheKey = `${assignment.id}:${orgToday.toISOString().split('T')[0]}`;
            if (_shiftReminderSent.has(cacheKey)) continue;

            const [sh] = shift.start_time.split(':').map(Number);
            const shiftStartTime = `${shift.start_time} ${sh < 12 ? 'AM' : 'PM'}`;
            await notifyShiftReminder(org.id, user.name, shiftStartTime, user.phone).catch(() => {});
            _shiftReminderSent.add(cacheKey);
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Shift reminder error:', err);
    }
  });
}

// ─── Job: Remote AI Nudges ────────────────────────────
export function startRemoteNudgeJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);

        const sessions = await prisma.remoteSession.findMany({
          where: { status: 'approved', attendance: { date: orgToday } },
          include: {
            user: true,
            attendance: { include: { shift: true } },
          },
        });

        for (const session of sessions) {
          if (!session.user.phone) continue;
          const nowMins = minutesOfDayInTz(now, tz);
          const shiftStart = session.attendance?.shift?.start_time || '09:00';
          const shiftEnd = session.attendance?.shift?.end_time || '18:00';
          const startMins = hhmmToMins(shiftStart);
          const endMins = hhmmToMins(shiftEnd);
          const middayMins = Math.floor((startMins + endMins) / 2);

          const near = (target: number) => Math.abs(nowMins - target) <= 1;

          if (near(startMins) && !session.morning_nudge_at) {
            await sendRemoteNudge(org.id, session.user.name, 'morning', session.user.phone);
            await prisma.remoteSession.update({ where: { id: session.id }, data: { morning_nudge_at: new Date() } });
          } else if (near(middayMins) && !session.midday_nudge_at) {
            await sendRemoteNudge(org.id, session.user.name, 'midday', session.user.phone);
            await prisma.remoteSession.update({ where: { id: session.id }, data: { midday_nudge_at: new Date() } });
          } else if (near(endMins) && !session.end_nudge_at) {
            await sendRemoteNudge(org.id, session.user.name, 'eod', session.user.phone);
            await prisma.remoteSession.update({ where: { id: session.id }, data: { end_nudge_at: new Date() } });
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Remote nudge error:', err);
    }
  });
}

// ─── Job: Payroll Auto-Generate ───────────────────────
export function startPayrollAutoGenerate() {
  cron.schedule('0 8 * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany();
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const localNow = toZonedTime(now, tz);
        if (localNow.getDate() !== org.payroll_day) continue;

        const month = localNow.getMonth() === 0 ? 12 : localNow.getMonth();
        const year = localNow.getMonth() === 0 ? localNow.getFullYear() - 1 : localNow.getFullYear();

        if (await prisma.payrollRecord.findFirst({ where: { org_id: org.id, period_month: month, period_year: year } })) continue;

        const { startOfMonth, endOfMonth } = await import('../utils/auth');
        const start = startOfMonth(year, month);
        const end = endOfMonth(year, month);

        const users = await prisma.user.findMany({ where: { org_id: org.id, is_active: true, deleted_at: null } });
        const taxRate = (org.tax_rate || 0) / 100;
        const pensionRate = (org.pension_rate || 0) / 100;

        for (const user of users) {
          const attendance = await prisma.attendanceRecord.findMany({ where: { user_id: user.id, date: { gte: start, lte: end } } });
          const regHours = attendance.reduce((s, r) => s + Number(r.net_hours_worked ?? r.hours_worked ?? 0), 0);
          const otHours = attendance.reduce((s, r) => s + Number(r.overtime_hours || 0), 0);
          const rate = Number(user.hourly_rate);
          const base = regHours * rate;
          const otPay = otHours * rate * 1.5;
          const gross = base + otPay;
          const tax = gross * taxRate;
          const pension = gross * pensionRate;
          const net = gross - tax - pension;

          await prisma.payrollRecord.upsert({
            where: { user_id_period_month_period_year: { user_id: user.id, period_month: month, period_year: year } },
            update: { regular_hours: regHours, overtime_hours: otHours, hourly_rate: rate, base_pay: base, overtime_pay: otPay, gross_pay: gross, tax_deduction: tax, pension_deduction: pension, net_pay: net, is_incomplete: rate === 0 },
            create: { user_id: user.id, org_id: org.id, period_month: month, period_year: year, regular_hours: regHours, overtime_hours: otHours, hourly_rate: rate, base_pay: base, overtime_pay: otPay, gross_pay: gross, tax_deduction: tax, pension_deduction: pension, net_pay: net, is_incomplete: rate === 0 },
          });
        }
      }
    } catch (err) {
      console.error('[JOB] Payroll auto-generate error:', err);
    }
  });
}

// ─── Job: Shift Break Auto-Manager ────────────────────
export function startShiftBreakAutoManager() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const openRecords = await prisma.attendanceRecord.findMany({
          where: { date: orgToday, check_out_at: null, status: { in: ['in', 'late', 'remote'] }, shift_id: { not: null } },
          include: { shift: { include: { breaks: true } }, break_records: true },
        });

        for (const record of openRecords) {
          const nowMins = minutesOfDayInTz(now, tz);
          for (const tmpl of record.shift?.breaks || []) {
            if (!tmpl.break_start_time || !tmpl.break_end_time) continue;
            const bStart = hhmmToMins(tmpl.break_start_time);
            const bEnd = hhmmToMins(tmpl.break_end_time);
            const existing = record.break_records.find(br => br.shift_break_id === tmpl.id);

            if (!existing && nowMins >= bStart && nowMins < bEnd) {
              if (!record.break_records.find(br => !br.break_end)) {
                await prisma.breakRecord.create({
                  data: { attendance_id: record.id, shift_break_id: tmpl.id, break_start: now, break_type: 'shift_break', is_paid: tmpl.is_paid, auto_started: true },
                });
              }
            } else if (existing && !existing.break_end && nowMins >= bEnd) {
              await prisma.breakRecord.update({
                where: { id: existing.id },
                data: { break_end: now, duration_mins: Math.max(0, Math.round((now.getTime() - existing.break_start.getTime()) / 60000)), auto_ended: true },
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Shift break auto-manager error:', err);
    }
  });
}

// ─── Job: Trial Expiry Monitor ────────────────────────
export function startTrialExpiryMonitor() {
  cron.schedule('0 6 * * *', async () => {
    try {
      await prisma.organisation.updateMany({
        where: { subscription_status: 'trialing', trial_ends_at: { lt: new Date() } },
        data: { subscription_status: 'inactive' },
      });
    } catch (err) {
      console.error('[trial-expiry] Error:', err.message);
    }
  });
}

// ─── Job: Token Cleanup ───────────────────────────────
export function startTokenCleanup() {
  cron.schedule('0 2 * * *', async () => {
    try {
      await prisma.tokenBlacklist.deleteMany({ where: { expires_at: { lt: new Date() } } });
    } catch (err) {
      console.error('[Token cleanup] Error:', err);
    }
  });
}

export function startAllJobs() {
  console.log('\n🔧 Starting background jobs...');
  startLateArrivalDetector();
  startAbsentDetector();
  startHeartbeatExpiryMonitor();
  startStaleRecordSweep();
  startShiftReminderJob();
  startRemoteNudgeJob();
  startPayrollAutoGenerate();
  startShiftBreakAutoManager();
  startTrialExpiryMonitor();
  startTokenCleanup();
  console.log('✅ All background jobs running\n');
}
