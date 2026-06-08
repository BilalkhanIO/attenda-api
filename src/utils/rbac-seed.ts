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
const EMPLOYEE_PERMS: string[] = [];

const MANAGER_PERMS = [
  ...EMPLOYEE_PERMS,
  'employees.view_team',
  'attendance.view_team',
  'attendance.override',
  'attendance.late_notices.manage',
  'leave.view_team',
  'leave.approve',
  'shifts.view',
  'shifts.breaks.manage',
  'shifts.swaps.approve',
  'performance.view',
  'performance.manage',
  'analytics.view',
  'remote.approve',
];

const HR_ADMIN_PERMS = [
  ...MANAGER_PERMS,
  'employees.view',
  'employees.create',
  'employees.update',
  'employees.deactivate',
  'employees.import',
  'attendance.export',
  'leave.view_all',
  'leave.balance.manage',
  'shifts.manage',
  'shifts.assign',
  'shifts.ai_schedule',
  'payroll.view',
  'payroll.manage',
  'payroll.process',
  'reports.view',
  'reports.export',
  'analytics.advanced',
  'overtime.manage',
  'whatsapp.test',
  'whatsapp.logs.view',
  'org.settings.view',
  'org.qr.manage',
];

const SUPER_ADMIN_PERMS = [
  ...HR_ADMIN_PERMS,
  'org.settings.update',
  'org.office.update',
  'org.whatsapp.update',
  'org.roles.manage',
  'org.permissions.grant',
  'employees.credentials.update',
];

const SYSTEM_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
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
    await prisma.platformRole.upsert({
      where: { slug: role.slug },
      update: { name: role.name, description: role.description },
      create: { slug: role.slug, name: role.name, description: role.description },
    });
    for (const key of role.permissions) {
      await prisma.platformRolePermission.upsert({
        where: {
          platform_role_slug_permission_key: {
            platform_role_slug: role.slug,
            permission_key: key,
          },
        },
        update: {},
        create: { platform_role_slug: role.slug, permission_key: key },
      });
    }
  }
}

/** Create system org roles and seed their permissions.
 *  Does NOT automatically assign users — call upsertUserOrgRole separately. */
export async function seedOrgRbacForOrganisation(orgId: string) {
  for (const slug of SYSTEM_ORG_ROLE_SLUGS) {
    const permKeys = [...(SYSTEM_ROLE_PERMISSIONS[slug] ?? [])];
    const orgRole = await prisma.orgRole.upsert({
      where: { org_id_slug: { org_id: orgId, slug } },
      update: { name: ROLE_DISPLAY_NAMES[slug] ?? slug, is_system: true },
      create: {
        org_id: orgId,
        slug,
        name: ROLE_DISPLAY_NAMES[slug] ?? slug,
        is_system: true,
      },
    });

    await prisma.orgRolePermission.deleteMany({ where: { org_role_id: orgRole.id } });
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
    await upsertUserOrgRole(u.id, orgId, u.role);
  }
}

/** Link platform_admin users to platform_admin role */
export async function seedPlatformUserRoles() {
  const platformUsers = await prisma.user.findMany({
    where: { role: 'platform_admin', deleted_at: null },
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
