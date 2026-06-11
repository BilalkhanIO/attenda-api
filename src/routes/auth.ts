import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  loginSchema, registerSchema, refreshSchema, forgotPasswordSchema,
  resetPasswordSchema, setupAccountSchema, changePasswordSchema,
  totpVerifySchema, totpAuthenticateSchema,
} from '../schemas';
import {
  hashPassword, comparePassword, signAccessToken, signRefreshToken,
  verifyRefreshToken, generateToken
} from '../utils/auth';
import { ok, AppError, UnauthorizedError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import redis from '../utils/redis';
import { generateSecret, verifySync, generateURI } from 'otplib';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function isValidIanaTz(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch { return false; }
}

function validatePasswordStrength(password: string): void {
  if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');
  if (!/[A-Z]/.test(password)) throw new ValidationError('Password must contain at least one uppercase letter');
  if (!/[0-9]/.test(password)) throw new ValidationError('Password must contain at least one number');
  if (!/[^A-Za-z0-9]/.test(password)) throw new ValidationError('Password must contain at least one special character');
}

async function blacklistToken(jti: string, expUnix: number): Promise<void> {
  const ttl = expUnix - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    try {
      await redis.setex(`jti:${jti}`, ttl, '1');
    } catch (e) {
      console.error('[Auth] Failed to blacklist token:', e);
    }
  }
}

// ─── POST /auth/register ───────────────────────────────
router.post('/register', validate({ body: registerSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { org_name, timezone, currency, name, email, password } = req.body;
    if (!org_name || !name || !email || !password) throw new ValidationError('Missing required fields');
    validatePasswordStrength(password);
    if (timezone && !isValidIanaTz(timezone)) throw new ValidationError('Invalid timezone — must be a valid IANA timezone (e.g. Asia/Karachi)');

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

    // Seed org RBAC and assign super_admin role
    const { seedOrgRbacForOrganisation } = await import('../utils/rbac-seed');
    await seedOrgRbacForOrganisation(org.id);

    const orgRole = await prisma.orgRole.findUnique({
      where: { org_id_slug: { org_id: org.id, slug: 'super_admin' } },
    });
    if (orgRole) {
      await prisma.userOrgRole.upsert({
        where: { user_id: user.id },
        update: { org_role_id: orgRole.id },
        create: { user_id: user.id, org_role_id: orgRole.id },
      });
    }

    // WhatsApp invite if org has it enabled and user has a phone
    if (org.wa_enabled && user.phone) {
      try {
        const { notify } = await import('../services/whatsapp');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        await notify({
          orgId: org.id,
          event: 'invite',
          message: `Welcome to ${org.name}! Set up your Attenda account: ${frontendUrl}`,
          recipientType: 'individual',
          recipientId: user.phone,
        });
      } catch { /* silent */ }
    }

    const accessToken  = signAccessToken({ sub: user.id, org_id: org.id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);

    ok(res, { access_token: accessToken, refresh_token: refreshToken, user: { id: user.id, name, email, role: user.role, org_id: org.id } }, 201);
  } catch (e) { next(e); }
});

// ─── POST /auth/login ──────────────────────────────────
router.post('/login', validate({ body: loginSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new ValidationError('Email and password required');

    const user = await prisma.user.findUnique({ where: { email }, include: { org: true } });
    if (!user || !user.is_active) throw new UnauthorizedError('Invalid email or password');

    // Check lockout BEFORE password validation
    const isCurrentlyLocked = user.locked_until && user.locked_until > new Date();
    if (isCurrentlyLocked) {
      // Still increment attempts while locked (for escalation tracking)
      const attempts = user.login_attempts + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: { login_attempts: attempts },
      });
      throw new AppError('Account locked. Try again later.', 423, 'ACCOUNT_LOCKED');
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      const attempts = user.login_attempts + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : user.locked_until;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          login_attempts: attempts,
          locked_until: lockUntil,
        },
      });

      // At exactly 5 attempts: lock + notify org super_admins
      if (attempts === 5) {
        const { createNotification } = await import('../services/notifications');
        const { sendAccountLockedEmail } = await import('../services/email');

        const superAdmins = await prisma.userOrgRole.findMany({
          where: { org_role: { org_id: user.org_id, slug: 'super_admin' } },
          include: { user: { select: { id: true, email: true, name: true } } },
        });

        for (const sa of superAdmins) {
          if (sa.user.id === user.id) continue;
          createNotification({
            userId: sa.user.id, orgId: user.org_id,
            type: 'account_locked',
            title: 'Account locked',
            body: `${user.name} (${user.email}) has been locked out after 5 failed login attempts.`,
            actionType: 'user', actionId: user.id,
          }).catch(console.error);
          sendAccountLockedEmail(sa.user.email, sa.user.name, user.email, 5).catch(console.error);
        }

        throw new AppError('Account locked for 30 minutes due to failed attempts', 423, 'ACCOUNT_LOCKED');
      }

      // At exactly 10 attempts: additionally notify platform_admins
      if (attempts === 10) {
        const { createNotification } = await import('../services/notifications');
        const { sendAccountLockedEmail } = await import('../services/email');

        const platformAdmins = await prisma.platformUserRole.findMany({
          where: { platform_role_slug: 'platform_admin' },
          include: { user: { select: { id: true, email: true, name: true } } },
        });

        for (const pa of platformAdmins) {
          createNotification({
            userId: pa.user.id, orgId: user.org_id,
            type: 'account_locked',
            title: 'Account locked (escalation)',
            body: `${user.name} (${user.email}) has reached 10 failed login attempts.`,
            actionType: 'user', actionId: user.id,
          }).catch(console.error);
          sendAccountLockedEmail(pa.user.email, pa.user.name, user.email, 10).catch(console.error);
        }
      }

      throw new UnauthorizedError('Invalid email or password');
    }

    // Org-wide 2FA enforcement check (before issuing any token)
    if (user.org.totp_required && !user.totp_enabled) {
      return next(new AppError(
        'Your organisation requires 2FA. Please set up an authenticator app before logging in.',
        403,
        'totp_setup_required',
      ));
    }

    // 2FA challenge — issue a short-lived partial token (do NOT reset attempts yet)
    if (user.totp_enabled && user.totp_secret) {
      const partial = jwt.sign(
        { sub: user.id, pending_2fa: true },
        JWT_SECRET,
        { expiresIn: '5m' },
      );
      ok(res, { requires_2fa: true, partial_token: partial });
      return;
    }

    // Full success — reset attempts
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
    const exp = (req.user as unknown as { exp: number }).exp;
    await blacklistToken(jti, exp as unknown as number);
    ok(res, { message: 'Logged out successfully' });
  } catch (e) { next(e); }
});

// ─── POST /auth/refresh ────────────────────────────────
router.post('/refresh', validate({ body: refreshSchema }), async (req: Request, res: Response, next: NextFunction) => {
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
router.post('/forgot-password', validate({ body: forgotPasswordSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    if (!email) throw new ValidationError('Email required');

    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.is_active) {
      const token   = generateToken();
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      await prisma.user.update({ where: { id: user.id }, data: { reset_token: token, reset_expires: expires } });
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const resetLink   = `${frontendUrl}/reset-password?token=${token}`;
      const { sendPasswordResetEmail } = await import('../services/email');
      await sendPasswordResetEmail(email, user.name, resetLink).catch(console.error);
    }
    ok(res, { message: 'If that email exists, a reset link has been sent' });
  } catch (e) { next(e); }
});

// ─── POST /auth/reset-password ─────────────────────────
router.post('/reset-password', validate({ body: resetPasswordSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) throw new ValidationError('Token and password required');
    validatePasswordStrength(password);

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
router.post('/setup-account', validate({ body: setupAccountSchema }), async (req: Request, res: Response, next: NextFunction) => {
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

// ─── PUT /auth/change-password ─────────────────────────
router.put('/change-password', authenticate, validate({ body: changePasswordSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) throw new ValidationError('current_password and new_password required');
    validatePasswordStrength(new_password);

    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

    const valid = await comparePassword(current_password, user.password_hash);
    if (!valid) throw new UnauthorizedError('Current password is incorrect');

    if (current_password === new_password) throw new ValidationError('New password must be different from current password');

    const hash = await hashPassword(new_password);
    await prisma.user.update({ where: { id: user.id }, data: { password_hash: hash } });

    // Invalidate current session
    const jti = req.user!.jti;
    const exp = (req.user as unknown as { exp: number }).exp;
    await blacklistToken(jti, exp);

    ok(res, { message: 'Password changed successfully' });
  } catch (e) { next(e); }
});

// ─── POST /auth/2fa/authenticate ───────────────────────
router.post('/2fa/authenticate', validate({ body: totpAuthenticateSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { partial_token, code } = req.body;
    if (!partial_token || !code) throw new ValidationError('partial_token and code required');

    let payload: any;
    try {
      payload = jwt.verify(partial_token, JWT_SECRET);
    } catch {
      throw new AppError('Invalid or expired partial token', 401, 'INVALID_TOKEN');
    }
    if (!payload.pending_2fa) throw new AppError('Not a 2FA partial token', 400, 'BAD_REQUEST');

    // Brute-force protection on 2FA codes
    const attemptsKey = `2fa_attempts:${partial_token}`;
    let attemptCount = 0;
    try {
      const raw = await redis.get(attemptsKey);
      attemptCount = raw ? parseInt(raw, 10) : 0;
    } catch { /* Redis down — continue */ }

    if (attemptCount >= 5) {
      throw new AppError('Too many failed 2FA attempts. Please log in again.', 429, 'TOO_MANY_ATTEMPTS');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.totp_secret) throw new AppError('User not found', 404, 'NOT_FOUND');

    const result = verifySync({ secret: user.totp_secret, token: String(code) });
    if (!result.valid) {
      // Increment attempt counter
      try {
        const newCount = await redis.incr(attemptsKey);
        if (newCount === 1) await redis.expire(attemptsKey, 600); // 10 min TTL on first attempt
        if (newCount >= 5) {
          throw new AppError('Too many failed 2FA attempts. Please log in again.', 429, 'TOO_MANY_ATTEMPTS');
        }
      } catch (redisErr: any) {
        if (redisErr instanceof AppError) throw redisErr;
        /* Redis down — allow retry */
      }
      throw new UnauthorizedError('Invalid 2FA code');
    }

    // Success — clear attempt counter and reset login_attempts
    try { await redis.del(attemptsKey); } catch { /* ignore */ }
    await prisma.user.update({ where: { id: user.id }, data: { login_attempts: 0, locked_until: null } });

    const accessToken  = signAccessToken({ sub: user.id, org_id: user.org_id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);
    ok(res, {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, org_id: user.org_id },
    });
  } catch (e) { next(e); }
});

// ─── POST /auth/2fa/setup ──────────────────────────────
router.post('/2fa/setup', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');
    if (user.totp_enabled) throw new AppError('2FA is already enabled', 400, 'ALREADY_ENABLED');

    const secret = generateSecret({ length: 20 });
    await prisma.user.update({ where: { id: user.id }, data: { totp_secret: secret } });

    const uri = generateURI({ issuer: 'Attenda', label: user.email, secret });
    const { toDataURL } = await import('qrcode');
    const qr = await toDataURL(uri);
    ok(res, { secret, uri, qr_code: qr });
  } catch (e) { next(e); }
});

// ─── POST /auth/2fa/verify ─────────────────────────────
router.post('/2fa/verify', authenticate, validate({ body: totpVerifySchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (!code) throw new ValidationError('code required');

    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user || !user.totp_secret) throw new AppError('Run /auth/2fa/setup first', 400, 'SETUP_REQUIRED');
    if (user.totp_enabled) throw new AppError('2FA already enabled', 400, 'ALREADY_ENABLED');

    const result = verifySync({ secret: user.totp_secret, token: String(code) });
    if (!result.valid) throw new ValidationError('Invalid TOTP code');

    await prisma.user.update({ where: { id: user.id }, data: { totp_enabled: true } });
    ok(res, { message: '2FA enabled successfully' });
  } catch (e) { next(e); }
});

// ─── DELETE /auth/2fa (disable 2FA — requires TOTP code) ─
router.delete('/2fa', authenticate, validate({ body: totpVerifySchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body as { code: string };
    if (!code) throw new AppError('Verification code required', 400, 'VALIDATION_ERROR');
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { totp_secret: true, totp_enabled: true } });
    if (!user || !user.totp_enabled) throw new AppError('2FA is not enabled', 400, 'NOT_ENABLED');
    const result = verifySync({ secret: user.totp_secret!, token: String(code) });
    if (!result.valid) throw new AppError('Invalid verification code', 400, 'INVALID_CODE');
    await prisma.user.update({ where: { id: req.user!.sub }, data: { totp_enabled: false, totp_secret: null } });
    ok(res, { message: '2FA disabled' });
  } catch (e) { next(e); }
});

// ─── GET /auth/sso/google ──────────────────────────────
router.get('/sso/google', (_req: Request, res: Response) => {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/v1/auth/sso/google/callback`;
  if (!clientId) {
    res.status(503).json({ error: 'Google SSO not configured' });
    return;
  }
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ─── GET /auth/sso/google/callback ────────────────────
router.get('/sso/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query as { code?: string };
    if (!code) throw new ValidationError('Missing OAuth2 code');

    const clientId     = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/v1/auth/sso/google/callback`;

    if (!clientId || !clientSecret) throw new AppError('Google SSO not configured', 503, 'SSO_NOT_CONFIGURED');

    const axios = (await import('axios')).default;

    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    });

    const profileRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });
    const { sub: googleId, email, picture } = profileRes.data as { sub: string; email: string; name: string; picture?: string };

    let user = await prisma.user.findFirst({ where: { OR: [{ google_id: googleId }, { email }] } });
    if (!user) throw new AppError('No account linked to this Google account. Contact your admin.', 404, 'USER_NOT_FOUND');

    if (!user.google_id) {
      user = await prisma.user.update({ where: { id: user.id }, data: { google_id: googleId, avatar_url: picture ?? user.avatar_url } });
    }
    if (!user.is_active) throw new AppError('Account is deactivated', 403, 'ACCOUNT_INACTIVE');

    const accessToken  = signAccessToken({ sub: user.id, org_id: user.org_id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);

    // Store tokens in Redis with a 60-second one-time code
    const onetimeCode = crypto.randomBytes(32).toString('hex');
    try {
      await redis.setex(`sso:${onetimeCode}`, 60, JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }));
    } catch (e) {
      console.error('[SSO] Redis unavailable — falling back to query-string redirect:', e);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/sso/callback?access_token=${accessToken}&refresh_token=${refreshToken}`);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/sso/callback?code=${onetimeCode}`);
  } catch (e) { next(e); }
});

// ─── POST /auth/sso/exchange ──────────────────────────
// Exchange one-time SSO code for access + refresh tokens
router.post('/sso/exchange', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) throw new ValidationError('code is required');

    let tokens: { access_token: string; refresh_token: string } | null = null;
    try {
      const raw = await redis.get(`sso:${code}`);
      if (raw) {
        tokens = JSON.parse(raw);
        await redis.del(`sso:${code}`);
      }
    } catch (e) {
      console.error('[SSO] Redis error during exchange:', e);
      throw new AppError('SSO exchange failed — please try again', 503, 'SERVICE_ERROR');
    }

    if (!tokens) {
      throw new AppError('Invalid or expired SSO code', 400, 'INVALID_CODE');
    }

    ok(res, tokens);
  } catch (e) { next(e); }
});

export default router;
