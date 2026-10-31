import 'dotenv/config';
import prisma from './prisma';
import { hashPassword } from './auth';
import { seedAllRbac } from './rbac-seed';

/**
 * Adds an isolated, deterministic demo workspace for local QA. Safe to rerun:
 * all IDs are namespaced and every write is an upsert or skipDuplicates.
 * This intentionally never updates or deletes existing organisation data.
 */
const DEMO_PASSWORD = 'Demo1234!';
const HISTORY_DAYS = 90;

function dateOnly(daysFromToday: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date;
}

function atTime(day: Date, hour: number, minute: number): Date {
  const result = new Date(day);
  result.setUTCHours(hour, minute, 0, 0);
  return result;
}

const DEMO_ORGS = [
  { key: 'northwind', name: 'Northwind People Co.', timezone: 'Asia/Karachi', currency: 'PKR', industry: 'Technology' },
  { key: 'cedar', name: 'Cedar & Stone Studio', timezone: 'Europe/London', currency: 'GBP', industry: 'Design' },
  { key: 'orbit', name: 'Orbit Health Services', timezone: 'America/New_York', currency: 'USD', industry: 'Healthcare' },
] as const;

async function main() {
  console.log(`🌱 Adding ${DEMO_ORGS.length} isolated demo organisations and ${HISTORY_DAYS} days of sample activity...`);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await prisma.organisation.upsert({
    where: { id: 'SYSTEM' }, update: {},
    create: { id: 'SYSTEM', name: 'Attenda System', timezone: 'UTC', currency: 'USD', status: 'active', subscription_status: 'active' },
  });
  await prisma.user.upsert({
    where: { id: 'demo-platform-admin' }, update: {},
    create: { id: 'demo-platform-admin', org_id: 'SYSTEM', name: 'Demo Platform Admin', email: 'platform.demo@attenda.app', password_hash: passwordHash, role: 'platform_admin', is_active: true, setup_complete: true },
  });

  for (const definition of DEMO_ORGS) {
    const orgId = `demo-${definition.key}`;
    const org = await prisma.organisation.upsert({
      where: { id: orgId }, update: {},
      create: {
        id: orgId,
        name: definition.name,
        timezone: definition.timezone,
        currency: definition.currency,
        industry: definition.industry,
        office_ips: ['10.20.0.10', '10.20.0.11'],
        status: 'active',
        subscription_status: 'active',
      },
    });

    const prefix = definition.key;
    const people = [
      { key: 'owner', name: 'Avery Morgan', local: 'owner', role: 'super_admin', department: 'Leadership', title: 'Organisation Admin', manager: null },
      { key: 'hr', name: 'Jordan Lee', local: 'hr', role: 'hr_admin', department: 'People', title: 'People Partner', manager: 'owner' },
      { key: 'manager', name: 'Taylor Reed', local: 'manager', role: 'manager', department: 'Operations', title: 'Team Lead', manager: 'owner' },
      { key: 'employee1', name: 'Morgan Diaz', local: 'morgan', role: 'employee', department: 'Operations', title: 'Coordinator', manager: 'manager' },
      { key: 'employee2', name: 'Riley Chen', local: 'riley', role: 'employee', department: 'Engineering', title: 'Engineer', manager: 'manager' },
      { key: 'employee3', name: 'Casey Patel', local: 'casey', role: 'employee', department: 'People', title: 'HR Associate', manager: 'hr' },
      { key: 'employee4', name: 'Jamie Wilson', local: 'jamie', role: 'employee', department: 'Sales', title: 'Account Executive', manager: 'owner' },
    ] as const;
    const userIds = Object.fromEntries(people.map(person => [person.key, `demo-${prefix}-${person.key}`])) as Record<string, string>;

    for (const person of people) {
      await prisma.user.upsert({
        where: { id: userIds[person.key] }, update: {},
        create: {
          id: userIds[person.key],
          org_id: org.id,
          name: person.name,
          email: `${prefix}.${person.local}@demo.attenda.app`,
          password_hash: passwordHash,
          role: person.role,
          department: person.department,
          job_title: person.title,
          manager_id: person.manager ? userIds[person.manager] : null,
          hourly_rate: person.role === 'employee' ? 24 : 42,
          joined_at: dateOnly(-240),
          is_active: true,
          setup_complete: true,
        },
      });
    }

    const deptRows = ['Leadership', 'People', 'Operations', 'Engineering', 'Sales'];
    for (const [index, name] of deptRows.entries()) {
      await prisma.department.upsert({
        where: { id: `demo-${prefix}-department-${index}` }, update: {},
        create: { id: `demo-${prefix}-department-${index}`, org_id: org.id, name },
      });
    }

    const shiftId = `demo-${prefix}-day-shift`;
    await prisma.shift.upsert({
      where: { id: shiftId }, update: {},
      create: { id: shiftId, org_id: org.id, name: 'Standard Day', start_time: '09:00', end_time: '17:30', color: '#00C896', active_days: [1, 2, 3, 4, 5], is_published: true, is_org_wide: true, is_default: true, created_by: userIds.hr },
    });

    const employeeKeys = ['employee1', 'employee2', 'employee3', 'employee4'];
    await prisma.leaveBalance.createMany({
      data: employeeKeys.flatMap((key, index) => [
        { user_id: userIds[key], org_id: org.id, leave_type: 'annual', year: new Date().getFullYear(), total_days: 20, used_days: index + 2 },
        { user_id: userIds[key], org_id: org.id, leave_type: 'sick', year: new Date().getFullYear(), total_days: 10, used_days: index % 3 },
        { user_id: userIds[key], org_id: org.id, leave_type: 'unpaid', year: new Date().getFullYear(), total_days: 0, used_days: 0 },
      ]),
      skipDuplicates: true,
    });

    const attendanceByDayAndUser = new Map<string, string>();
    for (let offset = -HISTORY_DAYS; offset < 0; offset++) {
      const day = dateOnly(offset);
      const weekday = day.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (const [employeeIndex, key] of employeeKeys.entries()) {
        const lateMinutes = (Math.abs(offset + employeeIndex * 7) % 8 === 0) ? 18 : Math.abs(offset + employeeIndex * 3) % 8;
        const checkIn = atTime(day, 9, lateMinutes);
        const checkOut = atTime(day, 17, 25 + ((Math.abs(offset) + employeeIndex) % 30));
        const hours = Number(((checkOut.getTime() - checkIn.getTime()) / 3_600_000).toFixed(2));
        const record = await prisma.attendanceRecord.upsert({
          where: { user_id_date: { user_id: userIds[key], date: day } }, update: {},
          create: {
            user_id: userIds[key], org_id: org.id, date: day,
            check_in_at: checkIn, check_out_at: checkOut, check_in_type: 'manual',
            status: lateMinutes > 15 ? 'late' : 'out', hours_worked: hours,
            net_hours_worked: hours, shift_id: shiftId,
            scheduled_start: atTime(day, 9, 0), scheduled_end: atTime(day, 17, 30),
            late_minutes: Math.max(0, lateMinutes - 15), adherence_score: Math.max(65, 100 - lateMinutes),
            ip_detected: '10.20.0.10',
          },
        });
        attendanceByDayAndUser.set(`${key}:${offset}`, record.id);
        await prisma.shiftAssignment.upsert({
          where: { user_id_date: { user_id: userIds[key], date: day } }, update: {},
          create: { shift_id: shiftId, user_id: userIds[key], date: day },
        });
      }
    }

    for (const [monthOffset, month] of [dateOnly(-75), dateOnly(-45), dateOnly(-15)].entries()) {
      const periodMonth = month.getUTCMonth() + 1;
      const periodYear = month.getUTCFullYear();
      for (const [index, key] of employeeKeys.entries()) {
        const regularHours = 152 + index * 4 + monthOffset * 2;
        const hourlyRate = 24 + index * 2;
        const gross = regularHours * hourlyRate;
        const tax = gross * 0.1;
        const pension = gross * 0.03;
        await prisma.payrollRecord.upsert({
          where: { user_id_period_month_period_year: { user_id: userIds[key], period_month: periodMonth, period_year: periodYear } }, update: {},
          create: {
            user_id: userIds[key], org_id: org.id, period_month: periodMonth, period_year: periodYear,
            regular_hours: regularHours, overtime_hours: 4 + index, hourly_rate: hourlyRate,
            base_pay: gross, overtime_pay: (4 + index) * hourlyRate * 1.5,
            gross_pay: gross + (4 + index) * hourlyRate * 1.5,
            tax_deduction: tax, pension_deduction: pension, net_pay: gross - tax - pension,
            status: monthOffset < 2 ? 'processed' : 'draft',
            processed_at: monthOffset < 2 ? dateOnly(-4) : null,
            processed_by: monthOffset < 2 ? userIds.hr : null,
          },
        });
      }
    }

    const leaveSamples = [
      { key: 'pending', employee: 'employee1', offset: 12, status: 'pending', reason: 'Family appointment' },
      { key: 'approved', employee: 'employee2', offset: -24, status: 'approved', reason: 'Personal leave' },
      { key: 'rejected', employee: 'employee3', offset: -52, status: 'rejected', reason: 'Travel request' },
    ];
    for (const sample of leaveSamples) {
      const start = dateOnly(sample.offset);
      const end = dateOnly(sample.offset + 2);
      await prisma.leaveRequest.upsert({
        where: { id: `demo-${prefix}-leave-${sample.key}` }, update: {},
        create: {
          id: `demo-${prefix}-leave-${sample.key}`, user_id: userIds[sample.employee], org_id: org.id,
          leave_type: 'annual', start_date: start, end_date: end, working_days: 3, reason: sample.reason,
          status: sample.status,
          ...(sample.status !== 'pending' ? { reviewed_by: userIds.hr, reviewed_at: dateOnly(sample.offset - 2), ...(sample.status === 'rejected' ? { rejection_reason: 'Please coordinate dates with your team.' } : {}) } : {}),
        },
      });
    }

    const correctionDay = dateOnly(-4);
    const correctionAttendance = await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: userIds.employee1, date: correctionDay } } });
    if (correctionAttendance) {
      await prisma.attendanceCorrection.upsert({
        where: { id: `demo-${prefix}-correction-pending` }, update: {},
        create: { id: `demo-${prefix}-correction-pending`, user_id: userIds.employee1, org_id: org.id, attendance_id: correctionAttendance.id, date: correctionDay, requested_check_out: atTime(correctionDay, 18, 0), reason: 'Forgot to check out at the end of my shift.', status: 'pending' },
      });
    }

    for (const [index, key] of employeeKeys.entries()) {
      const expenseDate = dateOnly(-7 - index * 9);
      const status = index === 0 ? 'pending' : index === 1 ? 'approved' : index === 2 ? 'rejected' : 'pending';
      await prisma.expenseClaim.upsert({
        where: { id: `demo-${prefix}-expense-${index}` }, update: {},
        create: {
          id: `demo-${prefix}-expense-${index}`, user_id: userIds[key], org_id: org.id,
          amount: 35 + index * 18, currency: definition.currency, category: index % 2 ? 'Travel' : 'Meals',
          description: index % 2 ? 'Travel to a customer meeting' : 'Team working lunch', expense_date: expenseDate,
          status, ...(status !== 'pending' ? { reviewed_by: userIds.hr, reviewed_at: dateOnly(-3) } : {}),
        },
      });
    }

    for (const [index, employee] of employeeKeys.entries()) {
      const attendanceId = attendanceByDayAndUser.get(`${employee}:-${10 + index}`);
      if (attendanceId) {
        await prisma.overtimeRequest.upsert({
          where: { attendance_id: attendanceId }, update: {},
          create: { attendance_id: attendanceId, user_id: userIds[employee], org_id: org.id, requested_minutes: 30 + index * 15, reason: 'Completed scheduled handover work.', status: index === 0 ? 'pending' : 'approved', ...(index ? { reviewed_by: userIds.manager, reviewed_at: dateOnly(-8) } : {}) },
        });
      }
      const remoteAttendance = await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: userIds[employee], date: dateOnly(-index - 2) } } });
      if (remoteAttendance) {
        await prisma.remoteSession.upsert({
          where: { attendance_id: remoteAttendance.id }, update: {},
          create: { attendance_id: remoteAttendance.id, user_id: userIds[employee], duration_type: 'full_day', status: index === 0 ? 'pending' : 'approved', ...(index ? { approved_by: userIds.manager } : {}) },
        });
      }
    }

    const projectId = `demo-${prefix}-project-people-ops`;
    await prisma.project.upsert({
      where: { id: projectId }, update: {},
      create: {
        id: projectId, org_id: org.id, owner_id: userIds.hr,
        name: 'People operations refresh',
        description: 'Improve onboarding, attendance visibility, and manager workflows across the organisation.',
        status: 'in_progress', priority: 'high', start_date: dateOnly(-45), due_date: dateOnly(25),
      },
    });
    for (const [index, person] of ['hr', 'manager', ...employeeKeys].entries()) {
      await prisma.projectMember.upsert({
        where: { project_id_user_id: { project_id: projectId, user_id: userIds[person] } }, update: {},
        create: { project_id: projectId, user_id: userIds[person], role: index === 0 ? 'owner' : 'member' },
      });
    }
    const taskDefinitions = [
      ['scope', 'Confirm onboarding requirements', 'done', 'high', -32, -20],
      ['policy', 'Review attendance policy', 'in_progress', 'medium', -12, 4],
      ['pilot', 'Run a manager workflow pilot', 'todo', 'urgent', 3, 18],
    ] as const;
    for (const [index, [key, title, status, priority, startOffset, dueOffset]] of taskDefinitions.entries()) {
      await prisma.projectTask.upsert({
        where: { id: `demo-${prefix}-task-${key}` }, update: {},
        create: {
          id: `demo-${prefix}-task-${key}`, project_id: projectId,
          assignee_id: userIds[index === 2 ? 'manager' : 'hr'], created_by: userIds.hr,
          title, description: `Sample ${status.replace('_', ' ')} work for the people operations refresh.`,
          status, priority, start_date: dateOnly(startOffset), due_date: dateOnly(dueOffset),
          completed_at: status === 'done' ? dateOnly(-18) : null,
        },
      });
    }

    const reviewMonth = dateOnly(-35);
    for (const [index, key] of employeeKeys.entries()) {
      const review = await prisma.performanceReview.upsert({
        where: { user_id_period_month_period_year: { user_id: userIds[key], period_month: reviewMonth.getUTCMonth() + 1, period_year: reviewMonth.getUTCFullYear() } }, update: {},
        create: {
          user_id: userIds[key], reviewer_id: userIds[key === 'employee3' ? 'hr' : 'manager'], org_id: org.id,
          period_month: reviewMonth.getUTCMonth() + 1, period_year: reviewMonth.getUTCFullYear(),
          manager_rating: 3 + (index % 3), attendance_score: 80 + index * 4,
          overall_score: 78 + index * 4, notes: 'Sample monthly performance review.', submitted_at: dateOnly(-30),
        },
      });
      await prisma.performanceGoal.upsert({
        where: { id: `demo-${prefix}-goal-${index}` }, update: {},
        create: {
          id: `demo-${prefix}-goal-${index}`, review_id: review.id, user_id: userIds[key],
          title: index % 2 ? 'Improve cross-team handoffs' : 'Complete role learning plan',
          description: 'A seeded goal for exercising progress and review views.', weight: 100,
          target_date: dateOnly(30), completion: index * 20,
        },
      });
    }

    const notices = [
      { type: 'leave_request', title: 'Leave request awaiting review', body: 'Morgan Diaz requested annual leave.', user: 'hr', action: 'leave_request', id: `demo-${prefix}-leave-pending` },
      { type: 'expense_request', title: 'Expense claim submitted', body: 'A team member submitted an expense claim.', user: 'hr', action: 'expense_claim', id: `demo-${prefix}-expense-0` },
      { type: 'project_task_assigned', title: 'Project task assigned', body: 'A new project task is ready for you.', user: 'manager', action: 'project_task', id: `demo-${prefix}-task-pilot` },
    ];
    for (const [index, notice] of notices.entries()) {
      await prisma.inAppNotification.upsert({
        where: { id: `demo-${prefix}-notification-${index}` }, update: {},
        create: { id: `demo-${prefix}-notification-${index}`, org_id: org.id, user_id: userIds[notice.user], type: notice.type, title: notice.title, body: notice.body, action_type: notice.action, action_id: notice.id, created_at: dateOnly(-index - 1) },
      });
    }

    for (const [index, dayOffset] of [-80, -20].entries()) {
      const holidayDate = dateOnly(dayOffset);
      await prisma.orgHoliday.upsert({
        where: { org_id_date: { org_id: org.id, date: holidayDate } }, update: {},
        create: { org_id: org.id, date: holidayDate, name: index ? 'Founders Day' : 'Team Recharge Day' },
      });
    }

    await prisma.onboardingTask.upsert({
      where: { id: `demo-${prefix}-onboarding-task` }, update: {},
      create: { id: `demo-${prefix}-onboarding-task`, org_id: org.id, user_id: userIds.employee4, item_title: 'Complete security and privacy orientation', item_description: 'Review the policies and acknowledge completion.', assignee_id: userIds.employee4, due_date: dateOnly(5), status: 'pending' },
    });
    await prisma.kudos.upsert({
      where: { id: `demo-${prefix}-kudos` }, update: {},
      create: { id: `demo-${prefix}-kudos`, org_id: org.id, from_user_id: userIds.manager, to_user_id: userIds.employee2, message: 'Thanks for helping the team resolve a tricky handoff.', emoji: '👏', created_at: dateOnly(-6) },
    });

    console.log(`✅ ${org.name}: 7 users, 90 days attendance, payroll, leave, expenses, approvals, goals, projects, and notifications`);
  }

  await seedAllRbac();
  console.log('\n✅ Role assignments are persisted in the dynamic RBAC tables.');
  console.log(`\nDemo password for every seeded account: ${DEMO_PASSWORD}`);
  console.log('Organisation admin emails: northwind.owner@demo.attenda.app, cedar.owner@demo.attenda.app, orbit.owner@demo.attenda.app');
  console.log('Platform admin email: platform.demo@attenda.app');
}

main().catch(error => {
  console.error('Demo seed failed:', error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
