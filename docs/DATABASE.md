# Database Schema

33 models, PostgreSQL, Prisma 7. Source of truth: `prisma/schema.prisma`.
Migrations: append-only SQL in `prisma/migrations/`, registered in
`scripts/migrate.js`, applied idempotently at container start.

Conventions: UUID string PKs · `created_at` defaults · org scoping via
`org_id` FK on every tenant entity (handlers always filter by
`req.user.org_id`) · soft delete on `users.deleted_at` · money-affecting
mutations mirrored to `audit_logs` (append-only) · statuses as constrained
strings validated at the zod boundary.

## Core domain

```mermaid
erDiagram
    Organisation ||--o{ User : employs
    Organisation ||--o{ Department : has
    Department   |o--o{ Department : "sub-departments"
    Department   |o--o{ User : members
    User         |o--o{ User : "manager / direct_reports"

    User ||--o{ AttendanceRecord : "daily record (unique user+date)"
    AttendanceRecord ||--o{ BreakRecord : breaks
    AttendanceRecord ||--o| RemoteSession : "remote day"
    RemoteSession ||--o{ RemoteCheckinLog : "WhatsApp nudges"
    User ||--o{ LateArrivalNotice : "running-late notices"

    User ||--o{ LeaveRequest : requests
    User ||--o{ LeaveBalance : "per type+year"

    Organisation ||--o{ Shift : templates
    Shift ||--o{ ShiftBreak : "break policies"
    Shift ||--o{ ShiftAssignment : "user+date"
    User  ||--o{ ShiftAssignment : assigned
    User  ||--o{ ShiftSwap : "requester/target"

    AttendanceRecord ||--o| OvertimeRequest : "extra time"
    Organisation ||--o{ OvertimeRule : rules
    User ||--o{ PayrollRecord : "period month+year"
    User ||--o{ PerformanceReview : reviews
    PerformanceReview ||--o{ PerformanceGoal : goals

    User ||--o{ InAppNotification : notifications
    Organisation ||--o{ WhatsappLog : "delivery audit"
    User ||--o{ RefreshToken : "rotating families"
    Organisation ||--o{ AuditLog : "pay-affecting trail"
```

## RBAC (dynamic; `users.role` is a denormalized mirror only)

```mermaid
erDiagram
    Permission ||--o{ OrgRolePermission : grants
    OrgRole ||--o{ OrgRolePermission : holds
    Organisation ||--o{ OrgRole : "system + custom roles"
    User ||--o| UserOrgRole : "assigned role (source of truth)"
    OrgRole ||--o{ UserOrgRole : assignees
    User ||--o{ UserPermissionGrant : "per-user allow/deny overrides"

    Permission ||--o{ PlatformRolePermission : grants
    PlatformRole ||--o{ PlatformRolePermission : holds
    User ||--o{ PlatformUserRole : "platform staff (SYSTEM org)"
```

Effective org permissions = assigned role's keys (fallback: legacy-role map
when unassigned) ∪ `allow` grants − `deny` grants. Platform permissions come
from `PlatformUserRole` (fallback: full `platform.*` set for legacy
`role=platform_admin` users with no assignments).

## SaaS layer

`PlanDefinition` (features JSON, pricing, trial days) → `Organisation.plan`
+ `features_override` → resolved per-request by `resolveOrgFeatures` and
gated by `requireOrgFeature`. `BlogPost` backs the public site CMS.

## Key attendance columns worth knowing

`AttendanceRecord`: `check_in_at/out_at`, `check_in_type`
(auto_ip|qr|manual|remote), `status` (in|late|out|absent|leave|remote),
`late_minutes`, `early_out_minutes`, `net_hours_worked`, `break_minutes`,
`extra_office_minutes`, `auto_checked_out`, `last_heartbeat_at`,
`challenge_sent_at` (FCM presence challenge), `is_overridden` +
`override_reason` (audited). `Organisation` tuning:
`late_threshold`, `heartbeat_grace_mins`, `gap_forgiveness_mins`,
`payroll_day`, `tax_rate`, `pension_rate`, `totp_required`.
