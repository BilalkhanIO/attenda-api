import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '../utils/auth';
import { UnauthorizedError, ForbiddenError } from '../utils/response';
import prisma from '../utils/prisma';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const ROLE_HIERARCHY: Record<string, number> = {
  employee:      1,
  manager:       2,
  hr_admin:      3,
  super_admin:   4,
  platform_admin: 99,
};

// ─── Authenticate ─────────────────────────────────────
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }
    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);

    // Check token not blacklisted
    const blacklisted = await prisma.tokenBlacklist.findUnique({ where: { jti: payload.jti } });
    if (blacklisted) throw new UnauthorizedError('Token has been revoked');

    req.user = payload;
    next();
  } catch (err: unknown) {
    if (err instanceof UnauthorizedError) return next(err);
    // JWT errors
    const message = err instanceof Error ? err.message : 'Invalid token';
    next(new UnauthorizedError(message.includes('expired') ? 'Token expired' : 'Invalid token'));
  }
}

// ─── Require role ─────────────────────────────────────
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    // platform_admin is a cross-tenant role; it must not pass org-scoped route
    // guards automatically. Admin routes enforce their own explicit check.
    if (req.user.role === 'platform_admin' && !roles.includes('platform_admin')) {
      return next(new ForbiddenError());
    }
    const userLevel = ROLE_HIERARCHY[req.user.role] || 0;
    const hasAccess = roles.some(r => {
      return req.user!.role === r || userLevel >= ROLE_HIERARCHY[r];
    });
    if (!hasAccess) return next(new ForbiddenError());
    next();
  };
}

// ─── At least manager ─────────────────────────────────
export const requireManager   = requireRole('manager');
export const requireHRAdmin   = requireRole('hr_admin');
export const requireSuperAdmin = requireRole('super_admin');

// ─── Org scoping helper ───────────────────────────────
export function sameOrg(req: Request, orgId: string): boolean {
  return req.user?.org_id === orgId;
}

// ─── Optional auth (for public endpoints that can be enriched) ─
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      req.user = verifyAccessToken(token);
    }
  } catch { /* ignore */ }
  next();
}
