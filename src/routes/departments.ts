import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { ok, created, NotFoundError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

// Mounted at /api/v1/org/departments (before the legacy orgRouter so this
// router owns the path). GET / stays backward-compatible with the old
// string-array response; structured data lives under /tree.
const router = Router();
router.use(authenticate);

// ─── GET /org/departments — flat name list (backward compatible) ──
// Merges the structured departments table with any legacy free-text
// department strings still present on users.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [departments, legacyUsers] = await Promise.all([
      prisma.department.findMany({
        where: { org_id: req.user!.org_id },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.user.findMany({
        where: { org_id: req.user!.org_id, department: { not: null }, deleted_at: null },
        select: { department: true },
        distinct: ['department'],
      }),
    ]);
    const names = new Set<string>();
    for (const d of departments) names.add(d.name);
    for (const u of legacyUsers) if (u.department) names.add(u.department);
    ok(res, [...names].sort());
  } catch (e) { next(e); }
});

// ─── GET /org/departments/tree — structured hierarchy ──
router.get('/tree', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const departments = await prisma.department.findMany({
      where: { org_id: req.user!.org_id },
      include: { _count: { select: { users: { where: { deleted_at: null, is_active: true } }, children: true } } },
      orderBy: { name: 'asc' },
    });

    type Node = {
      id: string; name: string; parent_id: string | null;
      member_count: number; created_at: Date; children: Node[];
    };
    const nodes = new Map<string, Node>();
    for (const d of departments) {
      nodes.set(d.id, {
        id: d.id, name: d.name, parent_id: d.parent_id,
        member_count: d._count.users, created_at: d.created_at, children: [],
      });
    }
    const roots: Node[] = [];
    for (const node of nodes.values()) {
      const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    ok(res, roots);
  } catch (e) { next(e); }
});

// ─── POST /org/departments ─────────────────────────────
router.post('/', requirePermission('org.departments.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, parent_id } = req.body as { name?: string; parent_id?: string | null };
    if (!name?.trim()) throw new ValidationError('name is required');

    if (parent_id) {
      const parent = await prisma.department.findFirst({
        where: { id: parent_id, org_id: req.user!.org_id },
      });
      if (!parent) throw new NotFoundError('Parent department');
      if (parent.parent_id) throw new ValidationError('Departments can only be nested one level deep');
    }

    const existing = await prisma.department.findFirst({
      where: { org_id: req.user!.org_id, name: name.trim(), parent_id: parent_id || null },
    });
    if (existing) throw new ValidationError('A department with this name already exists at this level');

    const department = await prisma.department.create({
      data: { org_id: req.user!.org_id, name: name.trim(), parent_id: parent_id || null },
    });
    created(res, department);
  } catch (e) { next(e); }
});

// ─── PUT /org/departments/:id ──────────────────────────
router.put('/:id', requirePermission('org.departments.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, parent_id } = req.body as { name?: string; parent_id?: string | null };
    const department = await prisma.department.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
    });
    if (!department) throw new NotFoundError('Department');

    const data: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!name.trim()) throw new ValidationError('name cannot be empty');
      data.name = name.trim();
    }
    if (parent_id !== undefined) {
      if (parent_id === department.id) throw new ValidationError('A department cannot be its own parent');
      if (parent_id) {
        const parent = await prisma.department.findFirst({
          where: { id: parent_id, org_id: req.user!.org_id },
        });
        if (!parent) throw new NotFoundError('Parent department');
        if (parent.parent_id) throw new ValidationError('Departments can only be nested one level deep');
        const hasChildren = await prisma.department.count({ where: { parent_id: department.id } });
        if (hasChildren > 0) throw new ValidationError('A department with sub-departments cannot become a sub-department');
      }
      data.parent_id = parent_id || null;
    }

    const updated = await prisma.department.update({
      where: { id: department.id },
      data,
    });

    // Keep the legacy free-text department column on users in sync with renames
    if (name !== undefined && name.trim() !== department.name) {
      await prisma.user.updateMany({
        where: { department_id: department.id },
        data: { department: name.trim() },
      });
    }

    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /org/departments/:id ───────────────────────
router.delete('/:id', requirePermission('org.departments.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const department = await prisma.department.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
      include: { _count: { select: { users: true, children: true } } },
    });
    if (!department) throw new NotFoundError('Department');
    if (department._count.children > 0) throw new ValidationError('Remove sub-departments first');
    if (department._count.users > 0) throw new ValidationError('Reassign members before deleting this department');

    await prisma.department.delete({ where: { id: department.id } });
    ok(res, { message: 'Department deleted' });
  } catch (e) { next(e); }
});

export default router;
