import 'dotenv/config';
import prisma from '../src/utils/prisma';
import { hashPassword } from '../src/utils/auth';

async function seed() {
  console.log('🌱 Seeding database...');

  // ─── Organisation ──────────────────────────────────
  const org = await prisma.organisation.upsert({
    where: { id: 'demo-org-001' },
    update: {},
    create: {
      id: 'demo-org-001',
      name: 'Attenda Demo Company',
      timezone: 'UTC',
      currency: 'USD',
      office_ips: ['192.168.1.1', '10.0.0.1'],
      wa_enabled: false,
    },
  });
  console.log(`✅ Organisation: ${org.name}`);

  // ─── Users ─────────────────────────────────────────
  const users = [
    { id: 'user-superadmin', name: 'Super Admin',   email: 'admin@demo.attenda.app',   role: 'super_admin', department: 'Management', job_title: 'CEO' },
    { id: 'user-hradmin',    name: 'Sarah HR',       email: 'hr@demo.attenda.app',      role: 'hr_admin',    department: 'HR',         job_title: 'HR Manager' },
    { id: 'user-manager1',   name: 'Marcus Johnson', email: 'manager@demo.attenda.app', role: 'manager',     department: 'Engineering',job_title: 'Engineering Manager' },
    { id: 'user-emp1',       name: 'Alice Chen',     email: 'alice@demo.attenda.app',   role: 'employee',    department: 'Engineering',job_title: 'Software Engineer', manager_id: 'user-manager1' },
    { id: 'user-emp2',       name: 'Bob Williams',   email: 'bob@demo.attenda.app',     role: 'employee',    department: 'Engineering',job_title: 'QA Engineer',       manager_id: 'user-manager1' },
    { id: 'user-emp3',       name: 'Chloe Davis',    email: 'chloe@demo.attenda.app',   role: 'employee',    department: 'Marketing',  job_title: 'Marketing Exec',    manager_id: 'user-hradmin' },
    { id: 'user-emp4',       name: 'David Park',     email: 'david@demo.attenda.app',   role: 'employee',    department: 'Sales',      job_title: 'Sales Rep',         manager_id: 'user-hradmin' },
  ];

  const password = await hashPassword('Demo1234!');
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {},
      create: {
        ...u,
        org_id: org.id,
        password_hash: password,
        hourly_rate: 25,
        is_active: true,
        setup_complete: true,
      },
    });
  }
  console.log(`✅ ${users.length} users created`);

  // ─── Leave balances ────────────────────────────────
  const year = new Date().getFullYear();
  const empIds = users.filter(u => u.role === 'employee').map(u => u.id);
  for (const uid of empIds) {
    await prisma.leaveBalance.createMany({
      data: [
        { user_id: uid, org_id: org.id, leave_type: 'annual', year, total_days: 20, used_days: 3 },
        { user_id: uid, org_id: org.id, leave_type: 'sick',   year, total_days: 10, used_days: 1 },
        { user_id: uid, org_id: org.id, leave_type: 'wfh',    year, total_days: 5,  used_days: 2 },
        { user_id: uid, org_id: org.id, leave_type: 'unpaid', year, total_days: 0,  used_days: 0 },
      ],
      skipDuplicates: true,
    });
  }
  console.log('✅ Leave balances created');

  // ─── Shift templates ───────────────────────────────
  const dayShift = await prisma.shift.upsert({
    where: { id: 'shift-day' },
    update: {},
    create: {
      id: 'shift-day',
      org_id: org.id,
      name: 'Day Shift',
      start_time: '09:00',
      end_time: '18:00',
      color: '#1D4ED8',
      active_days: [1, 2, 3, 4, 5], // Mon-Fri
      is_published: true,
      created_by: 'user-hradmin',
    },
  });
  console.log(`✅ Shift template: ${dayShift.name}`);

  // ─── Sample attendance (last 7 days) ───────────────
  const today = new Date();
  for (let d = 6; d >= 1; d--) {
    const date = new Date(today); date.setDate(date.getDate() - d); date.setHours(0,0,0,0);
    if (date.getDay() === 0 || date.getDay() === 6) continue; // skip weekends

    for (const uid of empIds.slice(0, 3)) {
      const checkIn  = new Date(date); checkIn.setHours(9, Math.floor(Math.random() * 20), 0, 0);
      const checkOut = new Date(date); checkOut.setHours(17, Math.floor(Math.random() * 60), 0, 0);
      const hours    = (checkOut.getTime() - checkIn.getTime()) / 3_600_000;
      const late     = checkIn.getHours() > 9 || (checkIn.getHours() === 9 && checkIn.getMinutes() > 10);

      await prisma.attendanceRecord.upsert({
        where: { user_id_date: { user_id: uid, date } },
        update: {},
        create: {
          user_id: uid, org_id: org.id, date,
          check_in_at: checkIn, check_out_at: checkOut,
          check_in_type: 'auto_ip',
          status: late ? 'late' : 'out',
          hours_worked: parseFloat(hours.toFixed(2)),
          ip_detected: '192.168.1.1',
        },
      });
    }
  }
  console.log('✅ Sample attendance records created');

  // ─── Sample leave request ──────────────────────────
  await prisma.leaveRequest.upsert({
    where: { id: 'leave-demo-001' },
    update: {},
    create: {
      id: 'leave-demo-001',
      user_id: 'user-emp1',
      org_id: org.id,
      leave_type: 'annual',
      start_date: new Date(year, new Date().getMonth(), 20),
      end_date:   new Date(year, new Date().getMonth(), 22),
      working_days: 3,
      reason: 'Family vacation',
      status: 'pending',
    },
  });
  console.log('✅ Sample leave request created');

  const { seedAllRbac } = await import('../src/utils/rbac-seed');
  await seedAllRbac();
  console.log('✅ RBAC catalog, org roles, and assignments seeded');

  console.log('\n🎉 Seed complete!\n');
  console.log('Demo credentials:');
  console.log('  Super Admin: admin@demo.attenda.app  / Demo1234!');
  console.log('  HR Admin:    hr@demo.attenda.app     / Demo1234!');
  console.log('  Manager:     manager@demo.attenda.app / Demo1234!');
  console.log('  Employee:    alice@demo.attenda.app  / Demo1234!');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
