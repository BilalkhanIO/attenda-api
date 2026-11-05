import { Router } from 'express';
import { createHash } from 'node:crypto';
import prisma from '../utils/prisma';

const router = Router();

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function localToUtc(dateOnly: string, time: string, timezone: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const delta = target - represented;
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

router.get('/:token.ics', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.status(404).end();
    const token_hash = createHash('sha256').update(token).digest('hex');
    const feed = await prisma.calendarFeed.findFirst({
      where: { token_hash, revoked_at: null, user: { is_active: true, deleted_at: null } },
      include: { organisation: { select: { timezone: true } }, user: { select: { id: true, name: true } } },
    });
    if (!feed) return res.status(404).end();
    await prisma.calendarFeed.update({ where: { id: feed.id }, data: { last_used_at: new Date() } });

    const now = new Date();
    const from = new Date(now); from.setUTCDate(from.getUTCDate() - 45);
    const to = new Date(now); to.setUTCDate(to.getUTCDate() + 370);
    const assignments = await prisma.shiftAssignment.findMany({
      where: { user_id: feed.user_id, is_published: true, date: { gte: from, lte: to }, shift: { org_id: feed.org_id } },
      include: { shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true } } },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    const stamp = utcStamp(new Date());
    const events = assignments.map(assignment => {
      const date = assignment.date.toISOString().slice(0, 10);
      const start = localToUtc(date, assignment.shift.start_time, feed.organisation.timezone);
      let end = localToUtc(date, assignment.shift.end_time, feed.organisation.timezone);
      if (end <= start) end = localToUtc(new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), assignment.shift.end_time, feed.organisation.timezone);
      return [
        'BEGIN:VEVENT', `UID:${assignment.id}@attenda`, `DTSTAMP:${stamp}`,
        `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`,
        `SUMMARY:${escapeIcs(assignment.shift.name)}`,
        `DESCRIPTION:${escapeIcs(`Scheduled shift for ${feed.user.name}`)}`,
        `STATUS:CONFIRMED`, 'END:VEVENT',
      ].join('\r\n');
    });
    const calendar = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Attenda//Personal Shift Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="attenda-shifts.ics"');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(calendar);
  } catch (error) { next(error); }
});

export default router;
