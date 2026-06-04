import prisma from './prisma';
import {
  LEGACY_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  PLATFORM_ROLE_DEFS,
  SYSTEM_ORG_ROLE_SLUGS,
} from '../constants/rbac';

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  employee: 'Employee',
  manager: 'Manager',
  hr_admin: 'HR Admin',
  super_admin: 'Super Admin',
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

/** Create system org roles and assign users by legacy users.role (per org) */
export async function seedOrgRbacForOrganisation(orgId: string) {
  const roleIds: Record<string, string> = {};

  for (const slug of SYSTEM_ORG_ROLE_SLUGS) {
    const permKeys = [...(LEGACY_ROLE_PERMISSIONS[slug] ?? [])];
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
    roleIds[slug] = orgRole.id;

    await prisma.orgRolePermission.deleteMany({ where: { org_role_id: orgRole.id } });
    if (permKeys.length) {
      await prisma.orgRolePermission.createMany({
        data: permKeys.map(permission_key => ({ org_role_id: orgRole.id, permission_key })),
        skipDuplicates: true,
      });
    }
  }

  const users = await prisma.user.findMany({
    where: { org_id: orgId, deleted_at: null },
    select: { id: true, role: true },
  });

  for (const u of users) {
    const slug = SYSTEM_ORG_ROLE_SLUGS.includes(u.role as typeof SYSTEM_ORG_ROLE_SLUGS[number])
      ? u.role
      : 'employee';
    const orgRoleId = roleIds[slug];
    if (!orgRoleId) continue;

    await prisma.userOrgRole.upsert({
      where: { user_id: u.id },
      update: { org_role_id: orgRoleId },
      create: { user_id: u.id, org_role_id: orgRoleId },
    });
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
  }
  await seedPlatformUserRoles();
}
