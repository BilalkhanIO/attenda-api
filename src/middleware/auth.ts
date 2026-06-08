import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '../utils/auth';
import { UnauthorizedError, ForbiddenError } from '../utils/response';
import redis from '../utils/redis';
import {
  can,
  hasFeature,
  resolveOrgFeatures,
  resolvePlatformPermissions,
  resolveUserPermissions,
  type PlanFeatures,
} from '../services/authorization';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const ROLE_HIERARCHY: Record<string, number> = {
  employee:       1,
  manager:        2,
  hr_admin:       3,
  super_admin:    4,
  platform_admin: 99,
};

async function isBlacklisted(jti: string): Promise<boolean> {
  try {
    const val = await redis.get(`jti:${jti}`);
    return val !== null;
  } catch {
    // Fail closed — treat Redis error as blacklisted to prevent revoked tokens from being accepted
    return true;
  }
}

// ─── Authenticate ─────────────────────────────────────
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }
    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);

    if (await isBlacklisted(payload.jti)) {
      throw new UnauthorizedError('Token has been revoked');
    }

    req.user = payload;
    next();
  } catch (err: unknown) {
    if (err instanceof UnauthorizedError) return next(err);
    const message = err instanceof Error ? err.message : 'Invalid token';
    next(new UnauthorizedError(message.includes('expired') ? 'Token expired' : 'Invalid token'));
  }
}

// ─── Require role (route-level access control) ────────
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
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
export const requireManager    = requireRole('manager');
export const requireHRAdmin    = requireRole('hr_admin');
export const requireSuperAdmin = requireRole('super_admin');

// ─── Permission gating (dynamic RBAC only) ────────────
export function requirePermission(...permissionKeys: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) return next(new UnauthorizedError());

      if (req.user.role === 'platform_admin') {
        const platformPerms = await resolvePlatformPermissions(req.user.sub);
        if (permissionKeys.some(k => can(platformPerms, k))) return next();
        return next(new ForbiddenError());
      }

      const perms = await resolveUserPermissions(req.user.sub, req.user.org_id);
      if (permissionKeys.some(k => can(perms, k))) return next();

      return next(new ForbiddenError());
    } catch (e) {
      next(e);
    }
  };
}

// ─── Org plan feature gating ──────────────────────────
export function requireOrgFeature(...featureKeys: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) return next(new UnauthorizedError());
      if (req.user.role === 'platform_admin') return next(new ForbiddenError());

      const features: PlanFeatures = await resolveOrgFeatures(req.user.org_id);
      if (featureKeys.every(k => hasFeature(features, k))) return next();
      return next(new ForbiddenError('Feature not available on your plan'));
    } catch (e) {
      next(e);
    }
  };
}

// ─── Org scoping helper ───────────────────────────────
export function sameOrg(req: Request, orgId: string): boolean {
  return req.user?.org_id === orgId;
}

// ─── Optional auth (blacklist-aware) ─────────────────
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = verifyAccessToken(token);
      // Fail open for blacklist — if Redis is down, let the request through as unauthenticated
      try {
        const blacklisted = await redis.get(`jti:${payload.jti}`);
        if (!blacklisted) {
          req.user = payload;
        }
      } catch {
        req.user = payload;
      }
    }
  } catch { /* ignore — treat as unauthenticated */ }
  next();
}
