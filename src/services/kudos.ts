/**
 * Kudos rate-limit-lite helpers — pure so the daily-cap policy is unit
 * testable without prisma. A giver may send at most KUDOS_DAILY_LIMIT
 * kudos per UTC calendar day; the router counts today's rows and asks
 * isKudosCapReached before creating another.
 */

export const KUDOS_DAILY_LIMIT = 20;

/** UTC calendar-day window [start, end) containing `now`. */
export function kudosDayWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/** true ⇒ the giver already used up today's allowance. */
export function isKudosCapReached(countToday: number, limit = KUDOS_DAILY_LIMIT): boolean {
  return countToday >= limit;
}
