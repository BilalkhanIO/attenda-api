import prisma from '../utils/prisma';

/** Resolve employee IDs visible through direct reports and assigned locations.
 * Null means the caller has an explicit organization-wide permission. */
export async function scopedEmployeeIds(orgId: string, userId: string, permissions: Set<string>, orgWidePermission: string): Promise<string[] | null> {
  if (permissions.has(orgWidePermission)) return null;
  const [directReports, managedLocations] = await Promise.all([
    permissions.has('employees.view_team')
      ? prisma.user.findMany({ where: { org_id: orgId, manager_id: userId, is_active: true, deleted_at: null }, select: { id: true } })
      : Promise.resolve([] as { id: string }[]),
    permissions.has('employees.view_location')
      ? prisma.locationManager.findMany({ where: { user_id: userId, location: { org_id: orgId, is_active: true } }, select: { location_id: true } })
      : Promise.resolve([] as { location_id: string }[]),
  ]);
  const locationEmployees = managedLocations.length
    ? await prisma.user.findMany({ where: { org_id: orgId, primary_location_id: { in: managedLocations.map(item => item.location_id) }, is_active: true, deleted_at: null }, select: { id: true } })
    : [];
  return [...new Set([...directReports, ...locationEmployees].map(user => user.id))];
}

/** Resolve employee IDs whose requests a reviewer may act on.
 * Direct-report review scope follows the manager relationship; location scope
 * requires `employees.view_location`. Null means explicit org-wide access. */
export async function reviewableEmployeeIds(orgId: string, userId: string, permissions: Set<string>, orgWidePermission: string): Promise<string[] | null> {
  if (permissions.has(orgWidePermission)) return null;
  const [directReports, managedLocations] = await Promise.all([
    prisma.user.findMany({ where: { org_id: orgId, manager_id: userId, deleted_at: null }, select: { id: true } }),
    permissions.has('employees.view_location')
      ? prisma.locationManager.findMany({ where: { user_id: userId, location: { org_id: orgId, is_active: true } }, select: { location_id: true } })
      : Promise.resolve([] as { location_id: string }[]),
  ]);
  const locationEmployees = managedLocations.length
    ? await prisma.user.findMany({ where: { org_id: orgId, primary_location_id: { in: managedLocations.map(item => item.location_id) }, deleted_at: null }, select: { id: true } })
    : [];
  return [...new Set([...directReports, ...locationEmployees].map(user => user.id))];
}

export function isInEmployeeScope(userId: string, scopedIds: string[] | null): boolean {
  return scopedIds === null || scopedIds.includes(userId);
}
