import prisma from '../utils/prisma';
import {
  DEFAULT_PLAN_FEATURES,
  FEATURE_KEYS,
  type PlanFeatures,
} from '../constants/rbac';

export type { PlanFeatures };

function mergePlanFeatures(
  base: PlanFeatures,
  override: Record<string, boolean> | null | undefined,
): PlanFeatures {
  const out: PlanFeatures = { ...base };
  if (!override || typeof override !== 'object') return out;
  for (const [key, value] of Object.entries(override)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** Effective org features = plan features merged with features_override */
export async function resolveOrgFeatures(orgId: string): Promise<PlanFeatures> {
  const org = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: { plan: true, features_override: true },
  });
  if (!org) return { ...DEFAULT_PLAN_FEATURES };

  const planDef = await prisma.planDefinition.findUnique({
    where: { id: org.plan },
    select: { features: true },
  });

  let base: PlanFeatures = { ...DEFAULT_PLAN_FEATURES };
  if (planDef?.features && typeof planDef.features === 'object' && !Array.isArray(planDef.features)) {
    const raw = planDef.features as Record<string, unknown>;
    for (const key of FEATURE_KEYS) {
      if (typeof raw[key] === 'boolean') base[key] = raw[key];
    }
  } else {
    for (const key of FEATURE_KEYS) base[key] = true;
  }

  const override = org.features_override as Record<string, boolean> | null;
  return mergePlanFeatures(base, override);
}

export function hasFeature(features: PlanFeatures, featureKey: string): boolean {
  return features[featureKey] === true;
}

async function rolePermissionKeys(userId: string, legacyRole?: string): Promise<Set<string>> {
  const assignment = await prisma.userOrgRole.findUnique({
    where: { user_id: userId },
    include: { org_role: { include: { permissions: true } } },
  });

  if (assignment?.org_role.permissions.length) {
    return new Set(assignment.org_role.permissions.map((p: { permission_key: string }) => p.permission_key));
  }

  // Fallback: users with no org-role assignment (orgs created before RBAC
  // seeding, or never backfilled) resolve from their legacy role column so
  // permission-gated routes don't lock them out.
  if (legacyRole) {
    const { SYSTEM_ROLE_PERMISSIONS } = await import('../utils/rbac-seed');
    const legacy = SYSTEM_ROLE_PERMISSIONS[legacyRole];
    if (legacy) return new Set(legacy);
  }

  return new Set<string>();
}

/** Effective permissions = rolePermissions ∪ allows − denies */
export async function resolveUserPermissions(
  userId: string,
  orgId: string,
): Promise<Set<string>> {
  const user = await prisma.user.findFirst({
    where: { id: userId, org_id: orgId, deleted_at: null },
    select: { id: true, role: true },
  });
  if (!user) return new Set();

  const effective = await rolePermissionKeys(userId, user.role);

  const grants = await prisma.userPermissionGrant.findMany({
    where: { user_id: userId, org_id: orgId },
  });

  for (const g of grants) {
    if (g.effect === 'allow') effective.add(g.permission_key);
    else if (g.effect === 'deny') effective.delete(g.permission_key);
  }

  return effective;
}

export async function resolvePlatformPermissions(userId: string): Promise<Set<string>> {
  const assignments = await prisma.platformUserRole.findMany({
    where: { user_id: userId },
    include: { platform_role: { include: { permissions: true } } },
  });

  const keys = new Set<string>();
  for (const a of assignments) {
    for (const p of a.platform_role.permissions) keys.add(p.permission_key);
  }

  // Legacy fallback: platform admins created before platform RBAC was seeded
  // (production runs migrations only — the seed never ran there) have no
  // assignment rows at all. Their role column is still the source of truth,
  // so resolve the full platform permission set from the catalog. Assistants
  // always have assignment rows, so this never widens THEIR access.
  if (keys.size === 0 && assignments.length === 0) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role === 'platform_admin') {
      const { PERMISSION_CATALOG } = await import('../constants/rbac');
      for (const p of PERMISSION_CATALOG) {
        if (p.key.startsWith('platform.')) keys.add(p.key);
      }
    }
  }
  return keys;
}

export function can(permissions: Set<string>, permissionKey: string): boolean {
  return permissions.has(permissionKey);
}

export interface UserCapabilities {
  permissions: string[];
  features: PlanFeatures;
  org_role: { id: string; slug: string; name: string } | null;
  platform_permissions: string[];
  /** Org IANA timezone — the client renders all wall-clock times in this zone. */
  timezone: string;
}

export async function getUserCapabilities(
  userId: string,
  orgId: string,
  legacyRole: string,
): Promise<UserCapabilities> {
  const [permissions, features, assignment, platformPerms, org] = await Promise.all([
    resolveUserPermissions(userId, orgId),
    resolveOrgFeatures(orgId),
    prisma.userOrgRole.findUnique({
      where: { user_id: userId },
      include: { org_role: { select: { id: true, slug: true, name: true } } },
    }),
    legacyRole === 'platform_admin'
      ? resolvePlatformPermissions(userId)
      : Promise.resolve(new Set<string>()),
    prisma.organisation.findUnique({ where: { id: orgId }, select: { timezone: true } }),
  ]);

  return {
    permissions: [...permissions].sort(),
    features,
    org_role: assignment?.org_role ?? null,
    platform_permissions: [...platformPerms].sort(),
    timezone: org?.timezone ?? 'UTC',
  };
}
