import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { authenticate } from '../middleware/auth';
import { ok, ValidationError, NotFoundError, ForbiddenError } from '../utils/response';
import { generateToken } from '../utils/auth';

const router = Router();

// Only platform_admin can access these routes
router.use(authenticate, (req: Request, res: Response, next: NextFunction) => {
  if (req.user!.role !== 'platform_admin') throw new ForbiddenError();
  next();
});

// GET /admin/stats — global platform stats
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [orgCount, userCount, activeToday, pendingCount] = await Promise.all([
      prisma.organisation.count({ where: { status: 'active' } }),
      prisma.user.count({ where: { deleted_at: null } }),
      prisma.attendanceRecord.count({ where: { date: new Date(new Date().setHours(0,0,0,0)) } }),
      prisma.organisation.count({ where: { status: 'pending' } }),
    ]);
    ok(res, { org_count: orgCount, user_count: userCount, active_today: activeToday, pending_count: pendingCount });
  } catch (e) { next(e); }
});

function mapOrg(org: any) {
  const hasLogo    = !!org.logo_url;
  const hasIPs     = org.office_ips.length > 0;
  const onboarding = { profile_set: hasLogo, ips_set: hasIPs, wa_enabled: org.wa_enabled };
  const score = Object.values(onboarding).filter(Boolean).length;
  return {
    id:            org.id,
    name:          org.name,
    plan:          org.plan,
    status:        org.status,
    timezone:      org.timezone,
    created_at:    org.created_at,
    contact_name:  org.contact_name,
    contact_email: org.contact_email,
    company_size:  org.company_size,
    user_count:    org._count?.users ?? 0,
    onboarding,
    onboarding_score: score,
  };
}

// GET /admin/orgs — list all active/suspended organisations
router.get('/orgs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orgs = await prisma.organisation.findMany({
      where: { status: { not: 'pending' } },
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { users: { where: { deleted_at: null, is_active: true } } } } },
    });
    ok(res, orgs.map(mapOrg));
  } catch (e) { next(e); }
});

// GET /admin/orgs/pending — list pending applications
router.get('/orgs/pending', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orgs = await prisma.organisation.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { users: { where: { deleted_at: null, is_active: true } } } } },
    });
    ok(res, orgs.map(mapOrg));
  } catch (e) { next(e); }
});

// GET /admin/orgs/:id — single org detail
router.get('/orgs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUniqueOrThrow({
      where: { id: req.params.id as string },
      include: {
        _count: {
          select: {
            users:              { where: { deleted_at: null } },
            attendance_records: true,
            leave_requests:     true,
            payroll_records:    true,
          },
        },
      },
    });
    ok(res, org);
  } catch (e) { next(e); }
});

// PATCH /admin/orgs/:id/plan — update org plan
router.patch('/orgs/:id/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { plan } = req.body;
    if (!['trial', 'starter', 'growth', 'enterprise', 'suspended'].includes(plan)) {
      return res.status(422).json({ success: false, error: 'Invalid plan' });
    }
    const org = await prisma.organisation.update({ where: { id: req.params.id as string }, data: { plan } });
    ok(res, org);
  } catch (e) { next(e); }
});

// PATCH /admin/orgs/:id/suspend — toggle org suspension
router.patch('/orgs/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    const newPlan = org.plan === 'suspended' ? 'trial' : 'suspended';
    const updated = await prisma.organisation.update({ where: { id: req.params.id as string }, data: { plan: newPlan } });
    ok(res, updated);
  } catch (e) { next(e); }
});

// POST /admin/orgs/:id/approve — approve a pending application
// Creates the super_admin user with an invite token so they can set up their password
router.post('/orgs/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    if (org.status !== 'pending') throw new ValidationError('Organisation is not pending approval');
    if (!org.contact_email) throw new ValidationError('Organisation has no contact email — cannot create admin user');

    // Activate the org
    await prisma.organisation.update({ where: { id: org.id }, data: { status: 'active' } });

    // Create the super_admin user with an invite token
    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const user = await prisma.user.create({
      data: {
        org_id:         org.id,
        name:           org.contact_name || org.name,
        email:          org.contact_email,
        password_hash:  '',         // set when they claim the invite
        role:           'super_admin',
        setup_complete: false,
        invite_token:   inviteToken,
        invite_expires: inviteExpires,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0]?.trim() || 'http://localhost:3000';
    const setupUrl    = `${frontendUrl}/setup-account?token=${inviteToken}`;

    ok(res, { org_id: org.id, user_id: user.id, setup_url: setupUrl, invite_token: inviteToken });
  } catch (e) { next(e); }
});

// POST /admin/orgs/:id/reject — reject a pending application
router.post('/orgs/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    if (org.status !== 'pending') throw new ValidationError('Organisation is not pending');
    await prisma.organisation.update({ where: { id: org.id }, data: { status: 'rejected' } });
    ok(res, { message: 'Application rejected' });
  } catch (e) { next(e); }
});

// POST /admin/orgs — create a new organisation directly (no onboarding flow)
router.post('/orgs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, timezone = 'UTC', currency = 'USD', plan = 'trial' } = req.body;
    if (!name?.trim()) throw new ValidationError('name is required');
    if (!['trial', 'starter', 'growth', 'enterprise'].includes(plan)) throw new ValidationError('Invalid plan');
    const org = await prisma.organisation.create({
      data: { name: name.trim(), timezone, currency, plan, status: 'active' },
    });
    ok(res, org, 201);
  } catch (e) { next(e); }
});

// GET /admin/orgs/:id/users — list users for an org
router.get('/orgs/:id/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    const users = await prisma.user.findMany({
      where: { org_id: req.params.id as string, deleted_at: null },
      select: {
        id: true, name: true, email: true, role: true,
        department: true, job_title: true, is_active: true,
        created_at: true, avatar_url: true,
      },
      orderBy: { name: 'asc' },
    });
    ok(res, users);
  } catch (e) { next(e); }
});

export default router;
