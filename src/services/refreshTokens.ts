import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../utils/prisma';
import { UnauthorizedError } from '../utils/response';
import { logger } from '../utils/logger';

const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'dev-secret';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function expiresIn(): string {
  return process.env.JWT_REFRESH_EXPIRES_IN || '30d';
}

/**
 * Rotating refresh tokens with family-based reuse detection (OWASP/RFC 9700):
 * every refresh invalidates the presented token and issues a successor in the
 * same family. Presenting an already-used token means it leaked (or a client
 * replayed) — the whole family is revoked, forcing a fresh login.
 */
export async function issueRefreshToken(userId: string, familyId?: string): Promise<string> {
  const jti = uuidv4();
  const family = familyId ?? uuidv4();
  await prisma.refreshToken.create({
    data: {
      id: jti,
      user_id: userId,
      family_id: family,
      expires_at: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return jwt.sign({ sub: userId, jti, fam: family }, JWT_REFRESH_SECRET, {
    expiresIn: expiresIn() as jwt.SignOptions['expiresIn'],
  });
}

export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { family_id: familyId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/**
 * Validates and rotates. Returns the user id and the successor token.
 * Tokens issued before rotation shipped (valid JWT, no DB row) are accepted
 * once and seeded into a new family, so deploying this does not log
 * everyone out.
 */
export async function rotateRefreshToken(token: string): Promise<{ userId: string; refreshToken: string }> {
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
    return { userId: payload.sub, refreshToken };
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
  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { replaced_by: successor.jti },
  });
  return { userId: row.user_id, refreshToken };
}
