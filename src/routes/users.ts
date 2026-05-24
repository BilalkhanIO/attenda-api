// @ts-nocheck
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { hashPassword, generateToken } from '../utils/auth';
import { ok, created, paginated, NotFoundError, ForbiddenError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

const USER_SELECT = {
  id: true, org_id: true, name: true, email: true, role: true,
  department: true, job_title: true, phone: true, manager_id: true,
  hourly_rate: true, avatar_url: true, is_active: true, setup_complete: true,
  created_at: true,
  manager: { select: { id: true, name: true } },
};

// ─── GET /users/me ─────────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: USER_SELECT });
    if (!user) throw new NotFoundError('User');
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── PUT /users/me ─────────────────────────────────────
router.put('/me', async (req, res, next) => {
  try {
    const { name, phone, avatar_url } = req.body;
    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: { name, phone, avatar_url },
      select: USER_SELECT,
    });
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── GET /users ────────────────────────────────────────
router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const { page = '1', limit = '50', department, role, status, search } = req.query as Record<string, string>;
    const pg = Math.max(1, parseInt(page));
    const lm = Math.min(100, parseInt(limit));

    const where: Record<string, unknown> = {
      org_id: req.user!.org_id,
      deleted_at: null,
    };
    if (department) where.department = department;
    if (role)       where.role       = role;
    if (status)     where.is_active  = status === 'active';
    if (search)     where.OR         = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];

    // Managers only see their team
    if (req.user!.role === 'manager') {
      where.manager_id = req.user!.sub;
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, select: USER_SELECT, skip: (pg - 1) * lm, take: lm, orderBy: { name: 'asc' } }),
      prisma.user.count({ where }),
    ]);

    paginated(res, users, total, pg, lm);
  } catch (e) { next(e); }
});

// ─── POST /users ───────────────────────────────────────
router.post('/', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { name, email, role, department, job_title, phone, hourly_rate, manager_id } = req.body;
    if (!name || !email || !role) throw new ValidationError('name, email and role are required');

    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const user = await prisma.user.create({
      data: {
        org_id: req.user!.org_id, name, email,
        password_hash: await hashPassword(inviteToken), // placeholder until setup
        role, department, job_title, phone,
        hourly_rate: hourly_rate || 0,
        manager_id: manager_id || null,
        invite_token: inviteToken,
        invite_expires: inviteExpires,
      },
      select: USER_SELECT,
    });

    // Send welcome email with setup link
    const { sendWelcomeEmail } = await import('../services/email');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const setupLink   = `${frontendUrl}/setup-account?token=${inviteToken}`;
    await sendWelcomeEmail(email, name, req.user!.org_id, setupLink).catch(console.error);

    // Create default leave balances
    const leaveTypes = ['annual', 'sick', 'wfh', 'unpaid'];
    const year = new Date().getFullYear();
    await prisma.leaveBalance.createMany({
      data: leaveTypes.map(lt => ({
        user_id: user.id, org_id: req.user!.org_id, leave_type: lt, year,
        total_days: lt === 'annual' ? 20 : lt === 'sick' ? 10 : lt === 'wfh' ? 5 : 0,
        used_days: 0,
      })),
      skipDuplicates: true,
    });

    created(res, user);
  } catch (e) { next(e); }
});

// ─── GET /users/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Users can see their own profile; managers/admins can see others in same org
    if (id !== req.user!.sub && !['manager','hr_admin','super_admin'].includes(req.user!.role)) {
      throw new ForbiddenError();
    }
    const user = await prisma.user.findFirst({
      where: { id, org_id: req.user!.org_id, deleted_at: null },
      select: USER_SELECT,
    });
    if (!user) throw new NotFoundError('User');
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── PUT /users/:id ────────────────────────────────────
router.put('/:id', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, role, department, job_title, phone, hourly_rate, manager_id } = req.body;

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id } });
    if (!user) throw new NotFoundError('User');

    const updated = await prisma.user.update({
      where: { id },
      data: { name, role, department, job_title, phone, hourly_rate: hourly_rate ?? user.hourly_rate, manager_id: manager_id || null },
      select: USER_SELECT,
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PATCH /users/:id/deactivate ───────────────────────
router.patch('/:id/deactivate', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.user!.sub) throw new ValidationError('Cannot deactivate yourself');

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id } });
    if (!user) throw new NotFoundError('User');

    await prisma.user.update({ where: { id }, data: { is_active: false } });
    ok(res, { message: 'User deactivated' });
  } catch (e) { next(e); }
});

// ─── POST /users/import ────────────────────────────────
router.post('/import', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { users } = req.body as { users: Array<{ name: string; email: string; role: string; department?: string }> };
    if (!Array.isArray(users) || users.length === 0) throw new ValidationError('No users provided');

    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const year = new Date().getFullYear();

    for (const u of users) {
      try {
        const token   = generateToken();
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const user = await prisma.user.create({
          data: {
            org_id: req.user!.org_id, name: u.name, email: u.email,
            password_hash: await hashPassword(token),
            role: u.role || 'employee', department: u.department || null,
            invite_token: token, invite_expires: expires,
          },
        });
        await prisma.leaveBalance.createMany({
          data: ['annual','sick','wfh','unpaid'].map(lt => ({
            user_id: user.id, org_id: req.user!.org_id, leave_type: lt, year,
            total_days: lt === 'annual' ? 20 : lt === 'sick' ? 10 : lt === 'wfh' ? 5 : 0,
            used_days: 0,
          })),
          skipDuplicates: true,
        });
        results.created++;
      } catch {
        results.skipped++;
        results.errors.push(`${u.email}: already exists or invalid data`);
      }
    }
    ok(res, results);
  } catch (e) { next(e); }
});

// ─── GET /users/departments ────────────────────────────
router.get('/meta/departments', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, department: { not: null }, deleted_at: null },
      select: { department: true },
      distinct: ['department'],
    });
    ok(res, users.map(u => u.department).filter(Boolean));
  } catch (e) { next(e); }
});

export default router;
