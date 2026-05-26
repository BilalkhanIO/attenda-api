// @ts-nocheck
import cron from 'node-cron';
import prisma from '../utils/prisma';
import {
  notifyLateArrival, notifyAbsent, notifyCheckOut,
  sendRemoteNudge, notifyShiftReminder, formatTime12h
} from '../services/whatsapp';

// ─── Job: Late Arrival Detector ───────────────────────
// Runs every minute — flags employees past shift start with no check-in
export function startLateArrivalDetector() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      // Get all shifts that started 10–60 min ago
      const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

      const shifts = await prisma.shift.findMany({ where: { is_published: true } });

      for (const shift of shifts) {
        const [sh, sm] = shift.start_time.split(':').map(Number);
        const shiftStartMins = sh * 60 + sm;
        const nowMins        = now.getHours() * 60 + now.getMinutes();
        const diffMins       = nowMins - shiftStartMins;

        // 15 min: flag as late. 30 min: send manager WhatsApp alert.
        if (diffMins !== 15 && diffMins !== 30) continue;

        // Find employees assigned to this shift today who haven't checked in
        const assignments = await prisma.shiftAssignment.findMany({
          where: { shift_id: shift.id, date: today },
          include: { user: { include: { manager: true } } },
        });

        for (const assignment of assignments) {
          const { user } = assignment;
          const record = await prisma.attendanceRecord.findUnique({
            where: { user_id_date: { user_id: user.id, date: today } },
          });

          if (!record || !record.check_in_at) {
            // Mark as late at 15 min threshold (configurable, default 15 per spec)
            if (diffMins >= 15) {
              await prisma.attendanceRecord.upsert({
                where: { user_id_date: { user_id: user.id, date: today } },
                update: { status: 'late' },
                create: { user_id: user.id, org_id: user.org_id, date: today, check_in_type: 'manual', status: 'late' },
              });
            }

            // Notify manager
            if (user.manager?.phone) {
              await notifyLateArrival(user.org_id, user.name, diffMins, user.manager.phone);
            }
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
      const shifts = await prisma.shift.findMany({ where: { is_published: true } });

      for (const shift of shifts) {
        const [sh, sm] = shift.start_time.split(':').map(Number);
        const shiftStartMins = sh * 60 + sm;
        const nowMins        = now.getHours() * 60 + now.getMinutes();

        // Only process when 2 hours have passed since shift start
        if (nowMins - shiftStartMins < 120) continue;

        const assignments = await prisma.shiftAssignment.findMany({
          where: { shift_id: shift.id, date: today },
          include: { user: { include: { manager: true } } },
        });

        for (const { user } of assignments) {
          const record = await prisma.attendanceRecord.findUnique({
            where: { user_id_date: { user_id: user.id, date: today } },
          });

          if (!record || !record.check_in_at) {
            // Don't overwrite 'leave' status
            if (record?.status === 'leave') continue;

            await prisma.attendanceRecord.upsert({
              where: { user_id_date: { user_id: user.id, date: today } },
              update: { status: 'absent' },
              create: { user_id: user.id, org_id: user.org_id, date: today, check_in_type: 'manual', status: 'absent' },
            });

            // Notify manager only (privacy — not group)
            if (user.manager?.phone) {
              await notifyAbsent(user.org_id, user.name, user.manager.phone);
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

// ─── Job: Auto Checkout (midnight) ────────────────────
// Runs at 23:55 — auto checks out anyone still checked in
export function startMidnightCheckout() {
  cron.schedule('55 23 * * *', async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    try {
      const openRecords = await prisma.attendanceRecord.findMany({
        where: { date: today, check_in_at: { not: null }, check_out_at: null, status: { in: ['in', 'late'] } },
        include: { user: true },
      });

      for (const record of openRecords) {
        const checkOut    = new Date(); checkOut.setHours(23, 59, 0, 0);
        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: { check_out_at: checkOut, hours_worked: parseFloat(hoursWorked.toFixed(2)), status: 'out' },
        });

        await notifyCheckOut(record.user.org_id, record.user.name, '11:59 PM');
      }
      console.log(`[JOB] Auto-checkout: processed ${openRecords.length} open records`);
    } catch (err) {
      console.error('[JOB] Midnight checkout error:', err);
    }
  });
  console.log('🌙 Midnight auto-checkout started');
}

// ─── Job: Shift Reminders ─────────────────────────────
// Runs every minute — sends reminder 30 min before shift start
export function startShiftReminderJob() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const shifts  = await prisma.shift.findMany({ where: { is_published: true } });

      for (const shift of shifts) {
        const [sh, sm] = shift.start_time.split(':').map(Number);
        const shiftMins = sh * 60 + sm;

        // Send reminder exactly 30 min before start
        if (nowMins !== shiftMins - 30) continue;

        const assignments = await prisma.shiftAssignment.findMany({
          where: { shift_id: shift.id, date: today },
          include: { user: true },
        });

        for (const { user } of assignments) {
          if (!user.phone) continue;
          const shiftStartTime = `${shift.start_time} ${sh < 12 ? 'AM' : 'PM'}`;
          await notifyShiftReminder(user.org_id, user.name, shiftStartTime, user.phone);
        }
      }
    } catch (err) {
      console.error('[JOB] Shift reminder error:', err);
    }
  });
  console.log('⏰ Shift reminder job started');
}

// ─── Job: Remote AI Nudges ────────────────────────────
// Runs every minute — sends WhatsApp nudges to remote employees
export function startRemoteNudgeJob() {
  cron.schedule('* * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    try {
      // Get all approved remote sessions for today
      const sessions = await prisma.remoteSession.findMany({
        where: { status: 'approved', created_at: { gte: today } },
        include: {
          user: true,
          attendance: { include: { shift: { select: { start_time: true, end_time: true } } } },
        },
      });

      for (const session of sessions) {
        const user  = session.user;
        if (!user.phone) continue;

        const shiftStart = session.attendance?.shift?.start_time || '09:00';
        const shiftEnd   = session.attendance?.shift?.end_time   || '18:00';
        const [startH, startM] = shiftStart.split(':').map(Number);
        const [endH,   endM]   = shiftEnd.split(':').map(Number);
        const startMins  = startH * 60 + startM;
        const endMins    = endH   * 60 + endM;
        const middayMins = Math.floor((startMins + endMins) / 2);

        // Morning nudge — at shift start
        if (nowMins === startMins && !session.morning_nudge_at) {
          await sendRemoteNudge(user.org_id, user.name, 'morning', user.phone);
          await prisma.remoteSession.update({ where: { id: session.id }, data: { morning_nudge_at: new Date() } });
        }
        // Midday nudge
        else if (nowMins === middayMins && !session.midday_nudge_at) {
          await sendRemoteNudge(user.org_id, user.name, 'midday', user.phone);
          await prisma.remoteSession.update({ where: { id: session.id }, data: { midday_nudge_at: new Date() } });
        }
        // End-of-day nudge
        else if (nowMins === endMins && !session.end_nudge_at) {
          await sendRemoteNudge(user.org_id, user.name, 'eod', user.phone);
          await prisma.remoteSession.update({ where: { id: session.id }, data: { end_nudge_at: new Date() } });
        }

        // No-reply alert: 60 min after nudge sent and no reply logged
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        if (session.morning_nudge_at && session.morning_nudge_at < oneHourAgo) {
          const replied = await prisma.remoteCheckinLog.findFirst({
            where: { remote_session_id: session.id, nudge_type: 'morning', reply_at: { not: null } },
          });
          const alerted = await prisma.remoteCheckinLog.findFirst({
            where: { remote_session_id: session.id, nudge_type: 'morning', no_reply_alerted: true },
          });
          if (!replied && !alerted) {
            // Alert manager about no reply
            const manager = user.manager_id
              ? await prisma.user.findUnique({ where: { id: user.manager_id } })
              : null;
            if (manager?.phone) {
              const { notify, Templates } = await import('../services/whatsapp');
              await notify({
                orgId: user.org_id,
                event: 'remote_morning',
                message: `⚠️ ${user.name} has not replied to their remote check-in nudge. Please follow up.`,
                recipientType: 'individual',
                recipientId: manager.phone,
              });
            }
            await prisma.remoteCheckinLog.updateMany({
              where: { remote_session_id: session.id, nudge_type: 'morning' },
              data: { no_reply_alerted: true },
            });
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
        const month = today.getMonth() + 1;
        const year  = today.getFullYear();

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
          const regularHours  = attendance.reduce((s, r) => s + Number(r.hours_worked || 0), 0);
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

// ─── Start all jobs ───────────────────────────────────
export function startAllJobs() {
  console.log('\n🔧 Starting background jobs...');
  startLateArrivalDetector();
  startAbsentDetector();
  startMidnightCheckout();
  startShiftReminderJob();
  startRemoteNudgeJob();
  startTokenCleanup();
  startPayrollAutoGenerate();
  startIpCheckoutMonitor();
  console.log('✅ All background jobs running\n');
}

// ─── Job: IP Checkout Monitor (every 5 min) ───────────
// Tracks employees whose device left the office WiFi.
// Fires actual checkout after the 5-minute grace period.
export function startIpCheckoutMonitor() {
  cron.schedule('*/5 * * * *', async () => {
    const now   = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);

    try {
      // Find grace-period records: ip_checkout_at set but no check_out_at yet
      const graceRecords = await prisma.attendanceRecord.findMany({
        where: {
          date:          today,
          check_in_at:   { not: null },
          check_out_at:  null,
          status:        { in: ['in', 'late', 'remote'] },
          ip_checkout_pending_at: { not: null, lte: new Date(now.getTime() - 5 * 60 * 1000) }, // grace expired
        },
        include: { user: true },
      });

      for (const record of graceRecords) {
        const checkOut    = record.ip_checkout_pending_at!;
        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at: checkOut,
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            status:       'out',
            ip_checkout_pending_at: null,
          },
        });

        // WhatsApp notification
        const { notifyCheckOut, formatTime12h } = await import('../services/whatsapp');
        await notifyCheckOut(record.user.org_id, record.user.name, formatTime12h(checkOut)).catch(console.error);
      }

      if (graceRecords.length > 0) {
        console.log(`[JOB] IP checkout: processed ${graceRecords.length} grace-expired check-outs`);
      }
    } catch (err) {
      console.error('[JOB] IP checkout monitor error:', err);
    }
  });
  console.log('📶 IP checkout monitor started');
}
