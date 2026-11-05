export const PUBLIC_API_SCOPES = [
  'employees.view',
  'employees.view_team',
  'attendance.view_team',
  'leave.view_all',
  'leave.view_team',
  'projects.view',
] as const;

export type PublicApiScope = (typeof PUBLIC_API_SCOPES)[number];
