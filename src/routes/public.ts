// Public routes — no authentication required
import { Router, Request, Response, NextFunction } from 'express';
import { ok, ValidationError, AppError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();

const VALID_SIZES = ['1-10', '11-50', '51-200', '201-500', '500+'];

// ─── POST /public/onboard ─────────────────────────────
// Submit an organisation onboarding application.
// Creates an org with status='pending' — visible to platform_admin for approval.
router.post('/onboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { company_name, contact_name, contact_email, phone, timezone, company_size } = req.body;

    if (!company_name?.trim()) throw new ValidationError('Company name is required');
    if (!contact_name?.trim()) throw new ValidationError('Your name is required');
    if (!contact_email?.trim()) throw new ValidationError('Work email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) throw new ValidationError('Invalid email address');
    if (company_size && !VALID_SIZES.includes(company_size)) throw new ValidationError('Invalid company size');

    // Prevent duplicate applications from the same email
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

    ok(res, {
      message: "Application received! We'll review it and email you within 24 hours.",
    }, 201);
  } catch (e) { next(e); }
});

export default router;
