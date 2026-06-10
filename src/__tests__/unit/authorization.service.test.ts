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

describe('legacy role permission fallback', () => {
  it('system role maps mirror the legacy hierarchy', async () => {
    const { SYSTEM_ROLE_PERMISSIONS } = await import('../../utils/rbac-seed');
    // hierarchy: each tier is a superset of the one below
    const employee = new Set(SYSTEM_ROLE_PERMISSIONS.employee);
    const manager  = new Set(SYSTEM_ROLE_PERMISSIONS.manager);
    const hr       = new Set(SYSTEM_ROLE_PERMISSIONS.hr_admin);
    const superA   = new Set(SYSTEM_ROLE_PERMISSIONS.super_admin);

    for (const k of employee) expect(manager.has(k)).toBe(true);
    for (const k of manager)  expect(hr.has(k)).toBe(true);
    for (const k of hr)       expect(superA.has(k)).toBe(true);

    // gates converted from requireRole rely on these keys existing per tier
    expect(manager.has('attendance.view_team')).toBe(true);
    expect(manager.has('leave.approve')).toBe(true);
    expect(hr.has('payroll.process')).toBe(true);
    expect(hr.has('employees.view')).toBe(true);
    expect(hr.has('leave.view_all')).toBe(true);
    expect(superA.has('org.settings.update')).toBe(true);
    expect(superA.has('org.roles.manage')).toBe(true);
    // managers must NOT hold org-wide keys
    expect(manager.has('employees.view')).toBe(false);
    expect(manager.has('leave.view_all')).toBe(false);
  });

  it('every system role permission exists in the catalog', async () => {
    const { SYSTEM_ROLE_PERMISSIONS } = await import('../../utils/rbac-seed');
    const { PERMISSION_CATALOG } = await import('../../constants/rbac');
    const catalog = new Set(PERMISSION_CATALOG.map(p => p.key));
    for (const keys of Object.values(SYSTEM_ROLE_PERMISSIONS)) {
      for (const k of keys) expect(catalog.has(k)).toBe(true);
    }
  });
});
