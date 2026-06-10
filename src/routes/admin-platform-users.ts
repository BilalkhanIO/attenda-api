import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { ok, created, noContent, NotFoundError, ValidationError, ForbiddenError } from '../utils/response';
import { hashPassword } from '../utils/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

// ─── GET /admin/users ──────────────────────────────────
router.get('/', requirePermission('platform.users.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;
    const where: any = {};
    
    // Role filter
    if (role) {
      where.platform_role_assignments = {
        some: {
          platform_role: {
            slug: role
          }
        }
      };
    }

    const users = await prisma.user.findMany({
      where: {
        ...where,
        // Only get users who have at least one platform role
        platform_role_assignments: {
          some: {}
        },
        deleted_at: null
      },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        platform_role_assignments: {
          include: {
            platform_role: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    const mapped = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      created_at: u.created_at,
      roles: u.platform_role_assignments.map((pr: any) => ({
        id: pr.platform_role.slug,
        name: pr.platform_role.name,
        slug: pr.platform_role.slug
      }))
    }));

    ok(res, mapped);
  } catch (e) { next(e); }
});

// ─── GET /admin/users/:id ──────────────────────────────
router.get('/:id', requirePermission('platform.users.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findFirst({
      where: { 
        id,
        platform_role_assignments: { some: {} },
        deleted_at: null
      },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        platform_role_assignments: {
          include: {
            platform_role: true
          }
        }
      }
    });

    if (!user) throw new NotFoundError('Platform User');

    ok(res, {
      ...user,
      roles: user.platform_role_assignments.map((pr: any) => ({
        id: pr.platform_role.slug,
        name: pr.platform_role.name,
        slug: pr.platform_role.slug
      }))
    });
  } catch (e) { next(e); }
});

// ─── POST /admin/users ─────────────────────────────────
router.post('/', requirePermission('platform.users.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password, roles } = req.body;
    
    if (!name || !email || !password) {
      throw new ValidationError('name, email, and password are required');
    }

    if (!Array.isArray(roles) || roles.length === 0) {
      throw new ValidationError('At least one platform role is required');
    }

    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) {
      throw new ValidationError('Email already in use');
    }

    // Verify all roles exist
    const dbRoles = await prisma.platformRole.findMany({
      where: { slug: { in: roles } }
    });

    if (dbRoles.length !== roles.length) {
      throw new ValidationError('One or more invalid roles provided');
    }

    const hashedPassword = await hashPassword(password);

    // Create user and assign roles
    const user = await prisma.$transaction(async (tx) => {
      // user.org_id is a required FK — make sure the SYSTEM organisation exists
      // even on deployments where db:seed was never run.
      await tx.organisation.upsert({
        where: { id: 'SYSTEM' },
        update: {},
        create: { id: 'SYSTEM', name: 'Attenda System', timezone: 'UTC', currency: 'USD', status: 'active', subscription_status: 'active' },
      });

      // Create user assigned to the SYSTEM organization
      const u = await tx.user.create({
        data: {
          name,
          email,
          password_hash: hashedPassword,
          role: 'platform_admin', // Default legacy role for backwards compatibility
          org_id: 'SYSTEM', // Official system organization ID for platform admins
        }
      });

      // Assign platform roles
      for (const role of dbRoles) {
        await tx.platformUserRole.create({
          data: {
            user_id: u.id,
            platform_role_slug: role.slug
          }
        });
      }

      return u;
    });

    created(res, { id: user.id, name: user.name, email: user.email });
  } catch (e) { next(e); }
});

// ─── PUT /admin/users/:id ──────────────────────────────
router.put('/:id', requirePermission('platform.users.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { name, email, password, roles } = req.body;
    
    const user = await prisma.user.findFirst({
      where: { 
        id,
        platform_role_assignments: { some: {} },
        deleted_at: null
      }
    });

    if (!user) throw new NotFoundError('Platform User');

    // Super admin protection: cannot edit other super admins unless you are one
    // (Assuming this logic if we want to enforce it, but leaving it open based on capabilities for now)

    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) {
      const existing = await prisma.user.findFirst({ where: { email, id: { not: id } } });
      if (existing) throw new ValidationError('Email already in use');
      updateData.email = email;
    }
    if (password) {
      updateData.password_hash = await hashPassword(password);
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.user.update({
          where: { id: user.id },
          data: updateData
        });
      }

      if (Array.isArray(roles)) {
        // Verify roles
        const dbRoles = await tx.platformRole.findMany({
          where: { slug: { in: roles } }
        });
        if (dbRoles.length !== roles.length) {
          throw new ValidationError('One or more invalid roles provided');
        }

        // Delete existing roles
        await tx.platformUserRole.deleteMany({
          where: { user_id: user.id }
        });

        // Insert new roles
        for (const role of dbRoles) {
          await tx.platformUserRole.create({
            data: {
              user_id: user.id,
              platform_role_slug: role.slug
            }
          });
        }
      }
    });

    ok(res, { message: 'User updated successfully' });
  } catch (e) { next(e); }
});

// ─── DELETE /admin/users/:id ───────────────────────────
router.delete('/:id', requirePermission('platform.users.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    // Prevent self-deletion
    if (id === req.user!.sub) {
      throw new ForbiddenError('You cannot delete your own account');
    }

    const user = await prisma.user.findFirst({
      where: { 
        id,
        platform_role_assignments: { some: {} },
        deleted_at: null
      }
    });

    if (!user) throw new NotFoundError('Platform User');

    // Soft delete
    await prisma.user.update({
      where: { id: user.id },
      data: { deleted_at: new Date() }
    });

    noContent(res);
  } catch (e) { next(e); }
});

export default router;
