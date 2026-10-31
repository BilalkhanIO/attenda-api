import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../utils/prisma';
import { UnauthorizedError } from '../utils/response';
import { logger } from '../utils/logger';
import redis from '../utils/redis';

const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'dev-secret';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionMetadata {
  device_name?: string;
  user_agent?: string;
  ip_address?: string;
}

function expiresIn(): string {
  return process.env.JWT_REFRESH_EXPIRES_IN || '30d';
}

/**
 * Rotating refresh tokens with family-based reuse detection (OWASP/RFC 9700):
 * every refresh invalidates the presented token and issues a successor in the
 * same family. Presenting an already-used token means it leaked (or a client
 * replayed) — the whole family is revoked, forcing a fresh login.
 */
export async function issueRefreshToken(userId: string, familyId?: string, metadata: SessionMetadata = {}): Promise<string> {
  const jti = uuidv4();
  const family = familyId ?? uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  const existingSession = await prisma.userSession.findUnique({ where: { id: family }, select: { id: true, last_seen_at: true } });
  if (!existingSession) {
    await prisma.userSession.create({ data: { id: family, user_id: userId, ...metadata, created_at: now, last_seen_at: now, expires_at: expiresAt } });
  } else {
    // Refresh may run every few minutes. Throttle writes while keeping session
    // activity reasonably current in the device/session management screen.
    await prisma.userSession.updateMany({
      where: { id: family, user_id: userId, revoked_at: null },
      data: { ...metadata, expires_at: expiresAt },
    });
    await prisma.userSession.updateMany({
      where: { id: family, user_id: userId, revoked_at: null, last_seen_at: { lt: new Date(now.getTime() - 5 * 60_000) } },
      data: { last_seen_at: now },
    });
  }
  await prisma.refreshToken.create({
    data: {
      id: jti,
      user_id: userId,
      family_id: family,
      expires_at: expiresAt,
    },
  });
  return jwt.sign({ sub: userId, jti, fam: family }, JWT_REFRESH_SECRET, {
    expiresIn: expiresIn() as jwt.SignOptions['expiresIn'],
  });
}

export async function revokeFamily(familyId: string): Promise<void> {
  const now = new Date();
  const session = await prisma.userSession.findUnique({ where: { id: familyId }, select: { expires_at: true } });
  await prisma.$transaction([
    prisma.refreshToken.updateMany({ where: { family_id: familyId, revoked_at: null }, data: { revoked_at: now } }),
    prisma.userSession.updateMany({ where: { id: familyId, revoked_at: null }, data: { revoked_at: now } }),
  ]);
  if (session) await redis.setex(`sid:${familyId}`, Math.max(1, Math.ceil((session.expires_at.getTime() - now.getTime()) / 1000)), '1');
}

export async function revokeAllForUser(userId: string): Promise<void> {
  const sessions = await prisma.userSession.findMany({ where: { user_id: userId, revoked_at: null }, select: { id: true } });
  const now = new Date();
  await prisma.$transaction([
    prisma.userSession.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: now } }),
    prisma.refreshToken.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: now } }),
  ]);
  await Promise.all(sessions.map(session => redis.setex(`sid:${session.id}`, 30 * 24 * 60 * 60, '1')));
}

/** Revoke every device except the session performing a sensitive change. */
export async function revokeOtherSessionsForUser(userId: string, keepSessionId?: string): Promise<void> {
  const sessions = await prisma.userSession.findMany({
    where: { user_id: userId, revoked_at: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    select: { id: true },
  });
  if (!sessions.length) return;
  const now = new Date();
  const ids = sessions.map(session => session.id);
  await prisma.$transaction([
    prisma.userSession.updateMany({ where: { id: { in: ids }, user_id: userId, revoked_at: null }, data: { revoked_at: now } }),
    prisma.refreshToken.updateMany({ where: { family_id: { in: ids }, revoked_at: null }, data: { revoked_at: now } }),
  ]);
  await Promise.all(sessions.map(session => redis.setex(`sid:${session.id}`, 30 * 24 * 60 * 60, '1')));
}

export async function revokeSession(userId: string, familyId: string): Promise<boolean> {
  const session = await prisma.userSession.findFirst({ where: { id: familyId, user_id: userId, revoked_at: null } });
  if (!session) return false;
  const now = new Date();
  const ttl = Math.max(1, Math.ceil((session.expires_at.getTime() - now.getTime()) / 1000));
  await prisma.$transaction([
    prisma.userSession.updateMany({ where: { id: familyId, user_id: userId, revoked_at: null }, data: { revoked_at: now } }),
    prisma.refreshToken.updateMany({ where: { family_id: familyId, revoked_at: null }, data: { revoked_at: now } }),
  ]);
  await redis.setex(`sid:${familyId}`, ttl, '1');
  return true;
}

export async function listActiveSessions(userId: string) {
  return prisma.userSession.findMany({
    where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
    orderBy: { last_seen_at: 'desc' },
    select: { id: true, device_name: true, user_agent: true, ip_address: true, created_at: true, last_seen_at: true, expires_at: true },
  });
}

/**
 * Retention purge (daily job): expired tokens are dead weight the moment
 * they lapse; revoked/rotated ones are kept 30 days for reuse-detection
 * forensics, then dropped. Without this the table accretes forever.
 */
export async function purgeRefreshTokens(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [tokens, sessions] = await Promise.all([
    prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expires_at: { lt: now } },
        { revoked_at: { lt: cutoff } },
      ],
    },
    }),
    prisma.userSession.deleteMany({
      where: { OR: [{ expires_at: { lt: cutoff } }, { revoked_at: { lt: cutoff } }] },
    }),
  ]);
  return tokens.count + sessions.count;
}

/**
 * Validates and rotates. Returns the user id and the successor token.
 * Tokens issued before rotation shipped (valid JWT, no DB row) are accepted
 * once and seeded into a new family, so deploying this does not log
 * everyone out.
 */
export async function rotateRefreshToken(token: string): Promise<{ userId: string; refreshToken: string; sessionId: string }> {
  let payload: { sub: string; jti?: string; fam?: string };
  try {
    payload = jwt.verify(token, JWT_REFRESH_SECRET) as typeof payload;
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const row = payload.jti
    ? await prisma.refreshToken.findUnique({ where: { id: payload.jti } })
    : null;

  if (!row) {
    // Legacy token from before rotation — migrate it into a tracked family.
    const refreshToken = await issueRefreshToken(payload.sub);
    const successor = jwt.decode(refreshToken) as { fam: string };
    return { userId: payload.sub, refreshToken, sessionId: successor.fam };
  }

  const session = await prisma.userSession.findUnique({ where: { id: row.family_id } });
  if (session?.revoked_at || await redis.get(`sid:${row.family_id}`)) {
    throw new UnauthorizedError('Session revoked — please sign in again');
  }

  if (row.revoked_at || row.replaced_by) {
    // Reuse detected: this token was already rotated or revoked.
    logger.warn({ userId: row.user_id, family: row.family_id }, 'refresh token reuse detected — revoking family');
    await revokeFamily(row.family_id);
    throw new UnauthorizedError('Refresh token reuse detected — please sign in again');
  }
  if (row.expires_at < new Date()) {
    throw new UnauthorizedError('Refresh token expired');
  }

  const refreshToken = await issueRefreshToken(row.user_id, row.family_id);
  const successor = jwt.decode(refreshToken) as { jti: string };
  const consumed = await prisma.refreshToken.updateMany({
    where: { id: row.id, revoked_at: null, replaced_by: null },
    data: { replaced_by: successor.jti },
  });
  if (!consumed.count) {
    await revokeFamily(row.family_id);
    throw new UnauthorizedError('Refresh token reuse detected — please sign in again');
  }
  return { userId: row.user_id, refreshToken, sessionId: row.family_id };
}
