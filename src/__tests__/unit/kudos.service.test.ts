// Kudos daily-cap policy — pure helpers backing POST /kudos's
// rate-limit-lite (count today's rows, then ask isKudosCapReached).

import { KUDOS_DAILY_LIMIT, kudosDayWindow, isKudosCapReached } from '../../services/kudos';

describe('kudosDayWindow', () => {
  it('returns the UTC calendar day containing now', () => {
    const { start, end } = kudosDayWindow(new Date('2026-08-02T15:30:45.123Z'));
    expect(start).toEqual(new Date('2026-08-02T00:00:00.000Z'));
    expect(end).toEqual(new Date('2026-08-03T00:00:00.000Z'));
  });

  it('pins midnight edges to their own day', () => {
    const atMidnight = kudosDayWindow(new Date('2026-08-02T00:00:00.000Z'));
    expect(atMidnight.start).toEqual(new Date('2026-08-02T00:00:00.000Z'));

    const justBefore = kudosDayWindow(new Date('2026-08-02T23:59:59.999Z'));
    expect(justBefore.start).toEqual(new Date('2026-08-02T00:00:00.000Z'));
    expect(justBefore.end).toEqual(new Date('2026-08-03T00:00:00.000Z'));
  });

  it('rolls over month and year boundaries', () => {
    const { start, end } = kudosDayWindow(new Date('2026-12-31T10:00:00.000Z'));
    expect(start).toEqual(new Date('2026-12-31T00:00:00.000Z'));
    expect(end).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });
});

describe('isKudosCapReached', () => {
  it('allows up to the limit and blocks at it', () => {
    expect(KUDOS_DAILY_LIMIT).toBe(20);
    expect(isKudosCapReached(0)).toBe(false);
    expect(isKudosCapReached(19)).toBe(false);
    expect(isKudosCapReached(20)).toBe(true);
    expect(isKudosCapReached(21)).toBe(true);
  });

  it('honors a custom limit', () => {
    expect(isKudosCapReached(4, 5)).toBe(false);
    expect(isKudosCapReached(5, 5)).toBe(true);
  });
});
