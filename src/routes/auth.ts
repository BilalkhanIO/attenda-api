import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import {
  hashPassword, comparePassword, signAccessToken, signRefreshToken,
  verifyRefreshToken, generateToken
} from '../utils/auth';
import { ok, created, AppError, UnauthorizedError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();

// ─── POST /auth/register ───────────────────────────────
// Register new organisation + Super Admin
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { org_name, timezone, currency, name, email, password } = req.body;
    if (!org_name || !name || !email || !password) throw new ValidationError('Missing required fields');
    if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError('Email already registered', 409, 'CONFLICT');

    const org = await prisma.organisation.create({
      data: { name: org_name, timezone: timezone || 'UTC', currency: currency || 'USD' },
    });

    const hash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        org_id: org.id, name, email, password_hash: hash,
        role: 'super_admin', setup_complete: true,
      },
    });

    const accessToken  = signAccessToken({ sub: user.id, org_id: org.id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);

    ok(res, { access_token: accessToken, refresh_token: refreshToken, user: { id: user.id, name, email, role: user.role, org_id: org.id } }, 201);
  } catch (e) { next(e); }
});

// ─── POST /auth/login ──────────────────────────────────
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new ValidationError('Email and password required');

    const user = await prisma.user.findUnique({ where: { email }, include: { org: true } });
    if (!user || !user.is_active) throw new UnauthorizedError('Invalid email or password');

    // Check lockout
    if (user.locked_until && user.locked_until > new Date()) {
      throw new AppError('Account locked. Try again later.', 423, 'ACCOUNT_LOCKED');
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      const attempts = user.login_attempts + 1;
      const locked   = attempts >= 5;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          login_attempts: attempts,
          locked_until: locked ? new Date(Date.now() + 30 * 60 * 1000) : null,
        },
      });
      if (locked) throw new AppError('Account locked for 30 minutes due to failed attempts', 423, 'ACCOUNT_LOCKED');
      throw new UnauthorizedError('Invalid email or password');
    }

    // Reset attempts on success
    await prisma.user.update({ where: { id: user.id }, data: { login_attempts: 0, locked_until: null } });

    const accessToken  = signAccessToken({ sub: user.id, org_id: user.org_id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);

    ok(res, {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, org_id: user.org_id, setup_complete: user.setup_complete },
    });
  } catch (e) { next(e); }
});

// ─── POST /auth/logout ─────────────────────────────────
router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jti = req.user!.jti;
    const exp = new Date((req.user as unknown as { exp: number }).exp * 1000);
    await prisma.tokenBlacklist.upsert({
      where: { jti },
      update: {},
      create: { jti, expires_at: exp },
    });
    ok(res, { message: 'Logged out successfully' });
  } catch (e) { next(e); }
});

// ─── POST /auth/refresh ────────────────────────────────
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) throw new ValidationError('Refresh token required');

    const payload = verifyRefreshToken(refresh_token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.is_active) throw new UnauthorizedError('User not found');

    const accessToken = signAccessToken({ sub: user.id, org_id: user.org_id, role: user.role, name: user.name, email: user.email });
    ok(res, { access_token: accessToken });
  } catch (e) { next(e); }
});

// ─── POST /auth/forgot-password ────────────────────────
router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    if (!email) throw new ValidationError('Email required');

    const user = await prisma.user.findUnique({ where: { email } });
    // Always return 200 to prevent email enumeration
    if (user) {
      const token   = generateToken();
      const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min
      await prisma.user.update({ where: { id: user.id }, data: { reset_token: token, reset_expires: expires } });
      // TODO: Send email with reset link: ${process.env.FRONTEND_URL}/reset-password?token=${token}
      console.log(`[AUTH] Password reset link for ${email}: /reset-password?token=${token}`);
    }
    ok(res, { message: 'If that email exists, a reset link has been sent' });
  } catch (e) { next(e); }
});

// ─── POST /auth/reset-password ─────────────────────────
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) throw new ValidationError('Token and password required');
    if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');

    const user = await prisma.user.findFirst({
      where: { reset_token: token, reset_expires: { gt: new Date() } },
    });
    if (!user) throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');

    const hash = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: { password_hash: hash, reset_token: null, reset_expires: null, login_attempts: 0 },
    });
    ok(res, { message: 'Password reset successfully' });
  } catch (e) { next(e); }
});

// ─── POST /auth/setup-account ──────────────────────────
// First-time password setup via invite link
router.post('/setup-account', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) throw new ValidationError('Token and password required');

    const user = await prisma.user.findFirst({
      where: { invite_token: token, invite_expires: { gt: new Date() } },
    });
    if (!user) throw new AppError('Invalid or expired invite link', 400, 'INVALID_TOKEN');

    const hash = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: { password_hash: hash, invite_token: null, invite_expires: null, setup_complete: true },
    });

    const accessToken  = signAccessToken({ sub: user.id, org_id: user.org_id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);
    ok(res, { access_token: accessToken, refresh_token: refreshToken });
  } catch (e) { next(e); }
});

export default router;
