import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { authenticate } from '../middleware/auth';
import { ok, ValidationError, NotFoundError, ForbiddenError } from '../utils/response';
import { generateToken } from '../utils/auth';

const router = Router();

router.use(authenticate, (req: Request, res: Response, next: NextFunction) => {
  if (req.user!.role !== 'platform_admin') throw new ForbiddenError();
  next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapOrg(org: any) {
  const hasLogo    = !!org.logo_url;
  const hasIPs     = org.office_ips.length > 0;
  const onboarding = { profile_set: hasLogo, ips_set: hasIPs, wa_enabled: org.wa_enabled };
  const score = Object.values(onboarding).filter(Boolean).length;
  return {
    id:                  org.id,
    name:                org.name,
    plan:                org.plan,
    status:              org.status,
    subscription_status: org.subscription_status,
    trial_started_at:    org.trial_started_at,
    trial_ends_at:       org.trial_ends_at,
    seats_limit:         org.seats_limit,
    features_override:   org.features_override,
    admin_notes:         org.admin_notes,
    billing_email:       org.billing_email,
    timezone:            org.timezone,
    created_at:          org.created_at,
    contact_name:        org.contact_name,
    contact_email:       org.contact_email,
    company_size:        org.company_size,
    user_count:          org._count?.users ?? 0,
    onboarding,
    onboarding_score: score,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [orgCount, userCount, activeToday, pendingCount, trialingCount, inactiveCount] = await Promise.all([
      prisma.organisation.count({ where: { status: 'active' } }),
      prisma.user.count({ where: { deleted_at: null } }),
      prisma.attendanceRecord.count({ where: { date: new Date(new Date().setHours(0, 0, 0, 0)) } }),
      prisma.organisation.count({ where: { status: 'pending' } }),
      prisma.organisation.count({ where: { subscription_status: 'trialing' } }),
      prisma.organisation.count({ where: { subscription_status: 'inactive' } }),
    ]);
    ok(res, { org_count: orgCount, user_count: userCount, active_today: activeToday, pending_count: pendingCount, trialing_count: trialingCount, inactive_count: inactiveCount });
  } catch (e) { next(e); }
});

// ── Organisations ─────────────────────────────────────────────────────────────

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
    ok(res, mapOrg({ ...org, _count: (org as any)._count }));
  } catch (e) { next(e); }
});

// PATCH /admin/orgs/:id/plan
router.patch('/orgs/:id/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { plan } = req.body;
    if (!plan?.trim()) throw new ValidationError('plan is required');
    const org = await prisma.organisation.update({ where: { id: req.params.id as string }, data: { plan } });
    ok(res, mapOrg(org));
  } catch (e) { next(e); }
});

// PATCH /admin/orgs/:id/suspend
router.patch('/orgs/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    const newStatus = org.status === 'suspended' ? 'active' : 'suspended';
    const updated   = await prisma.organisation.update({
      where: { id: req.params.id as string },
      data:  { status: newStatus, subscription_status: newStatus === 'suspended' ? 'suspended' : org.subscription_status },
    });
    ok(res, mapOrg(updated));
  } catch (e) { next(e); }
});

// PATCH /admin/orgs/:id/subscription — full subscription control for platform admin
router.patch('/orgs/:id/subscription', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      subscription_status, plan, seats_limit, features_override,
      admin_notes, billing_email, trial_ends_at,
    } = req.body;

    const validStatuses = ['trialing', 'active', 'inactive', 'suspended', 'defaulted'];
    if (subscription_status && !validStatuses.includes(subscription_status)) {
      throw new ValidationError(`subscription_status must be one of: ${validStatuses.join(', ')}`);
    }

    const data: any = {};
    if (subscription_status !== undefined) data.subscription_status = subscription_status;
    if (plan !== undefined) data.plan = plan;
    if (seats_limit !== undefined) data.seats_limit = seats_limit === null ? null : Number(seats_limit);
    if (features_override !== undefined) data.features_override = features_override;
    if (admin_notes !== undefined) data.admin_notes = admin_notes;
    if (billing_email !== undefined) data.billing_email = billing_email;
    if (trial_ends_at !== undefined) data.trial_ends_at = trial_ends_at ? new Date(trial_ends_at) : null;

    const org = await prisma.organisation.update({ where: { id: req.params.id as string }, data });
    ok(res, mapOrg(org));
  } catch (e) { next(e); }
});

// POST /admin/orgs/:id/extend-trial — add N days to trial
router.post('/orgs/:id/extend-trial', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Number(req.body.days);
    if (!days || days < 1 || days > 365) throw new ValidationError('days must be between 1 and 365');

    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');

    const base     = org.trial_ends_at && org.trial_ends_at > new Date() ? org.trial_ends_at : new Date();
    const newEndsAt = new Date(base.getTime() + days * 86400000);

    const updated = await prisma.organisation.update({
      where: { id: req.params.id as string },
      data:  { trial_ends_at: newEndsAt, subscription_status: 'trialing' },
    });
    ok(res, mapOrg(updated));
  } catch (e) { next(e); }
});

// POST /admin/orgs/:id/activate — manually activate a defaulted/inactive org
router.post('/orgs/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await prisma.organisation.update({
      where: { id: req.params.id as string },
      data:  { subscription_status: 'active', status: 'active' },
    });
    ok(res, mapOrg(updated));
  } catch (e) { next(e); }
});

// POST /admin/orgs/:id/approve
router.post('/orgs/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    if (org.status !== 'pending') throw new ValidationError('Organisation is not pending approval');
    if (!org.contact_email) throw new ValidationError('Organisation has no contact email');

    // Determine trial length from plan definition or default 14 days
    const planDef = await prisma.planDefinition.findUnique({ where: { id: org.plan } });
    const trialDays = planDef?.trial_days ?? 14;
    const now       = new Date();
    const trialEnds = new Date(now.getTime() + trialDays * 86400000);

    await prisma.organisation.update({
      where: { id: org.id },
      data: {
        status:              'active',
        subscription_status: 'trialing',
        trial_started_at:    now,
        trial_ends_at:       trialEnds,
      },
    });

    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        org_id:         org.id,
        name:           org.contact_name || org.name,
        email:          org.contact_email,
        password_hash:  '',
        role:           'super_admin',
        setup_complete: false,
        invite_token:   inviteToken,
        invite_expires: inviteExpires,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0]?.trim() || 'http://localhost:3000';
    const setupUrl    = `${frontendUrl}/setup-account?token=${inviteToken}`;

    ok(res, { org_id: org.id, user_id: user.id, setup_url: setupUrl, invite_token: inviteToken, trial_ends_at: trialEnds });
  } catch (e) { next(e); }
});

// POST /admin/orgs/:id/reject
router.post('/orgs/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id as string } });
    if (!org) throw new NotFoundError('Organisation');
    if (org.status !== 'pending') throw new ValidationError('Organisation is not pending');
    await prisma.organisation.update({ where: { id: org.id }, data: { status: 'rejected' } });
    ok(res, { message: 'Application rejected' });
  } catch (e) { next(e); }
});

// POST /admin/orgs — direct org creation
router.post('/orgs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, timezone = 'UTC', currency = 'USD', plan = 'starter' } = req.body;
    if (!name?.trim()) throw new ValidationError('name is required');
    const org = await prisma.organisation.create({
      data: { name: name.trim(), timezone, currency, plan, status: 'active', subscription_status: 'active' },
    });
    ok(res, mapOrg(org));
  } catch (e) { next(e); }
});

// GET /admin/orgs/:id/users
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

// ── Plan Definitions ──────────────────────────────────────────────────────────

router.get('/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await prisma.planDefinition.findMany({ orderBy: { sort_order: 'asc' } });
    ok(res, plans);
  } catch (e) { next(e); }
});

router.post('/plans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, display_name, price_monthly, price_annual, max_employees, trial_days, features, description, highlight, is_active, sort_order } = req.body;
    if (!id?.trim()) throw new ValidationError('id is required');
    if (!display_name?.trim()) throw new ValidationError('display_name is required');
    const plan = await prisma.planDefinition.create({
      data: {
        id: id.trim(),
        display_name: display_name.trim(),
        price_monthly: price_monthly ?? 0,
        price_annual:  price_annual  ?? 0,
        max_employees: max_employees ?? 0,
        trial_days:    trial_days    ?? 14,
        features:      features      ?? {},
        description,
        highlight:  highlight  ?? false,
        is_active:  is_active  ?? true,
        sort_order: sort_order ?? 0,
      },
    });
    ok(res, plan, 201);
  } catch (e) { next(e); }
});

router.put('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { display_name, price_monthly, price_annual, max_employees, trial_days, features, description, highlight, is_active, sort_order } = req.body;
    const plan = await prisma.planDefinition.update({
      where: { id: req.params.id as string },
      data:  {
        ...(display_name   !== undefined && { display_name }),
        ...(price_monthly  !== undefined && { price_monthly }),
        ...(price_annual   !== undefined && { price_annual }),
        ...(max_employees  !== undefined && { max_employees }),
        ...(trial_days     !== undefined && { trial_days }),
        ...(features       !== undefined && { features }),
        ...(description    !== undefined && { description }),
        ...(highlight      !== undefined && { highlight }),
        ...(is_active      !== undefined && { is_active }),
        ...(sort_order     !== undefined && { sort_order }),
      },
    });
    ok(res, plan);
  } catch (e) { next(e); }
});

router.delete('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.planDefinition.delete({ where: { id: req.params.id as string } });
    ok(res, { message: 'Plan deleted' });
  } catch (e) { next(e); }
});

// ── Blog ──────────────────────────────────────────────────────────────────────

router.get('/blog', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        skip: (page - 1) * limit, take: limit,
        orderBy: { created_at: 'desc' },
      }),
      prisma.blogPost.count(),
    ]);
    ok(res, { posts, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { next(e); }
});

router.post('/blog', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      slug, title, excerpt, content, author_name, author_avatar, cover_image,
      tags, meta_title, meta_description, og_image, is_published, read_time_mins,
    } = req.body;
    if (!slug?.trim())  throw new ValidationError('slug is required');
    if (!title?.trim()) throw new ValidationError('title is required');

    const now  = new Date();
    const post = await prisma.blogPost.create({
      data: {
        slug:             slug.trim(),
        title:            title.trim(),
        excerpt:          excerpt || null,
        content:          content || '',
        author_name:      author_name || 'Attenda Team',
        author_avatar:    author_avatar || null,
        cover_image:      cover_image || null,
        tags:             tags || [],
        meta_title:       meta_title || null,
        meta_description: meta_description || null,
        og_image:         og_image || null,
        is_published:     is_published ?? false,
        published_at:     is_published ? now : null,
        read_time_mins:   read_time_mins || null,
      },
    });
    ok(res, post, 201);
  } catch (e) { next(e); }
});

router.get('/blog/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const post = await prisma.blogPost.findUniqueOrThrow({ where: { id: req.params.id as string } });
    ok(res, post);
  } catch (e) { next(e); }
});

router.put('/blog/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      slug, title, excerpt, content, author_name, author_avatar, cover_image,
      tags, meta_title, meta_description, og_image, is_published, read_time_mins,
    } = req.body;

    const existing = await prisma.blogPost.findUniqueOrThrow({ where: { id: req.params.id as string } });

    const post = await prisma.blogPost.update({
      where: { id: req.params.id as string },
      data: {
        ...(slug             !== undefined && { slug }),
        ...(title            !== undefined && { title }),
        ...(excerpt          !== undefined && { excerpt }),
        ...(content          !== undefined && { content }),
        ...(author_name      !== undefined && { author_name }),
        ...(author_avatar    !== undefined && { author_avatar }),
        ...(cover_image      !== undefined && { cover_image }),
        ...(tags             !== undefined && { tags }),
        ...(meta_title       !== undefined && { meta_title }),
        ...(meta_description !== undefined && { meta_description }),
        ...(og_image         !== undefined && { og_image }),
        ...(read_time_mins   !== undefined && { read_time_mins }),
        ...(is_published     !== undefined && {
          is_published,
          published_at: is_published && !existing.published_at ? new Date() : existing.published_at,
        }),
      },
    });
    ok(res, post);
  } catch (e) { next(e); }
});

router.delete('/blog/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.blogPost.delete({ where: { id: req.params.id as string } });
    ok(res, { message: 'Post deleted' });
  } catch (e) { next(e); }
});

// PATCH /admin/blog/:id/publish — toggle publish status
router.patch('/blog/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.blogPost.findUniqueOrThrow({ where: { id: req.params.id as string } });
    const post = await prisma.blogPost.update({
      where: { id: req.params.id as string },
      data:  {
        is_published: !existing.is_published,
        published_at: !existing.is_published && !existing.published_at ? new Date() : existing.published_at,
      },
    });
    ok(res, post);
  } catch (e) { next(e); }
});

export default router;
