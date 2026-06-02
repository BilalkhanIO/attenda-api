import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import {
  hashPassword, comparePassword, signAccessToken, signRefreshToken,
  verifyRefreshToken, generateToken
} from '../utils/auth';
import { ok, created, AppError, UnauthorizedError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import { generateSecret, generateSync, verifySync, generateURI } from 'otplib';
import jwt from 'jsonwebtoken';

const router = Router();

function validatePasswordStrength(password: string): void {
  if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');
  if (!/[A-Z]/.test(password)) throw new ValidationError('Password must contain at least one uppercase letter');
  if (!/[0-9]/.test(password)) throw new ValidationError('Password must contain at least one number');
  if (!/[^A-Za-z0-9]/.test(password)) throw new ValidationError('Password must contain at least one special character');
}

// ─── POST /auth/register ───────────────────────────────
// Register new organisation + Super Admin
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { org_name, timezone, currency, name, email, password } = req.body;
    if (!org_name || !name || !email || !password) throw new ValidationError('Missing required fields');
    validatePasswordStrength(password);

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

    // 2FA challenge — issue a short-lived partial token
    if (user.totp_enabled && user.totp_secret) {
      const partial = jwt.sign(
        { sub: user.id, pending_2fa: true },
        process.env.JWT_ACCESS_SECRET || 'secret',
        { expiresIn: '5m' },
      );
      ok(res, { requires_2fa: true, partial_token: partial });
      return;
    }

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
    if (user && user.is_active) {
      const token   = generateToken();
      const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min
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
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
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

// ─── PUT /auth/change-password ─────────────────────────
router.put('/change-password', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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
    ok(res, { message: 'Password changed successfully' });
  } catch (e) { next(e); }
});

// ─── POST /auth/2fa/authenticate ───────────────────────
// Complete login when 2FA is enabled — exchange partial_token + TOTP code for real tokens
router.post('/2fa/authenticate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { partial_token, code } = req.body;
    if (!partial_token || !code) throw new ValidationError('partial_token and code required');

    let payload: any;
    try {
      payload = jwt.verify(partial_token, process.env.JWT_ACCESS_SECRET || 'secret');
    } catch {
      throw new AppError('Invalid or expired partial token', 401, 'INVALID_TOKEN');
    }
    if (!payload.pending_2fa) throw new AppError('Not a 2FA partial token', 400, 'BAD_REQUEST');

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.totp_secret) throw new AppError('User not found', 404, 'NOT_FOUND');

    const result = verifySync({ secret: user.totp_secret, token: String(code) });
    if (!result.valid) throw new UnauthorizedError('Invalid 2FA code');

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
// Generate TOTP secret + QR URI for the authenticated user
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
// Confirm TOTP code and activate 2FA
router.post('/2fa/verify', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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

// ─── DELETE /auth/2fa (disable 2FA) ────────────────────
router.delete('/2fa', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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

// ─── DELETE /auth/2fa/disable ─────────────────────────
// Disable 2FA (requires password confirmation)
router.delete('/2fa/disable', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body;
    if (!password) throw new ValidationError('password required to disable 2FA');

    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');
    if (!user.totp_enabled) throw new AppError('2FA is not enabled', 400, 'NOT_ENABLED');

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) throw new UnauthorizedError('Incorrect password');

    await prisma.user.update({ where: { id: user.id }, data: { totp_enabled: false, totp_secret: null } });
    ok(res, { message: '2FA disabled' });
  } catch (e) { next(e); }
});

// ─── GET /auth/sso/google ──────────────────────────────
// Redirect to Google OAuth2 consent screen
router.get('/sso/google', (req: Request, res: Response) => {
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
// Exchange code for profile, upsert user, return tokens
router.get('/sso/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query as { code?: string };
    if (!code) throw new ValidationError('Missing OAuth2 code');

    const clientId     = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/v1/auth/sso/google/callback`;

    if (!clientId || !clientSecret) throw new AppError('Google SSO not configured', 503, 'SSO_NOT_CONFIGURED');

    const axios = (await import('axios')).default;

    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    });

    // Get user profile from Google
    const profileRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });
    const { sub: googleId, email, name, picture } = profileRes.data as { sub: string; email: string; name: string; picture?: string };

    let user = await prisma.user.findFirst({ where: { OR: [{ google_id: googleId }, { email }] } });
    if (!user) throw new AppError('No account linked to this Google account. Contact your admin.', 404, 'USER_NOT_FOUND');

    if (!user.google_id) {
      user = await prisma.user.update({ where: { id: user.id }, data: { google_id: googleId, avatar_url: picture ?? user.avatar_url } });
    }
    if (!user.is_active) throw new AppError('Account is deactivated', 403, 'ACCOUNT_INACTIVE');

    const accessToken  = signAccessToken({ sub: user.id, org_id: user.org_id, role: user.role, name: user.name, email: user.email });
    const refreshToken = signRefreshToken(user.id);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/sso/callback?access_token=${accessToken}&refresh_token=${refreshToken}`);
  } catch (e) { next(e); }
});

export default router;
