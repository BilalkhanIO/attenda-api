// Public routes — no authentication required
import { Router, Request, Response, NextFunction } from 'express';
import { ok, ValidationError, AppError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();

const VALID_SIZES = ['1-10', '11-50', '51-200', '201-500', '500+'];

// ─── POST /public/onboard ─────────────────────────────────────────────────────
router.post('/onboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { company_name, contact_name, contact_email, phone, timezone, company_size } = req.body;

    if (!company_name?.trim())  throw new ValidationError('Company name is required');
    if (!contact_name?.trim())  throw new ValidationError('Your name is required');
    if (!contact_email?.trim()) throw new ValidationError('Work email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) throw new ValidationError('Invalid email address');
    if (company_size && !VALID_SIZES.includes(company_size)) throw new ValidationError('Invalid company size');

    const existing = await prisma.organisation.findFirst({
      where: { contact_email: contact_email.toLowerCase().trim(), status: { in: ['pending', 'active'] } },
    });
    if (existing) {
      throw new AppError('An application with this email already exists. Check your inbox or contact support.', 409, 'DUPLICATE_APPLICATION');
    }

    await prisma.organisation.create({
      data: {
        name:          company_name.trim(),
        timezone:      timezone?.trim() || 'UTC',
        status:        'pending',
        contact_name:  contact_name.trim(),
        contact_email: contact_email.toLowerCase().trim(),
        company_size:  company_size || null,
      },
    });

    ok(res, { message: "Application received! We'll review it and email you within 24 hours." }, 201);
  } catch (e) { next(e); }
});

// ─── GET /public/plans ────────────────────────────────────────────────────────
router.get('/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await prisma.planDefinition.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
    });
    ok(res, plans);
  } catch (e) { next(e); }
});

// ─── GET /public/blog ─────────────────────────────────────────────────────────
router.get('/blog', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(20, Number(req.query.limit) || 10);
    const tag   = (req.query.tag as string) || undefined;

    const where: any = { is_published: true };
    if (tag) where.tags = { has: tag };

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        skip:    (page - 1) * limit,
        take:    limit,
        orderBy: { published_at: 'desc' },
        select: {
          id: true, slug: true, title: true, excerpt: true,
          cover_image: true, author_name: true, author_avatar: true,
          tags: true, published_at: true, read_time_mins: true, views: true,
          meta_title: true, meta_description: true,
        },
      }),
      prisma.blogPost.count({ where }),
    ]);
    ok(res, { posts, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { next(e); }
});

// ─── GET /public/blog/:slug ───────────────────────────────────────────────────
router.get('/blog/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const post = await prisma.blogPost.findFirst({
      where: { slug: req.params.slug as string, is_published: true },
    });
    if (!post) return res.status(404).json({ success: false, error: 'Post not found' });

    // Increment views (fire-and-forget)
    prisma.blogPost.update({ where: { id: post.id }, data: { views: { increment: 1 } } }).catch(() => {});

    ok(res, post);
  } catch (e) { next(e); }
});

export default router;
