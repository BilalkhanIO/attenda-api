import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { hasFeature, resolveOrgFeatures } from '../services/authorization';
import prisma from '../utils/prisma';
import { created, NotFoundError, ValidationError, ok } from '../utils/response';
import { validateLocationGeofence } from '../utils/attendanceSecurity';

const router = Router();
router.use(authenticate);

function cleanStringArray(value: unknown, field: string, max = 50): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || v.length > 180)) {
    throw new ValidationError(`${field} must be an array of at most ${max} short strings`);
  }
  return [...new Set(value.map(v => v.trim()).filter(Boolean))];
}

function validTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw new ValidationError('A valid IANA timezone is required');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new ValidationError('A valid IANA timezone is required'); }
  return value;
}

async function validateManagers(orgId: string, ids: unknown): Promise<string[]> {
  const managerIds = cleanStringArray(ids, 'manager_ids', 100);
  if (!managerIds.length) return managerIds;
  const found = await prisma.user.findMany({
    where: { id: { in: managerIds }, org_id: orgId, is_active: true, deleted_at: null },
    select: { id: true },
  });
  if (found.length !== managerIds.length) throw new ValidationError('Every location manager must be an active employee in this organization');
  return managerIds;
}

router.get('/', requirePermission('org.locations.view', 'org.locations.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const locations = await prisma.location.findMany({
      where: { org_id: req.user!.org_id },
      include: {
        managers: { include: { user: { select: { id: true, name: true, email: true, avatar_url: true } } } },
        _count: { select: { primary_users: true, shift_assignments: true } },
      },
      orderBy: [{ is_main: 'desc' }, { name: 'asc' }],
    });
    ok(res, locations);
  } catch (e) { next(e); }
});

router.post('/', requirePermission('org.locations.manage'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.org_id;
    const [count, features] = await Promise.all([
      prisma.location.count({ where: { org_id: orgId } }),
      resolveOrgFeatures(orgId),
    ]);
    if (count > 0 && !hasFeature(features, 'multi_location')) {
      throw new ValidationError('Additional locations require the multi-location organization feature');
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 120) throw new ValidationError('Location name is required (maximum 120 characters)');
    const timezone = validTimezone(req.body.timezone);
    const managerIds = await validateManagers(orgId, req.body.manager_ids);
    const geofence = req.body.geofence === undefined ? undefined : validateLocationGeofence(req.body.geofence);
    const location = await prisma.$transaction(async tx => {
      const createdLocation = await tx.location.create({
        data: {
          org_id: orgId,
          name,
          timezone,
          address: typeof req.body.address === 'string' ? req.body.address.trim().slice(0, 2000) || null : null,
          office_ips: cleanStringArray(req.body.office_ips, 'office_ips'),
          office_ssids: cleanStringArray(req.body.office_ssids, 'office_ssids'),
          geofence: geofence as object | undefined,
          created_by: req.user!.sub,
        },
      });
      if (managerIds.length) await tx.locationManager.createMany({ data: managerIds.map(user_id => ({ location_id: createdLocation.id, user_id })) });
      return createdLocation;
    });
    created(res, location);
  } catch (e) { next(e); }
});

router.put('/:id', requirePermission('org.locations.manage'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.org_id;
    const id = req.params.id as string;
    const existing = await prisma.location.findFirst({ where: { id, org_id: orgId } });
    if (!existing) throw new NotFoundError('Location');
    if (req.body.is_main !== undefined && Boolean(req.body.is_main) !== existing.is_main) throw new ValidationError('The main location cannot be reassigned');
    const data: Record<string, unknown> = {};
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.trim().length > 120) throw new ValidationError('Location name is required (maximum 120 characters)');
      data.name = req.body.name.trim();
    }
    if (req.body.timezone !== undefined) data.timezone = validTimezone(req.body.timezone);
    if (req.body.address !== undefined) data.address = typeof req.body.address === 'string' ? req.body.address.trim().slice(0, 2000) || null : null;
    if (req.body.office_ips !== undefined) data.office_ips = cleanStringArray(req.body.office_ips, 'office_ips');
    if (req.body.office_ssids !== undefined) data.office_ssids = cleanStringArray(req.body.office_ssids, 'office_ssids');
    if (req.body.geofence !== undefined) data.geofence = validateLocationGeofence(req.body.geofence) as object | null;
    if (req.body.is_active !== undefined) {
      if (typeof req.body.is_active !== 'boolean') throw new ValidationError('is_active must be a boolean');
      if (existing.is_main && !req.body.is_active) throw new ValidationError('The main location cannot be deactivated');
      data.is_active = req.body.is_active;
    }
    const managers = req.body.manager_ids === undefined ? null : await validateManagers(orgId, req.body.manager_ids);
    const location = await prisma.$transaction(async tx => {
      const updated = await tx.location.update({ where: { id }, data });
      if (managers) {
        await tx.locationManager.deleteMany({ where: { location_id: id } });
        if (managers.length) await tx.locationManager.createMany({ data: managers.map(user_id => ({ location_id: id, user_id })) });
      }
      if (existing.is_main) {
        await tx.organisation.update({ where: { id: orgId }, data: {
          ...(typeof data.timezone === 'string' ? { timezone: data.timezone } : {}),
          ...(Array.isArray(data.office_ips) ? { office_ips: data.office_ips as string[] } : {}),
          ...(Array.isArray(data.office_ssids) ? { office_ssids: data.office_ssids as string[] } : {}),
        } });
      }
      return updated;
    });
    ok(res, location);
  } catch (e) { next(e); }
});

export default router;
