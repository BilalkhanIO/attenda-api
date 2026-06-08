import { can, hasFeature } from '../../services/authorization';

describe('authorization helpers', () => {
  it('can checks permission membership', () => {
    const perms = new Set(['leave.approve', 'employees.view']);
    expect(can(perms, 'leave.approve')).toBe(true);
    expect(can(perms, 'payroll.view')).toBe(false);
  });

  it('hasFeature requires explicit true', () => {
    expect(hasFeature({ payroll: true, shifts: false }, 'payroll')).toBe(true);
    expect(hasFeature({ payroll: false }, 'payroll')).toBe(false);
    expect(hasFeature({}, 'payroll')).toBe(false);
  });
});
