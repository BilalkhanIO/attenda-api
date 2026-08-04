// In-process org event bus used for SSE invalidation pushes.

jest.mock('../../utils/prisma', () => ({
  __esModule: true,
  default: {},
}));

import { emitOrgEvent, subscribeOrgEvents, OrgEventType } from '../../services/notifications';

describe('org event bus', () => {
  it('delivers events to subscribers of the same org only', () => {
    const gotA: OrgEventType[] = [];
    const gotB: OrgEventType[] = [];
    const offA = subscribeOrgEvents('org-a', t => gotA.push(t));
    const offB = subscribeOrgEvents('org-b', t => gotB.push(t));

    emitOrgEvent('org-a', 'attendance_changed');
    emitOrgEvent('org-a', 'leave_changed');
    emitOrgEvent('org-b', 'swap_changed');

    expect(gotA).toEqual(['attendance_changed', 'leave_changed']);
    expect(gotB).toEqual(['swap_changed']);
    offA();
    offB();
  });

  it('stops delivering after unsubscribe', () => {
    const got: OrgEventType[] = [];
    const off = subscribeOrgEvents('org-c', t => got.push(t));
    emitOrgEvent('org-c', 'overtime_changed');
    off();
    emitOrgEvent('org-c', 'remote_changed');
    expect(got).toEqual(['overtime_changed']);
  });

  it('emitOrgEvent never throws, even if a listener does', () => {
    const off = subscribeOrgEvents('org-d', () => { throw new Error('listener boom'); });
    expect(() => emitOrgEvent('org-d', 'attendance_changed')).not.toThrow();
    off();
  });

  it('emitting with no subscribers is a no-op', () => {
    expect(() => emitOrgEvent('org-nobody', 'leave_changed')).not.toThrow();
  });
});
