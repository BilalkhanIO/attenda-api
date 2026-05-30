import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { authenticate } from '../middleware/auth';
import { ok } from '../utils/response';
import { ForbiddenError } from '../utils/response';

const router = Router();

// Only platform_admin can access these routes
router.use(authenticate, (req: Request, res: Response, next: NextFunction) => {
  if (req.user!.role !== 'platform_admin') throw new ForbiddenError();
  next();
});

// GET /admin/stats — global platform stats
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [orgCount, userCount, activeToday] = await Promise.all([
      prisma.organisation.count(),
      prisma.user.count({ where: { deleted_at: null } }),
      prisma.attendanceRecord.count({
        where: { date: new Date(new Date().setHours(0,0,0,0)) },
      }),
    ]);
    ok(res, { org_count: orgCount, user_count: userCount, active_today: activeToday });
  } catch (e) { next(e); }
});

// GET /admin/orgs — list all organisations with summary
router.get('/orgs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orgs = await prisma.organisation.findMany({
      orderBy: { created_at: 'desc' },
      include: {
        _count: {
          select: { users: { where: { deleted_at: null, is_active: true } } },
        },
      },
    });

    const result = orgs.map(org => {
      // Derive onboarding status from plan and config
      const hasLogo    = !!org.logo_url;
      const hasIPs     = org.office_ips.length > 0;
      const onboarding = {
        profile_set:   hasLogo,
        ips_set:       hasIPs,
        wa_enabled:    org.wa_enabled,
      };
      const score = Object.values(onboarding).filter(Boolean).length;
      return {
        id:           org.id,
        name:         org.name,
        plan:         org.plan,
        timezone:     org.timezone,
        created_at:   org.created_at,
        user_count:   org._count.users,
        onboarding,
        onboarding_score: score, // 0-3
      };
    });

    ok(res, result);
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
    if (!['trial', 'starter', 'growth', 'enterprise'].includes(plan)) {
      return res.status(422).json({ success: false, error: 'Invalid plan' });
    }
    const org = await prisma.organisation.update({
      where: { id: req.params.id as string },
      data: { plan },
    });
    ok(res, org);
  } catch (e) { next(e); }
});

export default router;
