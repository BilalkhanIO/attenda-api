import { intersectAssignmentEmployeeIds } from '../../services/shiftAssignmentScope';

describe('intersectAssignmentEmployeeIds', () => {
  it('keeps department and employee filters inside the manager visibility scope', () => {
    expect(intersectAssignmentEmployeeIds(['a', 'b'], ['b', 'c'], 'c')).toEqual([]);
    expect(intersectAssignmentEmployeeIds(['a', 'b'], ['b', 'c'], 'b')).toEqual(['b']);
  });

  it('keeps organization-wide filters unrestricted only when no narrowing filter is supplied', () => {
    expect(intersectAssignmentEmployeeIds(null)).toBeNull();
    expect(intersectAssignmentEmployeeIds(null, ['a', 'b'])).toEqual(['a', 'b']);
    expect(intersectAssignmentEmployeeIds(null, undefined, 'a')).toEqual(['a']);
  });

  it('returns no visible users for an empty manager or department scope', () => {
    expect(intersectAssignmentEmployeeIds([], ['a'])).toEqual([]);
    expect(intersectAssignmentEmployeeIds(null, [])).toEqual([]);
  });
});
