import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET         = process.env.JWT_SECRET || 'dev-secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';

export interface JwtPayload {
  sub:    string;
  org_id: string;
  role:   string;
  name:   string;
  email:  string;
  jti:    string;
}

// ─── JWT ──────────────────────────────────────────────
export function signAccessToken(payload: Omit<JwtPayload, 'jti'>): string {
  return jwt.sign({ ...payload, jti: uuidv4() }, JWT_SECRET, {
    expiresIn: (process.env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '8h',
  });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, jti: uuidv4() }, JWT_REFRESH_SECRET, {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '30d',
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): { sub: string; jti: string } {
  return jwt.verify(token, JWT_REFRESH_SECRET) as { sub: string; jti: string };
}

export function decodeToken(token: string) {
  return jwt.decode(token) as JwtPayload | null;
}

// ─── Password ─────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function generateToken(): string {
  return uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
}

// ─── Working days calculator ──────────────────────────
export function calculateWorkingDays(start: Date, end: Date): number {
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ─── Date helpers ─────────────────────────────────────
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function startOfMonth(year: number, month: number): Date {
  return new Date(year, month - 1, 1, 0, 0, 0, 0);
}

export function endOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0, 23, 59, 59, 999);
}

// ─── Hours calc ───────────────────────────────────────
export function calcHoursWorked(checkIn: Date, checkOut: Date): number {
  return Math.round(((checkOut.getTime() - checkIn.getTime()) / 3_600_000) * 100) / 100;
}
