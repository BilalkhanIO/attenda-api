import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './response';

export interface CursorPosition {
  at: Date;
  id: string;
  tie?: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object' || value instanceof Date) return value instanceof Date ? value.toISOString() : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
}

function filterHash(filters: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(filters))).digest('hex');
}

function cursorSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for signed pagination cursors');
  return secret;
}

export function encodeCursor(position: CursorPosition, filters: unknown): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, at: position.at.toISOString(), id: position.id, ...(position.tie ? { tie: position.tie } : {}), filter: filterHash(filters) })).toString('base64url');
  const signature = createHmac('sha256', cursorSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** Legacy UUID cursors return null so callers can continue the old anchor query. */
export function decodeCursor(value: string, filters: unknown): CursorPosition | null {
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  try {
    const payload = value.slice(0, separator);
    const supplied = Buffer.from(value.slice(separator + 1), 'base64url');
    const expected = createHmac('sha256', cursorSecret()).update(payload).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('signature');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: number; at?: string; id?: string; tie?: string; filter?: string };
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || typeof parsed.at !== 'string' || parsed.filter !== filterHash(filters)) throw new Error('shape or filter');
    const at = new Date(parsed.at);
    if (!Number.isFinite(at.getTime())) throw new Error('timestamp');
    return { at, id: parsed.id, ...(typeof parsed.tie === 'string' ? { tie: parsed.tie } : {}) };
  } catch {
    throw new ValidationError('Invalid or expired pagination cursor. Refresh the list and try again.');
  }
}

/** Ascending keyset comparator with an optional stable group tie-breaker. */
export function keysetAfterAscending(position: CursorPosition, field: 'created_at' | 'submitted_at', group: string, groupOrder: readonly string[]) {
  const currentRank = groupOrder.indexOf(group);
  const cursorRank = groupOrder.indexOf(position.tie ?? group);
  if (currentRank < cursorRank) return { [field]: { gt: position.at } };
  if (currentRank > cursorRank) return { [field]: { gte: position.at } };
  return {
    OR: [
      { [field]: { gt: position.at } },
      { [field]: position.at, id: { gt: position.id } },
    ],
  };
}

export function keysetAfter(position: CursorPosition, field: 'created_at' | 'date') {
  return {
    OR: [
      { [field]: { lt: position.at } },
      { [field]: position.at, id: { lt: position.id } },
    ],
  };
}
