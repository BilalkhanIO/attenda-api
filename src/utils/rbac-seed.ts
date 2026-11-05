import prisma from './prisma';
import {
  PERMISSION_CATALOG,
  PLATFORM_ROLE_DEFS,
  SYSTEM_ORG_ROLE_SLUGS,
} from '../constants/rbac';

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  employee:    'Employee',
  manager:     'Manager',
  hr_admin:    'HR Admin',
  super_admin: 'Super Admin',
};

// Permission sets defined inline (formerly LEGACY_ROLE_PERMISSIONS in constants/rbac.ts)
const EMPLOYEE_PERMS: string[] = ['projects.view', 'time.view'];

const MANAGER_PERMS = [
  ...EMPLOYEE_PERMS,
  'employees.view_team',
  'employees.view_location',
  'org.locations.view',
  'attendance.view_team',
  'attendance.override',
  'attendance.late_notices.manage',
  'attendance.review_flags',
  'leave.view_team',
  'leave.approve',
  'shifts.view',
  'shifts.assign',
  'shifts.availability.manage',
  'shifts.coverage.manage',
  'labor_cost.view',
  'compliance.view',
  'shifts.breaks.manage',
  'shifts.checkpoints.manage',
  'shifts.swaps.approve',
  'performance.view',
  'performance.manage',
  'projects.manage',
  'projects.tasks.manage',
  'time.view_team',
  'time.approve',
  'analytics.view',
  'remote.approve',
  'expenses.view',
  'documents.view_team',
  'onboarding.view_team',
];

const HR_ADMIN_PERMS = [
  ...MANAGER_PERMS,
  'employees.view',
  'employees.create',
  'employees.update',
  'employees.deactivate',
  'employees.import',
  'attendance.export',
  'attendance.devices.manage',
  'leave.view_all',
  'leave.balance.manage',
  'shifts.manage',
  'shifts.assign',
  'shifts.ai_schedule',
  'labor_cost.manage',
  'compliance.manage',
  'compliance.override',
  'org.events.replay',
  'payroll.view',
  'payroll.manage',
  'payroll.process',
  'reports.view',
  'reports.export',
  'analytics.advanced',
  'analytics.ai_chat',
  'overtime.manage',
  'expenses.manage',
  'documents.manage',
  'onboarding.manage',
  'offboarding.manage',
  'offboarding.view_team',
  'whatsapp.test',
  'whatsapp.logs.view',
  'org.settings.view',
  'org.locations.view',
  'org.qr.manage',
  'org.departments.manage',
  // The announcements endpoint always required this key, but it was never in
  // the catalog/seeds — without it no role could send announcements at all.
  'org.announcements.send',
];

const SUPER_ADMIN_PERMS = [
  ...HR_ADMIN_PERMS,
  'org.audit.view',
  'org.events.replay',
  'org.settings.update',
  'org.locations.manage',
  'org.office.update',
  'org.whatsapp.update',
  'org.roles.manage',
  'org.permissions.grant',
  'employees.credentials.update',
];

export const SYSTEM_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  employee:    EMPLOYEE_PERMS,
  manager:     MANAGER_PERMS,
  hr_admin:    HR_ADMIN_PERMS,
  super_admin: SUPER_ADMIN_PERMS,
};

/** Seed global permission catalog and platform roles (idempotent) */
export async function seedRbacCatalog() {
  for (const p of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { module: p.module, description: p.description },
      create: { key: p.key, module: p.module, description: p.description },
    });
  }

  for (const role of PLATFORM_ROLE_DEFS) {
    const existing = await prisma.platformRole.findUnique({ where: { slug: role.slug } });
    if (!existing) {
      await prisma.platformRole.create({
        data: {
          slug: role.slug,
          name: role.name,
          description: role.description,
          permissions: { create: role.permissions.map(permission_key => ({ permission_key })) },
        },
      });
    } else {
      // Role permission assignments are administrator-managed data. Keep
      // startup seeding from restoring permissions that an admin removed.
      await prisma.platformRole.update({
        where: { slug: role.slug },
        data: { name: role.name, description: role.description },
      });
    }
  }
}

/** Create system org roles and seed their permissions.
 *  Does NOT automatically assign users — call upsertUserOrgRole separately. */
export async function seedOrgRbacForOrganisation(orgId: string) {
  for (const slug of SYSTEM_ORG_ROLE_SLUGS) {
    const permKeys = [...(SYSTEM_ROLE_PERMISSIONS[slug] ?? [])];
    const existing = await prisma.orgRole.findUnique({
      where: { org_id_slug: { org_id: orgId, slug } },
    });
    if (existing) continue;

    const orgRole = await prisma.orgRole.create({
      data: {
        org_id: orgId,
        slug,
        name: ROLE_DISPLAY_NAMES[slug] ?? slug,
        is_system: true,
      },
    });

    if (permKeys.length) {
      await prisma.orgRolePermission.createMany({
        data: permKeys.map(permission_key => ({ org_role_id: orgRole.id, permission_key })),
        skipDuplicates: true,
      });
    }
  }
}

/** Assign a user to a system org role by slug (upsert) */
export async function upsertUserOrgRole(userId: string, orgId: string, roleSlug: string): Promise<void> {
  const slug = SYSTEM_ORG_ROLE_SLUGS.includes(roleSlug as typeof SYSTEM_ORG_ROLE_SLUGS[number])
    ? roleSlug
    : 'employee';

  const orgRole = await prisma.orgRole.findUnique({
    where: { org_id_slug: { org_id: orgId, slug } },
  });
  if (!orgRole) return;

  await prisma.userOrgRole.upsert({
    where: { user_id: userId },
    update: { org_role_id: orgRole.id },
    create: { user_id: userId, org_role_id: orgRole.id },
  });
}

/** Backfill: assign org roles for all existing users in an org based on their role field */
export async function backfillUserOrgRoles(orgId: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { org_id: orgId, deleted_at: null },
    select: { id: true, role: true },
  });

  for (const u of users) {
    const existing = await prisma.userOrgRole.findUnique({ where: { user_id: u.id }, select: { id: true } });
    if (!existing) await upsertUserOrgRole(u.id, orgId, u.role);
  }
}

/** Link platform_admin users to platform_admin role */
export async function seedPlatformUserRoles() {
  const platformUsers = await prisma.user.findMany({
    where: {
      role: 'platform_admin',
      deleted_at: null,
      platform_role_assignments: { none: {} },
    },
    select: { id: true },
  });

  for (const u of platformUsers) {
    await prisma.platformUserRole.upsert({
      where: {
        user_id_platform_role_slug: { user_id: u.id, platform_role_slug: 'platform_admin' },
      },
      update: {},
      create: { user_id: u.id, platform_role_slug: 'platform_admin' },
    });
  }
}

export async function seedAllRbac() {
  await seedRbacCatalog();
  const orgs = await prisma.organisation.findMany({ select: { id: true } });
  for (const org of orgs) {
    await seedOrgRbacForOrganisation(org.id);
    await backfillUserOrgRoles(org.id);
  }
  await seedPlatformUserRoles();
}
