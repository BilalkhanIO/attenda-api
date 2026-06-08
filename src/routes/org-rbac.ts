import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole, requirePermission } from '../middleware/auth';
import { ok, created, NotFoundError, ValidationError, ForbiddenError } from '../utils/response';
import prisma from '../utils/prisma';
import { PERMISSION_CATALOG } from '../constants/rbac';
import { seedOrgRbacForOrganisation, seedRbacCatalog } from '../utils/rbac-seed';

const router = Router();
router.use(authenticate);

// ─── GET /org/permissions — global catalog ─────────────
router.get('/permissions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ok(res, PERMISSION_CATALOG);
  } catch (e) { next(e); }
});

// ─── GET /org/roles ────────────────────────────────────
router.get('/roles', requirePermission('org.roles.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await prisma.orgRole.findMany({
      where: { org_id: req.user!.org_id },
      include: {
        permissions: { select: { permission_key: true } },
        _count: { select: { users: true } },
      },
      orderBy: [{ is_system: 'desc' }, { name: 'asc' }],
    });
    ok(res, roles.map((r: typeof roles[number]) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      is_system: r.is_system,
      permission_keys: r.permissions.map((p: { permission_key: string }) => p.permission_key),
      user_count: r._count.users,
      created_at: r.created_at,
    })));
  } catch (e) { next(e); }
});

// ─── POST /org/roles ───────────────────────────────────
router.post('/roles', requirePermission('org.roles.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug, permission_keys } = req.body as {
      name?: string;
      slug?: string;
      permission_keys?: string[];
    };
    if (!name?.trim() || !slug?.trim()) throw new ValidationError('name and slug are required');
    const normalizedSlug = slug.trim().toLowerCase().replace(/\s+/g, '_');
    if (SYSTEM_SLUGS.has(normalizedSlug)) throw new ValidationError('Reserved role slug');

    const role = await prisma.orgRole.create({
      data: {
        org_id: req.user!.org_id,
        name: name.trim(),
        slug: normalizedSlug,
        is_system: false,
      },
    });

    if (Array.isArray(permission_keys) && permission_keys.length) {
      await prisma.orgRolePermission.createMany({
        data: permission_keys.map(permission_key => ({ org_role_id: role.id, permission_key })),
        skipDuplicates: true,
      });
    }

    const full = await prisma.orgRole.findUnique({
      where: { id: role.id },
      include: { permissions: { select: { permission_key: true } } },
    });
    created(res, full);
  } catch (e) { next(e); }
});

// ─── PUT /org/roles/:id ────────────────────────────────
router.put('/roles/:id', requirePermission('org.roles.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleId = String(req.params.id);
    const role = await prisma.orgRole.findFirst({
      where: { id: roleId, org_id: req.user!.org_id },
    });
    if (!role) throw new NotFoundError('Role');
    if (role.is_system) throw new ForbiddenError('System roles cannot be renamed');

    const { name } = req.body as { name?: string };
    if (!name?.trim()) throw new ValidationError('name is required');

    const updated = await prisma.orgRole.update({
      where: { id: role.id },
      data: { name: name.trim() },
      include: { permissions: { select: { permission_key: true } } },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PUT /org/roles/:id/permissions ────────────────────
router.put('/roles/:id/permissions', requirePermission('org.roles.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleId = String(req.params.id);
    const role = await prisma.orgRole.findFirst({
      where: { id: roleId, org_id: req.user!.org_id },
    });
    if (!role) throw new NotFoundError('Role');
    if (role.is_system) throw new ForbiddenError('System role permissions are managed by seed');

    const { permission_keys } = req.body as { permission_keys?: string[] };
    if (!Array.isArray(permission_keys)) throw new ValidationError('permission_keys must be an array');

    await prisma.orgRolePermission.deleteMany({ where: { org_role_id: role.id } });
    if (permission_keys.length) {
      await prisma.orgRolePermission.createMany({
        data: permission_keys.map(permission_key => ({ org_role_id: role.id, permission_key })),
        skipDuplicates: true,
      });
    }

    const updated = await prisma.orgRole.findUnique({
      where: { id: role.id },
      include: { permissions: { select: { permission_key: true } } },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /org/roles/:id ─────────────────────────────
router.delete('/roles/:id', requirePermission('org.roles.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleId = String(req.params.id);
    const role = await prisma.orgRole.findFirst({
      where: { id: roleId, org_id: req.user!.org_id },
    });
    if (!role) throw new NotFoundError('Role');
    if (role.is_system) throw new ForbiddenError('System roles cannot be deleted');
    const assigned = await prisma.userOrgRole.count({ where: { org_role_id: role.id } });
    if (assigned > 0) throw new ValidationError('Role is assigned to users');

    await prisma.orgRole.delete({ where: { id: role.id } });
    ok(res, { message: 'Role deleted' });
  } catch (e) { next(e); }
});

// ─── PUT /org/users/:userId/role — assign org role ─────
router.put('/users/:userId/role', requirePermission('org.roles.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { org_role_id } = req.body as { org_role_id?: string };
    if (!org_role_id) throw new ValidationError('org_role_id is required');

    const userId = String(req.params.userId);
    const target = await prisma.user.findFirst({
      where: { id: userId, org_id: req.user!.org_id, deleted_at: null },
    });
    if (!target) throw new NotFoundError('User');

    const orgRole = await prisma.orgRole.findFirst({
      where: { id: org_role_id, org_id: req.user!.org_id },
    });
    if (!orgRole) throw new NotFoundError('Role');

    await prisma.userOrgRole.upsert({
      where: { user_id: target.id },
      update: { org_role_id: orgRole.id },
      create: { user_id: target.id, org_role_id: orgRole.id },
    });

    ok(res, { user_id: target.id, org_role_id: orgRole.id, slug: orgRole.slug });
  } catch (e) { next(e); }
});

// Ensure system roles exist (lazy init for orgs created before RBAC)
router.post('/roles/ensure-system', requireRole('super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await seedRbacCatalog();
    await seedOrgRbacForOrganisation(req.user!.org_id);
    ok(res, { message: 'System roles ensured' });
  } catch (e) { next(e); }
});

const SYSTEM_SLUGS = new Set(['employee', 'manager', 'hr_admin', 'super_admin']);

export default router;
