import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole, requirePermission } from '../middleware/auth';
import { getUserCapabilities, resolveUserPermissions, can } from '../services/authorization';
import { hashPassword, generateToken } from '../utils/auth';
import { ok, created, paginated, NotFoundError, ForbiddenError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

const USER_SELECT = {
  id: true, org_id: true, name: true, email: true, role: true,
  department: true, job_title: true, phone: true, manager_id: true,
  hourly_rate: true, avatar_url: true, is_active: true, setup_complete: true,
  created_at: true, totp_enabled: true, notification_prefs: true,
  manager: { select: { id: true, name: true } },
};

// ─── GET /users/me/capabilities ────────────────────────
router.get('/me/capabilities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caps = await getUserCapabilities(req.user!.sub, req.user!.org_id, req.user!.role);
    ok(res, caps);
  } catch (e) { next(e); }
});

// ─── GET /users/me ─────────────────────────────────────
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: USER_SELECT });
    if (!user) throw new NotFoundError('User');
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── PUT /users/me ─────────────────────────────────────
router.put('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, phone, avatar_url } = req.body;
    const update: Record<string, unknown> = {};
    if (name !== undefined)       update.name       = name;
    if (phone !== undefined)      update.phone      = phone;
    if (avatar_url !== undefined) update.avatar_url = avatar_url;

    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: update,
      select: USER_SELECT,
    });
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── GET /users/me/notification-prefs ──────────────────
router.get('/me/notification-prefs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { notification_prefs: true },
    });
    if (!user) throw new NotFoundError('User');
    ok(res, user.notification_prefs);
  } catch (e) { next(e); }
});

// ─── PUT /users/me/notification-prefs ──────────────────
router.put('/me/notification-prefs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const defaults = { check_in: true, leave_updates: true, shift_reminders: true, payroll: true, announcements: true, late_alerts: true };
    const incoming = req.body as Record<string, boolean>;
    // Merge: only accept known keys
    const prefs: Record<string, boolean> = {};
    for (const key of Object.keys(defaults)) {
      prefs[key] = key in incoming ? Boolean(incoming[key]) : (defaults as Record<string, boolean>)[key];
    }
    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: { notification_prefs: prefs },
      select: { notification_prefs: true },
    });
    ok(res, user.notification_prefs);
  } catch (e) { next(e); }
});

// ─── GET /users/:id/permissions ────────────────────────
router.get('/:id/permissions', requirePermission('org.permissions.grant'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id, deleted_at: null },
    });
    if (!user) throw new NotFoundError('User');

    const grants = await prisma.userPermissionGrant.findMany({
      where: { user_id: user.id, org_id: req.user!.org_id },
      select: { permission_key: true, effect: true },
    });
    ok(res, grants);
  } catch (e) { next(e); }
});

// ─── PUT /users/:id/permissions ────────────────────────
router.put('/:id/permissions', requirePermission('org.permissions.grant'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { grants } = req.body as { grants?: Array<{ permission_key: string; effect: 'allow' | 'deny' }> };
    if (!Array.isArray(grants)) throw new ValidationError('grants must be an array');

    const user = await prisma.user.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id, deleted_at: null },
    });
    if (!user) throw new NotFoundError('User');

    for (const g of grants) {
      if (!g.permission_key || !['allow', 'deny'].includes(g.effect)) {
        throw new ValidationError('Each grant needs permission_key and effect (allow|deny)');
      }
    }

    await prisma.userPermissionGrant.deleteMany({
      where: { user_id: user.id, org_id: req.user!.org_id },
    });

    if (grants.length) {
      await prisma.userPermissionGrant.createMany({
        data: grants.map(g => ({
          user_id: user.id,
          org_id: req.user!.org_id,
          permission_key: g.permission_key,
          effect: g.effect,
        })),
      });
    }

    const saved = await prisma.userPermissionGrant.findMany({
      where: { user_id: user.id, org_id: req.user!.org_id },
      select: { permission_key: true, effect: true },
    });
    ok(res, saved);
  } catch (e) { next(e); }
});

// ─── GET /users/meta/departments ──────────────────────
// Must be before /:id to avoid route conflict
router.get('/meta/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, department: { not: null }, deleted_at: null },
      select: { department: true },
      distinct: ['department'],
    });
    ok(res, users.map((u: typeof users[0]) => u.department).filter(Boolean));
  } catch (e) { next(e); }
});

// ─── GET /users ────────────────────────────────────────
router.get('/', requireRole('manager'), async (req: Request, res: Response, next: NextFunction) => {
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
router.post('/', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, role, department, job_title, phone, hourly_rate, manager_id } = req.body;
    if (!name || !email || !role) throw new ValidationError('name, email and role are required');
    const VALID_ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'];
    if (!VALID_ROLES.includes(role)) throw new ValidationError('Invalid role');
    if (req.user!.role === 'hr_admin' && !['employee', 'manager'].includes(role)) {
      throw new ForbiddenError();
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ValidationError('Email already in use');

    if (manager_id) {
      const mgr = await prisma.user.findFirst({ where: { id: manager_id, org_id: req.user!.org_id } });
      if (!mgr) throw new ValidationError('Manager not found in your organisation');
    }

    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });

    const user = await prisma.user.create({
      data: {
        org_id: req.user!.org_id, name, email,
        password_hash: await hashPassword(inviteToken),
        role, department, job_title, phone,
        hourly_rate: hourly_rate || 0,
        manager_id: manager_id || null,
        invite_token: inviteToken,
        invite_expires: inviteExpires,
      },
      select: USER_SELECT,
    });

    // Seed UserOrgRole for the new user
    const orgRoleForUser = await prisma.orgRole.findUnique({
      where: { org_id_slug: { org_id: req.user!.org_id, slug: role } },
    });
    if (orgRoleForUser) {
      await prisma.userOrgRole.upsert({
        where: { user_id: user.id },
        update: { org_role_id: orgRoleForUser.id },
        create: { user_id: user.id, org_role_id: orgRoleForUser.id },
      });
    }

    // Send welcome email with setup link
    const { sendWelcomeEmail } = await import('../services/email');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const setupLink   = `${frontendUrl}/setup-account?token=${inviteToken}`;
    await sendWelcomeEmail(email, name, org?.name || req.user!.org_id, setupLink).catch(console.error);

    // WhatsApp invite if org has it enabled and user has a phone
    if (org?.wa_enabled && phone) {
      try {
        const { notify } = await import('../services/whatsapp');
        await notify({
          orgId: req.user!.org_id,
          event: 'invite',
          message: `Welcome to ${org.name}! Set up your Attenda account: ${setupLink}`,
          recipientType: 'individual',
          recipientId: phone,
        });
      } catch { /* silent */ }
    }

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
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    // Users can see their own profile; managers/admins can see others in same org
    if (id !== req.user!.sub && !['manager', 'hr_admin', 'super_admin'].includes(req.user!.role)) {
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
router.put('/:id', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { name, role, department, job_title, phone, hourly_rate, manager_id, email, password } = req.body as {
      name?: string; role?: string; department?: string; job_title?: string;
      phone?: string; hourly_rate?: number; manager_id?: string | null;
      email?: string; password?: string;
    };

    if (role !== undefined) {
      const VALID_ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'];
      if (!VALID_ROLES.includes(role)) throw new ValidationError('Invalid role');
      if (req.user!.role === 'hr_admin' && !['employee', 'manager'].includes(role)) {
        throw new ForbiddenError();
      }
    }

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');

    if (manager_id) {
      const mgr = await prisma.user.findFirst({ where: { id: manager_id, org_id: req.user!.org_id } });
      if (!mgr) throw new ValidationError('Manager not found in your organisation');
    }

    // ─── Credentials update: email / password ──────────
    const credentialFields: Record<string, unknown> = {};
    if (email !== undefined || password !== undefined) {
      // Requires credentials.update permission OR super_admin role
      const isSuperAdmin = req.user!.role === 'super_admin';
      let canUpdateCreds = isSuperAdmin;
      if (!canUpdateCreds) {
        const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id, req.user!.role);
        canUpdateCreds = can(perms, 'employees.credentials.update');
      }
      if (!canUpdateCreds) throw new ForbiddenError('employees.credentials.update permission required');

      if (email !== undefined) {
        if (!email.includes('@')) throw new ValidationError('Invalid email address');
        const existing = await prisma.user.findFirst({ where: { email, id: { not: id } } });
        if (existing) throw new ValidationError('Email already in use');
        credentialFields.email = email.toLowerCase().trim();
      }
      if (password !== undefined) {
        if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');
        credentialFields.password_hash = await hashPassword(password);
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(name !== undefined       && { name }),
        ...(role !== undefined       && { role }),
        ...(department !== undefined && { department }),
        ...(job_title !== undefined  && { job_title }),
        ...(phone !== undefined      && { phone }),
        ...(hourly_rate !== undefined && { hourly_rate }),
        manager_id: manager_id !== undefined ? (manager_id || null) : user.manager_id,
        ...credentialFields,
      },
      select: USER_SELECT,
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PATCH /users/:id/deactivate ───────────────────────
router.patch('/:id/deactivate', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (id === req.user!.sub) throw new ValidationError('Cannot deactivate yourself');

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');

    await prisma.user.update({ where: { id }, data: { is_active: false } });

    // Send deactivation email
    const { sendDeactivationEmail } = await import('../services/email');
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    await sendDeactivationEmail(user.email, user.name, org?.name || 'your organisation').catch(console.error);

    ok(res, { message: 'User deactivated' });
  } catch (e) { next(e); }
});

// ─── PATCH /users/:id/activate ─────────────────────────
router.patch('/:id/activate', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');
    if (user.is_active) throw new ValidationError('User is already active');

    await prisma.user.update({ where: { id }, data: { is_active: true } });
    ok(res, { message: 'User activated' });
  } catch (e) { next(e); }
});

// ─── POST /users/import ────────────────────────────────
router.post('/import', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { users } = req.body as { users: Array<{ name: string; email: string; role: string; department?: string }> };
    if (!Array.isArray(users) || users.length === 0) throw new ValidationError('No users provided');

    const org   = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
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
          data: ['annual', 'sick', 'wfh', 'unpaid'].map(lt => ({
            user_id: user.id, org_id: req.user!.org_id, leave_type: lt, year,
            total_days: lt === 'annual' ? 20 : lt === 'sick' ? 10 : lt === 'wfh' ? 5 : 0,
            used_days: 0,
          })),
          skipDuplicates: true,
        });

        // Seed UserOrgRole for imported user
        const importedRole = u.role || 'employee';
        const orgRoleForImport = await prisma.orgRole.findUnique({
          where: { org_id_slug: { org_id: req.user!.org_id, slug: importedRole } },
        });
        if (orgRoleForImport) {
          await prisma.userOrgRole.upsert({
            where: { user_id: user.id },
            update: { org_role_id: orgRoleForImport.id },
            create: { user_id: user.id, org_role_id: orgRoleForImport.id },
          });
        }

        // Send welcome email
        const { sendWelcomeEmail } = await import('../services/email');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const setupLink   = `${frontendUrl}/setup-account?token=${token}`;
        await sendWelcomeEmail(u.email, u.name, org?.name || req.user!.org_id, setupLink).catch(console.error);

        // WhatsApp invite if org has it enabled and user has a phone
        if (org?.wa_enabled && (u as any).phone) {
          try {
            const { notify } = await import('../services/whatsapp');
            await notify({
              orgId: req.user!.org_id,
              event: 'invite',
              message: `Welcome to ${org.name}! Set up your Attenda account: ${setupLink}`,
              recipientType: 'individual',
              recipientId: (u as any).phone,
            });
          } catch { /* silent */ }
        }

        results.created++;
      } catch {
        results.skipped++;
        results.errors.push(`${u.email}: already exists or invalid data`);
      }
    }
    ok(res, results);
  } catch (e) { next(e); }
});

// ─── POST /users/:id/resend-invite ─────────────────────
router.post('/:id/resend-invite', requireRole('hr_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');
    if (user.setup_complete) throw new ValidationError('Account is already set up');

    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id },
      data: { invite_token: inviteToken, invite_expires: inviteExpires },
    });

    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const { sendWelcomeEmail } = await import('../services/email');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const setupLink   = `${frontendUrl}/setup-account?token=${inviteToken}`;
    await sendWelcomeEmail(user.email, user.name, org?.name || req.user!.org_id, setupLink).catch(console.error);

    if (org?.wa_enabled && user.phone) {
      try {
        const { notify } = await import('../services/whatsapp');
        await notify({
          orgId: req.user!.org_id,
          event: 'invite',
          message: `Welcome to ${org.name}! Set up your Attenda account: ${setupLink}`,
          recipientType: 'individual',
          recipientId: user.phone,
        });
      } catch { /* silent */ }
    }

    ok(res, { message: 'Invite resent' });
  } catch (e) { next(e); }
});

export default router;
