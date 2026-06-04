/** Plan feature keys — aligned with Attenda-web admin/plans FEATURE_LABELS */
export const FEATURE_KEYS = [
  'attendance',
  'leave_management',
  'shifts',
  'payroll',
  'whatsapp',
  'performance_reviews',
  'remote_work',
  'api_access',
  'advanced_reports',
  'multi_location',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type PlanFeatures = Record<string, boolean>;

export const DEFAULT_PLAN_FEATURES: PlanFeatures = Object.fromEntries(
  FEATURE_KEYS.map(k => [k, false]),
);

export interface PermissionDef {
  key: string;
  module: string;
  description: string;
}

/** Global permission catalog */
export const PERMISSION_CATALOG: PermissionDef[] = [
  // Attendance
  { key: 'attendance.view_team', module: 'attendance', description: 'View team attendance' },
  { key: 'attendance.override', module: 'attendance', description: 'Override attendance records' },
  { key: 'attendance.export', module: 'attendance', description: 'Export attendance reports' },
  { key: 'attendance.late_notices.manage', module: 'attendance', description: 'Acknowledge late arrival notices' },
  // Leave
  { key: 'leave.view_team', module: 'leave', description: 'View team leave requests' },
  { key: 'leave.approve', module: 'leave', description: 'Approve or reject leave requests' },
  { key: 'leave.view_all', module: 'leave', description: 'View all org leave requests' },
  { key: 'leave.balance.manage', module: 'leave', description: 'Manage leave balances' },
  // Shifts
  { key: 'shifts.view', module: 'shifts', description: 'View shifts and schedules' },
  { key: 'shifts.manage', module: 'shifts', description: 'Create and edit shift templates' },
  { key: 'shifts.assign', module: 'shifts', description: 'Assign shifts to employees' },
  { key: 'shifts.breaks.manage', module: 'shifts', description: 'Manage shift breaks' },
  { key: 'shifts.swaps.approve', module: 'shifts', description: 'Approve shift swaps' },
  { key: 'shifts.ai_schedule', module: 'shifts', description: 'Use AI scheduling' },
  // Payroll
  { key: 'payroll.view', module: 'payroll', description: 'View payroll records' },
  { key: 'payroll.manage', module: 'payroll', description: 'Generate and adjust payroll' },
  { key: 'payroll.process', module: 'payroll', description: 'Process payroll runs' },
  // Employees
  { key: 'employees.view_team', module: 'employees', description: 'View direct reports' },
  { key: 'employees.view', module: 'employees', description: 'View all employees in org' },
  { key: 'employees.create', module: 'employees', description: 'Invite employees' },
  { key: 'employees.update', module: 'employees', description: 'Update employee profiles' },
  { key: 'employees.deactivate', module: 'employees', description: 'Activate/deactivate employees' },
  { key: 'employees.import', module: 'employees', description: 'Bulk import employees' },
  { key: 'employees.credentials.update', module: 'employees', description: 'Change employee email/password' },
  // Org settings
  { key: 'org.settings.view', module: 'org', description: 'View org settings' },
  { key: 'org.settings.update', module: 'org', description: 'Update org settings' },
  { key: 'org.office.update', module: 'org', description: 'Manage office IPs and SSIDs' },
  { key: 'org.whatsapp.update', module: 'org', description: 'Configure WhatsApp integration' },
  { key: 'org.qr.manage', module: 'org', description: 'Manage check-in QR codes' },
  { key: 'org.roles.manage', module: 'org', description: 'Manage custom org roles' },
  { key: 'org.permissions.grant', module: 'org', description: 'Grant per-user permission overrides' },
  // Analytics & reports
  { key: 'analytics.view', module: 'analytics', description: 'View analytics dashboards' },
  { key: 'analytics.advanced', module: 'analytics', description: 'Advanced analytics and anomalies' },
  { key: 'reports.view', module: 'reports', description: 'View HR reports' },
  { key: 'reports.export', module: 'reports', description: 'Export reports' },
  // Performance
  { key: 'performance.view', module: 'performance', description: 'View performance reviews' },
  { key: 'performance.manage', module: 'performance', description: 'Submit reviews and goals' },
  // Remote work
  { key: 'remote.approve', module: 'remote', description: 'Approve remote work sessions' },
  // WhatsApp
  { key: 'whatsapp.test', module: 'whatsapp', description: 'Send test WhatsApp messages' },
  { key: 'whatsapp.logs.view', module: 'whatsapp', description: 'View WhatsApp notification logs' },
  // Overtime
  { key: 'overtime.manage', module: 'overtime', description: 'Manage overtime rules' },
  // Platform (cross-tenant)
  { key: 'platform.orgs.view', module: 'platform', description: 'View organisations' },
  { key: 'platform.orgs.manage', module: 'platform', description: 'Manage organisation subscriptions' },
  { key: 'platform.orgs.approve', module: 'platform', description: 'Approve pending organisations' },
  { key: 'platform.plans.manage', module: 'platform', description: 'Manage plan definitions' },
  { key: 'platform.blog.manage', module: 'platform', description: 'Manage blog posts' },
  { key: 'platform.users.manage', module: 'platform', description: 'Manage platform admin users' },
];

const allKeys = () => PERMISSION_CATALOG.map(p => p.key);

const EMPLOYEE_PERMS: string[] = [];

const MANAGER_PERMS = [
  ...EMPLOYEE_PERMS,
  'employees.view_team',
  'attendance.view_team',
  'attendance.override',
  'attendance.late_notices.manage',
  'leave.view_team',
  'leave.approve',
  'shifts.view',
  'shifts.breaks.manage',
  'shifts.swaps.approve',
  'performance.view',
  'performance.manage',
  'analytics.view',
  'remote.approve',
];

const HR_ADMIN_PERMS = [
  ...MANAGER_PERMS,
  'employees.view',
  'employees.create',
  'employees.update',
  'employees.deactivate',
  'employees.import',
  'attendance.export',
  'leave.view_all',
  'leave.balance.manage',
  'shifts.manage',
  'shifts.assign',
  'shifts.ai_schedule',
  'payroll.view',
  'payroll.manage',
  'payroll.process',
  'reports.view',
  'reports.export',
  'analytics.advanced',
  'overtime.manage',
  'whatsapp.test',
  'whatsapp.logs.view',
  'org.settings.view',
  'org.qr.manage',
];

const SUPER_ADMIN_PERMS = [
  ...HR_ADMIN_PERMS,
  'org.settings.update',
  'org.office.update',
  'org.whatsapp.update',
  'org.roles.manage',
  'org.permissions.grant',
  'employees.credentials.update',
];

/** Legacy role slug → permission keys (matches requireRole hierarchy today) */
export const LEGACY_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  employee: EMPLOYEE_PERMS,
  manager: MANAGER_PERMS,
  hr_admin: HR_ADMIN_PERMS,
  super_admin: SUPER_ADMIN_PERMS,
};

export const SYSTEM_ORG_ROLE_SLUGS = ['employee', 'manager', 'hr_admin', 'super_admin'] as const;

export const PLATFORM_ROLE_DEFS = [
  {
    slug: 'platform_admin',
    name: 'Platform Admin',
    description: 'Full platform SaaS console access',
    permissions: allKeys().filter(k => k.startsWith('platform.')),
  },
  {
    slug: 'platform_assistant',
    name: 'Platform Assistant',
    description: 'Limited platform access (orgs view, blog)',
    permissions: ['platform.orgs.view', 'platform.blog.manage'],
  },
];
