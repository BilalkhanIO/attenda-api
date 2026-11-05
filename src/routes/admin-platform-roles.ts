import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { ok, created, NotFoundError, ValidationError, ForbiddenError } from '../utils/response';
import { PERMISSION_CATALOG } from '../constants/rbac';
import { recordAudit } from '../services/audit';
import prisma from '../utils/prisma';
import { idempotency } from '../middleware/idempotency';

const router = Router();
router.use(authenticate);

const PLATFORM_KEYS = new Set(PERMISSION_CATALOG.filter(p => p.key.startsWith('platform.')).map(p => p.key));

function parsePermissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string')) {
    throw new ValidationError('permission_keys must be a list of permission keys');
  }
  const keys = [...new Set(value as string[])];
  const invalid = keys.filter(key => !PLATFORM_KEYS.has(key));
  if (invalid.length) throw new ValidationError(`Only platform permissions can be assigned: ${invalid.join(', ')}`);
  return keys;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

router.get('/', requirePermission('platform.roles.manage'), async (_req, res, next) => {
  try {
    const roles = await prisma.platformRole.findMany({
      include: {
        permissions: { select: { permission_key: true } },
        _count: { select: { users: true } },
      },
      orderBy: { name: 'asc' },
    });
    ok(res, roles.map(role => ({
      slug: role.slug,
      name: role.name,
      description: role.description,
      permission_keys: role.permissions.map(permission => permission.permission_key),
      user_count: role._count.users,
    })));
  } catch (error) { next(error); }
});

router.get('/permissions', requirePermission('platform.roles.manage'), (_req, res) => {
  ok(res, PERMISSION_CATALOG.filter(permission => permission.key.startsWith('platform.')));
});

router.post('/', requirePermission('platform.roles.manage'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const slug = slugify(typeof req.body.slug === 'string' ? req.body.slug : name);
    if (name.length < 2 || name.length > 100) throw new ValidationError('Role name must be 2–100 characters');
    if (!slug) throw new ValidationError('Role slug is required');
    const permissionKeys = parsePermissions(req.body.permission_keys ?? []);

    const role = await prisma.platformRole.create({
      data: {
        slug,
        name,
        description: typeof req.body.description === 'string' ? req.body.description.trim() || null : null,
        permissions: { create: permissionKeys.map(permission_key => ({ permission_key })) },
      },
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'platform.role.create', entityType: 'platform_role', entityId: role.slug,
      after: { name, permission_keys: permissionKeys },
    });
    created(res, { slug: role.slug, name: role.name, description: role.description, permission_keys: permissionKeys, user_count: 0 });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return next(new ValidationError('That role slug is already in use'));
    next(error);
  }
});

router.put('/:slug', requirePermission('platform.roles.manage'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const role = await prisma.platformRole.findUnique({
      where: { slug },
      include: { permissions: { select: { permission_key: true } }, _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundError('Platform role');

    const permissionKeys = parsePermissions(req.body.permission_keys ?? role.permissions.map(permission => permission.permission_key));
    if (slug === 'platform_admin' && !permissionKeys.includes('platform.roles.manage')) {
      throw new ForbiddenError('Keep platform role management on the break-glass Platform Admin role to prevent lockout');
    }
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : role.name;
    if (name.length < 2 || name.length > 100) throw new ValidationError('Role name must be 2–100 characters');

    await prisma.$transaction(async tx => {
      await tx.platformRole.update({ where: { slug }, data: { name } });
      await tx.platformRolePermission.deleteMany({ where: { platform_role_slug: slug } });
      if (permissionKeys.length) {
        await tx.platformRolePermission.createMany({
          data: permissionKeys.map(permission_key => ({ platform_role_slug: slug, permission_key })),
        });
      }
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'platform.role.permissions.update', entityType: 'platform_role', entityId: slug,
      before: { name: role.name, permission_keys: role.permissions.map(permission => permission.permission_key) },
      after: { name, permission_keys: permissionKeys },
    });
    ok(res, { slug, name, description: role.description, permission_keys: permissionKeys, user_count: role._count.users });
  } catch (error) { next(error); }
});

router.delete('/:slug', requirePermission('platform.roles.manage'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    if (slug === 'platform_admin') throw new ForbiddenError('The break-glass Platform Admin role cannot be deleted');
    const role = await prisma.platformRole.findUnique({
      where: { slug }, include: { _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundError('Platform role');
    if (role._count.users) throw new ValidationError('Remove this role from its assigned users before deleting it');

    await prisma.platformRole.delete({ where: { slug } });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'platform.role.delete', entityType: 'platform_role', entityId: slug,
      before: { name: role.name },
    });
    ok(res, { slug, deleted: true });
  } catch (error) { next(error); }
});

export default router;
