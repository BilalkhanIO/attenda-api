import { mergeShiftCandidates } from '../../utils/schedulerCandidates';

describe('mergeShiftCandidates', () => {
  it('merges explicitly assigned and branch-wide employees without duplicates', () => {
    const assigned = { id: 'assigned', name: 'Assigned' };
    const shared = { id: 'shared', name: 'Shared' };
    const result = mergeShiftCandidates(
      [{ user_id: assigned.id, user: assigned, shift: { id: 'night' } }],
      [shared, assigned],
    );

    expect(result.employees.map(user => user.id).sort()).toEqual(['assigned', 'shared']);
    expect(result.shiftByUserId.get('assigned')).toEqual({ id: 'night' });
    expect(result.shiftByUserId.has('shared')).toBe(false);
  });

  it('returns only scheduled employees when there is no branch-wide shift', () => {
    const scheduled = { id: 'scheduled' };
    const result = mergeShiftCandidates(
      [{ user_id: scheduled.id, user: scheduled, shift: 'day' }],
      [],
    );

    expect(result.employees).toEqual([scheduled]);
    expect(result.shiftByUserId.get('scheduled')).toBe('day');
  });
});
