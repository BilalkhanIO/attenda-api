// @ts-nocheck
import cron from 'node-cron';
import prisma from '../utils/prisma';
import {
  notifyLateArrival, notifyAbsent, notifyCheckOut,
  sendRemoteNudge, notifyShiftReminder, formatTime12h
} from '../services/whatsapp';
import {
  minutesOfDayInTz, hhmmToMins, lateThresholdFor, lateMinutes,
  earlyOutMinutes, adherenceScore, scheduledWindow,
} from '../utils/shift';
import { settleBreaks, netHoursWorked } from '../utils/attendance';

// ─── Job: Late Arrival Detector ───────────────────────
// Runs every minute — flags assigned employees who are past their shift's
// late tolerance with no check-in. Timezone-aware (uses each org's timezone)
// and threshold-crossing (not exact-minute) so a missed cron tick can't let
// someone slip through. Idempotent: only writes 'late' once, alerts once.
//
// Late-notice awareness: if an employee pre-announced late arrival with an
// expected_time, the manager alert is suppressed until that time passes.
// 1-hour escalation: if still absent at 60 min past shift start, escalate
// to manager + HR admin (tracked via hour_alerted to fire exactly once).
export function startLateArrivalDetector() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      const shifts = await prisma.shift.findMany({
        where: { is_published: true },
        include: { org: { select: { timezone: true, late_threshold: true } } },
      });

      for (const shift of shifts) {
        const tz             = shift.org?.timezone;
        const shiftStartMins = hhmmToMins(shift.start_time);
        const nowMins        = minutesOfDayInTz(now, tz);
        const diffMins       = nowMins - shiftStartMins;

        const tolerance = lateThresholdFor(shift, shift.org);
        if (diffMins <= tolerance || diffMins >= 720) continue;

        const shouldAlert    = diffMins >= 30;
        const shouldEscalate = diffMins >= 60;

        const assignments = await prisma.shiftAssignment.findMany({
          where: { shift_id: shift.id, date: today },
          include: { user: { include: { manager: true } } },
        });

        const userIds = assignments.map(a => a.user.id);
        const [records, lateNotices] = await Promise.all([
          prisma.attendanceRecord.findMany({ where: { user_id: { in: userIds }, date: today } }),
          prisma.lateArrivalNotice.findMany({
            where: { user_id: { in: userIds }, date: today, status: { not: 'cancelled' } },
          }),
        ]);
        const recordByUserId = new Map(records.map(r => [r.user_id, r]));
        const noticeByUserId = new Map(lateNotices.map(n => [n.user_id, n]));

        for (const assignment of assignments) {
          const { user } = assignment;
          const record = recordByUserId.get(user.id);

          // Already checked in, or already resolved (leave/half_leave/absent) → skip
          if (record?.check_in_at) continue;
          if (record && ['leave', 'half_leave', 'absent'].includes(record.status)) continue;

          // Check if employee submitted a late notice
          const notice = noticeByUserId.get(user.id);
          if (notice) {
            const expectedMins = hhmmToMins(notice.expected_time);
            // Still within their promised window — don't flag or alert
            if (nowMins <= expectedMins) continue;
            // Past promised time — fall through to normal late handling
          }

          // Flag late once (idempotent: skip if already 'late')
          if (!record || record.status !== 'late') {
            await prisma.attendanceRecord.upsert({
              where:  { user_id_date: { user_id: user.id, date: today } },
              update: { status: 'late' },
              create: { user_id: user.id, org_id: user.org_id, date: today, check_in_type: 'manual', status: 'late', shift_id: shift.id },
            });
          }

          const wasPreAnnounced = !!notice;
          const preAnnouncedSuffix = wasPreAnnounced ? ` (had a late notice — expected by ${notice!.expected_time})` : '';

          // Manager alert at +30 min — fires once via late_alerted
          if (shouldAlert && !record?.late_alerted) {
            if (user.manager?.phone) {
              await notifyLateArrival(user.org_id, user.name, diffMins, user.manager.phone).catch(() => {});
            }
            if (user.manager_id) {
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: user.manager_id, orgId: user.org_id,
                type: 'attendance_late',
                title: wasPreAnnounced ? 'Employee late (past expected time)' : 'Employee late',
                body: `${user.name} is ${diffMins} minutes late and has not checked in${preAnnouncedSuffix}`,
                actionType: 'attendance', actionId: user.id,
              }).catch(console.error);
            }
            await prisma.attendanceRecord.update({
              where: { user_id_date: { user_id: user.id, date: today } },
              data:  { late_alerted: true },
            }).catch(() => {});
          }

          // Escalation at +60 min — send to manager AND HR admins, fires once via hour_alerted
          if (shouldEscalate && !record?.hour_alerted) {
            const hrAdmins = await prisma.user.findMany({
              where: { org_id: user.org_id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true },
              select: { id: true, phone: true },
            });
            const { notify } = await import('../services/whatsapp');
            const escalMsg = `🚨 *1-Hour Late Alert*\n${user.name} has not checked in 60+ minutes past shift start${preAnnouncedSuffix}.\nPlease check on them.`;

            for (const admin of hrAdmins) {
              if (admin.phone) {
                await notify({ orgId: user.org_id, event: 'shift_reminder' as any, message: escalMsg, recipientType: 'individual', recipientId: admin.phone }).catch(() => {});
              }
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: admin.id, orgId: user.org_id,
                type: 'attendance_late_escalation',
                title: '1-hour late escalation',
                body: `${user.name} still has not checked in — 60+ min past shift start${preAnnouncedSuffix}`,
                actionType: 'attendance', actionId: user.id,
              }).catch(console.error);
            }
            if (user.manager?.phone) {
              await notify({ orgId: user.org_id, event: 'shift_reminder' as any, message: escalMsg, recipientType: 'individual', recipientId: user.manager.phone }).catch(() => {});
            }
            await prisma.attendanceRecord.update({
              where: { user_id_date: { user_id: user.id, date: today } },
              data:  { hour_alerted: true },
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
// Runs every hour — marks employees absent 2h after shift start with no check-in
export function startAbsentDetector() {
  cron.schedule('0 * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      const shifts = await prisma.shift.findMany({
        where: { is_published: true },
        include: { org: { select: { timezone: true } } },
      });

      for (const shift of shifts) {
        const shiftStartMins = hhmmToMins(shift.start_time);
        const nowMins        = minutesOfDayInTz(now, shift.org?.timezone);
        const diffMins       = nowMins - shiftStartMins;

        // Only process when 2–12 h have passed since shift start (cap avoids
        // overnight-wrap false positives where nowMins has rolled past midnight).
        if (diffMins < 120 || diffMins >= 720) continue;

        const assignments = await prisma.shiftAssignment.findMany({
          where: { shift_id: shift.id, date: today },
          include: { user: { include: { manager: true } } },
        });

        for (const { user } of assignments) {
          const record = await prisma.attendanceRecord.findUnique({
            where: { user_id_date: { user_id: user.id, date: today } },
          });

          if (!record || !record.check_in_at) {
            // Don't overwrite 'leave' or 'half_leave' status
            if (record?.status === 'leave' || record?.status === 'half_leave') continue;

            const alreadyAlerted = record?.absent_alerted ?? false;
            await prisma.attendanceRecord.upsert({
              where: { user_id_date: { user_id: user.id, date: today } },
              update: { status: 'absent' },
              create: { user_id: user.id, org_id: user.org_id, date: today, check_in_type: 'manual', status: 'absent' },
            });

            if (!alreadyAlerted) {
              await prisma.attendanceRecord.update({
                where: { user_id_date: { user_id: user.id, date: today } },
                data: { absent_alerted: true },
              });

              // Notify manager only (privacy — not group)
              if (user.manager?.phone) {
                await notifyAbsent(user.org_id, user.name, user.manager.phone);
              }
              if (user.manager_id) {
                const { createNotification } = await import('../services/notifications');
                createNotification({
                  userId: user.manager_id, orgId: user.org_id,
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

// ─── Job: Heartbeat Expiry Monitor (every 5 min) ──────
// WiFi check-ins send a heartbeat every ~4 min. If the last heartbeat
// is more than 10 min old, the employee has left — check them out at
// the time of their last heartbeat (not now).
export function startHeartbeatExpiryMonitor() {
  cron.schedule('*/5 * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      const expired = await prisma.attendanceRecord.findMany({
        where: {
          date:          today,
          check_in_at:   { not: null },
          check_out_at:  null,
          status:        { in: ['in', 'late'] },
          last_heartbeat_at: { not: null, lte: new Date(now.getTime() - 10 * 60 * 1000) },
        },
        include: { user: { include: { org: { select: { timezone: true } } } }, shift: true },
      });

      for (const record of expired) {
        const checkOut    = record.last_heartbeat_at!;
        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;
        const tz          = record.user.org?.timezone;
        const breaks      = await settleBreaks(record.id, checkOut);
        const earlyMins   = earlyOutMinutes(checkOut, record.shift, tz);
        const score       = adherenceScore(record.late_minutes ?? 0, earlyMins, record.shift);

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at:     checkOut,
            hours_worked:     parseFloat(hoursWorked.toFixed(2)),
            status:           'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            break_minutes:    breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            early_out_minutes: earlyMins,
            ...(score != null && { adherence_score: score }),
            last_heartbeat_at: null,
          },
        });

        await notifyCheckOut(record.user.org_id, record.user.name, formatTime12h(checkOut)).catch(() => {});
      }

      if (expired.length > 0) console.log(`[JOB] Heartbeat expiry: checked out ${expired.length} records`);
    } catch (err) {
      console.error('[JOB] Heartbeat expiry monitor error:', err);
    }
  });
  console.log('💓 Heartbeat expiry monitor started');
}

// ─── Job: Stale Record Sweep (06:00 daily) ────────────
// Safety net: close any record from yesterday still open at 6 AM.
// Covers manual check-ins where employee forgot to checkout, dead phones,
// and any edge case missed by the heartbeat monitor.
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
        const checkOut = record.scheduled_end
          ? new Date(record.scheduled_end)
          : new Date(yesterday.getTime() + 23 * 3_600_000 + 59 * 60_000);
        const effectiveOut = checkOut > record.check_in_at! ? checkOut : record.check_in_at!;
        const hoursWorked  = (effectiveOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;
        const breaks       = await settleBreaks(record.id, effectiveOut);

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at:     effectiveOut,
            hours_worked:     parseFloat(hoursWorked.toFixed(2)),
            status:           'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            break_minutes:    breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            last_heartbeat_at: null,
          },
        });
      }

      if (stale.length > 0) console.log(`[JOB] Stale sweep: closed ${stale.length} open records from yesterday`);
    } catch (err) {
      console.error('[JOB] Stale record sweep error:', err);
    }
  });
  console.log('🧹 Stale record sweep started (06:00)');
}

// ─── Job: Shift Reminders ─────────────────────────────
// Runs every minute — sends reminder 30 min before shift start (timezone-aware).
// Uses in-memory cache for idempotency (prevents duplicate sends in the fire window).
const _shiftReminderSent = new Set<string>(); // `${assignment.id}:${YYYY-MM-DD}`

export function startShiftReminderJob() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      const shifts = await prisma.shift.findMany({
        where: { is_published: true },
        include: { org: { select: { timezone: true } } },
      });

      for (const shift of shifts) {
        const tz      = shift.org?.timezone;
        const nowMins = minutesOfDayInTz(now, tz);
        const startMins = hhmmToMins(shift.start_time);

        // Fire within a 4-minute window centred on 30 min before shift start,
        // i.e. when [28, 32) minutes remain. This handles minor cron-tick drift.
        const minsUntilStart = startMins - nowMins;
        if (minsUntilStart < 28 || minsUntilStart >= 32) continue;

        const assignments = await prisma.shiftAssignment.findMany({
          where: { shift_id: shift.id, date: today },
          include: { user: true },
        });

        for (const assignment of assignments) {
          const { user } = assignment;
          if (!user.phone) continue;

          const dateKey = today.toISOString().split('T')[0];
          const cacheKey = `${assignment.id}:${dateKey}`;
          if (_shiftReminderSent.has(cacheKey)) continue; // already sent today

          const [sh] = shift.start_time.split(':').map(Number);
          const shiftStartTime = `${shift.start_time} ${sh < 12 ? 'AM' : 'PM'}`;
          await notifyShiftReminder(user.org_id, user.name, shiftStartTime, user.phone).catch(console.error);
          _shiftReminderSent.add(cacheKey);
        }
      }
    } catch (err) {
      console.error('[JOB] Shift reminder error:', err);
    }
  });
  console.log('⏰ Shift reminder job started');
}

// ─── Job: Remote AI Nudges ────────────────────────────
// Runs every minute — sends WhatsApp nudges to remote employees (timezone-aware).
// Each nudge type has a ±1-minute fire window; idempotency is enforced by the
// morning_nudge_at / midday_nudge_at / end_nudge_at timestamps on the session.
export function startRemoteNudgeJob() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      // Get all approved remote sessions for today
      const sessions = await prisma.remoteSession.findMany({
        where: { status: 'approved', created_at: { gte: today } },
        include: {
          user: { include: { org: { select: { timezone: true } } } },
          attendance: { include: { shift: { select: { start_time: true, end_time: true } } } },
        },
      });

      for (const session of sessions) {
        const user  = session.user;
        if (!user.phone) continue;

        // Use org timezone for wall-clock comparison
        const tz      = user.org?.timezone;
        const nowMins = minutesOfDayInTz(now, tz);

        const shiftStart = session.attendance?.shift?.start_time || '09:00';
        const shiftEnd   = session.attendance?.shift?.end_time   || '18:00';
        const startMins  = hhmmToMins(shiftStart);
        const endMins    = hhmmToMins(shiftEnd);
        const middayMins = Math.floor((startMins + endMins) / 2);

        // ±1-minute window; idempotency enforced by the *_nudge_at timestamps
        const near = (target: number) => Math.abs(nowMins - target) <= 1;

        // Morning nudge — at shift start
        if (near(startMins) && !session.morning_nudge_at) {
          await sendRemoteNudge(user.org_id, user.name, 'morning', user.phone);
          await prisma.remoteSession.update({ where: { id: session.id }, data: { morning_nudge_at: new Date() } });
        }
        // Midday nudge
        else if (near(middayMins) && !session.midday_nudge_at) {
          await sendRemoteNudge(user.org_id, user.name, 'midday', user.phone);
          await prisma.remoteSession.update({ where: { id: session.id }, data: { midday_nudge_at: new Date() } });
        }
        // End-of-day nudge
        else if (near(endMins) && !session.end_nudge_at) {
          await sendRemoteNudge(user.org_id, user.name, 'eod', user.phone);
          await prisma.remoteSession.update({ where: { id: session.id }, data: { end_nudge_at: new Date() } });
        }

        // No-reply alert: 60 min after each nudge sent and no reply logged
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const nudgeChecks: Array<{ sentAt: Date | null; type: string; event: string }> = [
          { sentAt: session.morning_nudge_at, type: 'morning',      event: 'remote_morning' },
          { sentAt: session.midday_nudge_at,  type: 'midday',       event: 'remote_midday'  },
          { sentAt: session.end_nudge_at,     type: 'end_of_day',   event: 'remote_eod'     },
        ];
        for (const { sentAt, type, event } of nudgeChecks) {
          if (!sentAt || sentAt >= oneHourAgo) continue;
          const replied = await prisma.remoteCheckinLog.findFirst({
            where: { remote_session_id: session.id, nudge_type: type, reply_at: { not: null } },
          });
          const alerted = await prisma.remoteCheckinLog.findFirst({
            where: { remote_session_id: session.id, nudge_type: type, no_reply_alerted: true },
          });
          if (!replied && !alerted) {
            const manager = user.manager_id
              ? await prisma.user.findUnique({ where: { id: user.manager_id } })
              : null;
            if (manager?.phone) {
              const { notify } = await import('../services/whatsapp');
              await notify({
                orgId: user.org_id,
                event: event as any,
                message: `⚠️ ${user.name} has not replied to their ${type} remote check-in. Please follow up.`,
                recipientType: 'individual',
                recipientId: manager.phone,
              });
            }
            // Mark existing log or create a stub so we don't re-alert next minute
            const upd = await prisma.remoteCheckinLog.updateMany({
              where: { remote_session_id: session.id, nudge_type: type },
              data:  { no_reply_alerted: true },
            });
            if (upd.count === 0) {
              await prisma.remoteCheckinLog.create({
                data: { remote_session_id: session.id, nudge_type: type, nudge_sent_at: sentAt, no_reply_alerted: true },
              });
            }

            // In-app notification to manager
            if (manager) {
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: manager.id, orgId: user.org_id,
                type: 'remote_no_reply',
                title: 'Remote worker not responding',
                body: `${user.name} has not replied to their ${type} check-in nudge`,
                actionType: 'remote_session', actionId: session.id,
              }).catch(console.error);
            }
          }
        }

        // EOD summary: 30 min after EOD nudge, consolidate AI-parsed task summaries
        if (session.end_nudge_at && !session.ai_summary) {
          const thirtyMinAfterEOD = new Date(session.end_nudge_at.getTime() + 30 * 60 * 1000);
          if (now >= thirtyMinAfterEOD) {
            const allLogs = await prisma.remoteCheckinLog.findMany({
              where: { remote_session_id: session.id },
              orderBy: { nudge_sent_at: 'asc' },
            });
            const summaryParts = [
              allLogs.find(l => l.nudge_type === 'morning')?.task_summary,
              allLogs.find(l => l.nudge_type === 'midday')?.task_summary,
              allLogs.find(l => l.nudge_type === 'end_of_day')?.task_summary,
            ].filter((s): s is string => !!s);
            if (summaryParts.length > 0) {
              await prisma.remoteSession.update({
                where: { id: session.id },
                data:  { ai_summary: summaryParts.join(' · ') },
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Remote nudge error:', err);
    }
  });
  console.log('🏠 Remote nudge job started');
}

// ─── Job: JWT Blacklist Cleanup ───────────────────────
// Runs daily at 02:00
export function startTokenCleanup() {
  cron.schedule('0 2 * * *', async () => {
    try {
      const deleted = await prisma.tokenBlacklist.deleteMany({
        where: { expires_at: { lt: new Date() } },
      });
      console.log(`[JOB] Token cleanup: deleted ${deleted.count} expired tokens`);
    } catch (err) {
      console.error('[JOB] Token cleanup error:', err);
    }
  });
  console.log('🧹 Token cleanup job started');
}

// ─── Job: Monthly Payroll Auto-Generate ───────────────
// Runs at 08:00 on the configured payroll day each month
export function startPayrollAutoGenerate() {
  cron.schedule('0 8 * * *', async () => {
    const today = new Date();
    const day   = today.getDate();

    try {
      // Find orgs where today is their payroll_day
      const orgs = await prisma.organisation.findMany({ where: { payroll_day: day } });

      for (const org of orgs) {
        // Bill the previous month so the full month is always complete before payroll runs
        const month = today.getMonth() === 0 ? 12 : today.getMonth();
        const year  = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();

        // Check not already generated
        const existing = await prisma.payrollRecord.findFirst({
          where: { org_id: org.id, period_month: month, period_year: year },
        });
        if (existing) continue;

        // Generate payroll records for all active employees
        const { startOfMonth, endOfMonth } = await import('../utils/auth');
        const start = startOfMonth(year, month);
        const end   = endOfMonth(year, month);

        const users = await prisma.user.findMany({
          where: { org_id: org.id, is_active: true, deleted_at: null },
        });
        const taxRate     = (Number(org.tax_rate)     || 0) / 100;
        const pensionRate = (Number(org.pension_rate) || 0) / 100;

        for (const user of users) {
          const attendance = await prisma.attendanceRecord.findMany({
            where: { user_id: user.id, date: { gte: start, lte: end } },
          });
          const regularHours  = attendance.reduce((s, r) => s + Number(r.net_hours_worked ?? r.hours_worked ?? 0), 0);
          const overtimeHours = attendance.reduce((s, r) => s + Number(r.overtime_hours || 0), 0);
          const unpaidLeave   = await prisma.leaveRequest.findMany({
            where: { user_id: user.id, status: 'approved', leave_type: 'unpaid', start_date: { lte: end }, end_date: { gte: start } },
          });
          const unpaidDays   = unpaidLeave.reduce((s, l) => s + l.working_days, 0);
          const hourlyRate   = Number(user.hourly_rate);
          const basePay      = regularHours * hourlyRate;
          const overtimePay  = overtimeHours * hourlyRate * 1.5;
          const deduction    = unpaidDays * hourlyRate * 8;
          const grossPay     = Math.max(0, basePay + overtimePay - deduction);
          const taxDed       = grossPay * taxRate;
          const pensionDed   = grossPay * pensionRate;
          const netPay       = Math.max(0, grossPay - taxDed - pensionDed);

          await prisma.payrollRecord.upsert({
            where: { user_id_period_month_period_year: { user_id: user.id, period_month: month, period_year: year } },
            update: { regular_hours: regularHours, overtime_hours: overtimeHours, hourly_rate: hourlyRate, base_pay: basePay, overtime_pay: overtimePay, unpaid_deduction: deduction, gross_pay: grossPay, tax_deduction: taxDed, pension_deduction: pensionDed, net_pay: netPay, is_incomplete: hourlyRate === 0 },
            create: { user_id: user.id, org_id: org.id, period_month: month, period_year: year, regular_hours: regularHours, overtime_hours: overtimeHours, hourly_rate: hourlyRate, base_pay: basePay, overtime_pay: overtimePay, unpaid_deduction: deduction, gross_pay: grossPay, tax_deduction: taxDed, pension_deduction: pensionDed, net_pay: netPay, is_incomplete: hourlyRate === 0 },
          });
        }

        console.log(`[JOB] Auto-generated payroll for ${org.name} (${month}/${year}) — ${users.length} employees`);

        // Notify HR admins
        const hrAdmins = await prisma.user.findMany({ where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] } } });
        for (const admin of hrAdmins) {
          if (admin.phone) {
            const { notify } = await import('../services/whatsapp');
            await notify({
              orgId: org.id,
              event: 'payslip_ready',
              message: `💼 Payroll for ${today.toLocaleString('default', { month: 'long' })} ${year} has been generated and is ready for your review in Attenda.`,
              recipientType: 'individual',
              recipientId: admin.phone,
            });
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Payroll auto-generate error:', err);
    }
  });
  console.log('💰 Payroll auto-generate job started');
}

// ─── Job: Shift Break Auto-Manager (every minute) ────
// Automatically starts and ends BreakRecords for employees whose shift has
// ShiftBreak templates with break_start_time / break_end_time set.
// This connects shift break schedules to live attendance records so break
// time is properly deducted from net_hours_worked without manual action.
export function startShiftBreakAutoManager() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      const openRecords = await prisma.attendanceRecord.findMany({
        where: {
          date:         today,
          check_in_at:  { not: null },
          check_out_at: null,
          status:       { in: ['in', 'late', 'remote'] },
          shift_id:     { not: null },
        },
        include: {
          user:         { include: { org: { select: { timezone: true } } } },
          shift:        { include: { breaks: { orderBy: { after_minutes: 'asc' } } } },
          break_records: { orderBy: { break_start: 'asc' } },
        },
      });

      for (const record of openRecords) {
        const tz      = record.user.org?.timezone;
        const nowMins = minutesOfDayInTz(now, tz);
        const shiftBreaks = record.shift?.breaks ?? [];

        for (const tmpl of shiftBreaks) {
          if (!tmpl.break_start_time || !tmpl.break_end_time) continue;

          const bStartMins = hhmmToMins(tmpl.break_start_time);
          const bEndMins   = hhmmToMins(tmpl.break_end_time);

          // Find if a BreakRecord for this shift-break template exists today
          const existing = record.break_records.find(br => br.shift_break_id === tmpl.id);

          // Auto-start: current time is at/after break start and before break end
          if (!existing && nowMins >= bStartMins && nowMins < bEndMins) {
            const openBreak = record.break_records.find(br => !br.break_end);
            if (!openBreak) {
              await prisma.breakRecord.create({
                data: {
                  attendance_id:  record.id,
                  shift_break_id: tmpl.id,
                  break_start:    now,
                  break_type:     'shift_break',
                  is_paid:        tmpl.is_paid,
                  auto_started:   true,
                },
              });
            }
          }

          // Auto-end: break template has ended but BreakRecord is still open
          if (existing && !existing.break_end && nowMins >= bEndMins) {
            const durMins = Math.max(0, Math.round((now.getTime() - existing.break_start.getTime()) / 60000));
            await prisma.breakRecord.update({
              where: { id: existing.id },
              data:  { break_end: now, duration_mins: durMins, auto_ended: true },
            });

            // Recompute attendance totals so mid-shift figures are accurate
            const allBreaks = await prisma.breakRecord.findMany({
              where: { attendance_id: record.id, break_end: { not: null } },
            });
            const paidMins   = allBreaks.filter(b => b.is_paid).reduce((s, b) => s + (b.duration_mins ?? 0), 0);
            const unpaidMins = allBreaks.filter(b => !b.is_paid).reduce((s, b) => s + (b.duration_mins ?? 0), 0);
            const grossHours = record.check_in_at
              ? (now.getTime() - record.check_in_at.getTime()) / 3_600_000
              : 0;
            await prisma.attendanceRecord.update({
              where: { id: record.id },
              data: {
                break_minutes:      unpaidMins + paidMins,
                paid_break_minutes: paidMins,
                net_hours_worked:   netHoursWorked(grossHours, unpaidMins),
              },
            });
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Shift break auto-manager error:', err);
    }
  });
  console.log('☕ Shift break auto-manager started');
}

// ─── Start all jobs ───────────────────────────────────
// ─── Job: Trial Expiry Monitor ────────────────────────
// Runs daily at 06:00 UTC. Marks trialing orgs as 'inactive' when their
// trial has ended, and marks active orgs with a past trial as 'defaulted'
// when they haven't upgraded.
export function startTrialExpiryMonitor() {
  cron.schedule('0 6 * * *', async () => {
    const now = new Date();
    try {
      // Trialing → inactive when trial_ends_at has passed
      const expired = await prisma.organisation.updateMany({
        where: {
          subscription_status: 'trialing',
          trial_ends_at: { lt: now },
        },
        data: { subscription_status: 'inactive' },
      });
      if (expired.count > 0) {
        console.log(`[trial-expiry] Marked ${expired.count} organisation(s) as inactive (trial ended)`);
      }
    } catch (err: any) {
      console.error('[trial-expiry] Error:', err.message);
    }
  });
  console.log('  ✓ Trial expiry monitor scheduled (daily 06:00 UTC)');
}

export function startAllJobs() {
  console.log('\n🔧 Starting background jobs...');
  startLateArrivalDetector();
  startAbsentDetector();
  startHeartbeatExpiryMonitor();
  startStaleRecordSweep();
  startShiftReminderJob();
  startRemoteNudgeJob();
  startTokenCleanup();
  startPayrollAutoGenerate();
  startShiftBreakAutoManager();
  startTrialExpiryMonitor();
  console.log('✅ All background jobs running\n');
}
