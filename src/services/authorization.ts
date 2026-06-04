import prisma from '../utils/prisma';
import {
  DEFAULT_PLAN_FEATURES,
  FEATURE_KEYS,
  LEGACY_ROLE_PERMISSIONS,
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
    // Unknown plan (e.g. trial): enable all features until plan is assigned
    for (const key of FEATURE_KEYS) base[key] = true;
  }

  const override = org.features_override as Record<string, boolean> | null;
  return mergePlanFeatures(base, override);
}

export function hasFeature(features: PlanFeatures, featureKey: string): boolean {
  return features[featureKey] === true;
}

async function rolePermissionKeys(userId: string, legacyRole: string): Promise<Set<string>> {
  const assignment = await prisma.userOrgRole.findUnique({
    where: { user_id: userId },
    include: { org_role: { include: { permissions: true } } },
  });

  if (assignment?.org_role.permissions.length) {
    return new Set(assignment.org_role.permissions.map((p: { permission_key: string }) => p.permission_key));
  }

  const legacy = LEGACY_ROLE_PERMISSIONS[legacyRole];
  return new Set(legacy ?? []);
}

/** Effective permissions = rolePermissions ∪ allows − denies */
export async function resolveUserPermissions(
  userId: string,
  orgId: string,
  legacyRole: string,
): Promise<Set<string>> {
  const user = await prisma.user.findFirst({
    where: { id: userId, org_id: orgId, deleted_at: null },
    select: { role: true },
  });
  if (!user) return new Set();

  const role = legacyRole || user.role;
  const effective = await rolePermissionKeys(userId, role);

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
}

export async function getUserCapabilities(
  userId: string,
  orgId: string,
  legacyRole: string,
): Promise<UserCapabilities> {
  const [permissions, features, assignment, platformPerms] = await Promise.all([
    resolveUserPermissions(userId, orgId, legacyRole),
    resolveOrgFeatures(orgId),
    prisma.userOrgRole.findUnique({
      where: { user_id: userId },
      include: { org_role: { select: { id: true, slug: true, name: true } } },
    }),
    legacyRole === 'platform_admin'
      ? resolvePlatformPermissions(userId)
      : Promise.resolve(new Set<string>()),
  ]);

  return {
    permissions: [...permissions].sort(),
    features,
    org_role: assignment?.org_role ?? null,
    platform_permissions: [...platformPerms].sort(),
  };
}

/** Legacy fallback when DB role assignment is missing */
export function legacyRoleHasPermission(legacyRole: string, permissionKey: string): boolean {
  const perms = LEGACY_ROLE_PERMISSIONS[legacyRole];
  return perms?.includes(permissionKey) ?? false;
}
