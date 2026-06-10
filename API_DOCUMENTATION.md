# Attenda API Documentation for Developers

This document details the internal logic, fallback mechanisms, and API specifications for the Attenda platform.

---

## 1. Core System Logic

### 1.1 Timezone & Date Handling
The system supports multiple organisations across different timezones. 
- **Database Storage:** All `DateTime` fields are stored in UTC. `Date` fields (like `attendance.date`) are stored as UTC midnights representing the local calendar day of the organisation.
- **Org Today Logic:** "Today" is never calculated using the server's local time. It is calculated by taking the current UTC instant and shifting it to the Organisation's configured `timezone`.
- **Wall-Clock Times:** Shift start/end times are stored as strings (e.g., `"09:00"`). These are interpreted strictly within the context of the org's timezone.

### 1.2 Shift Fallback Hierarchy
When checking for an employee's schedule (for lateness detection or mobile UI banners), the system follows this priority:
1. **Individual Assignment:** Check the `ShiftAssignment` table for a specific `user_id` and `date`.
2. **Organisation-Wide Shift:** If no individual assignment exists, look for a Shift where `is_org_wide: true` and the current day of the week is in `active_days`.
3. **Default Shift:** As a final fallback, look for a Shift where `is_default: true` and the current day of the week is in `active_days`.
4. **No Shift:** If all above are null, the employee is considered "unscheduled" for that day.

---

## 2. API Endpoints Reference

### 2.1 Authentication (`/auth`)
Handles registration, login, password resets, and 2FA.

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/auth/register` | Register a new organisation and super_admin. |
| `POST` | `/auth/login` | Login with email/password. Supports 2FA challenge. |
| `POST` | `/auth/logout` | Invalidate current access token. |
| `POST` | `/auth/refresh` | Get new access token using refresh token. |
| `POST` | `/auth/forgot-password` | Initiate password reset email. |
| `POST` | `/auth/reset-password` | Complete password reset using token. |
| `POST` | `/auth/setup-account` | Complete initial account setup from invite. |
| `PUT` | `/auth/change-password` | Change password for authenticated user. |
| `POST` | `/auth/2fa/authenticate`| Complete 2FA login with TOTP code. |
| `POST` | `/auth/2fa/setup` | Generate TOTP secret and QR code. |
| `POST` | `/auth/2fa/verify` | Verify and enable 2FA. |
| `DELETE` | `/auth/2fa` | Disable 2FA. |
| `GET` | `/auth/sso/google` | Initiate Google SSO. |
| `GET` | `/auth/sso/google/callback` | Google SSO callback handler. |

### 2.2 Attendance (`/attendance`)
Manages check-ins, check-outs, breaks, and real-time monitoring.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/attendance/today` | Get today's attendance for the manager's team. |
| `GET` | `/attendance/me` | Get calling user's attendance history. |
| `GET` | `/attendance/today-status`| **Dashboard API.** Live shift and break status. |
| `POST` | `/attendance/checkin` | Capture check-in (Manual, QR, Remote, IP). |
| `POST` | `/attendance/checkout` | Capture check-out and finalize hours. |
| `POST` | `/attendance/heartbeat` | WiFi heartbeat to prevent auto-checkout. |
| `POST` | `/attendance/break/start`| Start a break session. |
| `POST` | `/attendance/break/end` | End a break session. |
| `GET` | `/attendance/break/status`| Get current break status for the user. |
| `POST` | `/attendance/late-notice` | Submit advance notice of late arrival. |
| `GET` | `/attendance/late-notices` | List pending late notices (Manager). |
| `PUT` | `/attendance/late-notice/:id/acknowledge` | Acknowledge a late notice. |
| `GET` | `/attendance/remote/sessions` | List remote sessions for approval. |
| `PUT` | `/attendance/remote/sessions/:id/approve` | Approve a remote work session. |
| `GET` | `/attendance/report/export` | Export attendance data for a date range. |
| `PUT` | `/attendance/:id/override` | Manually override an attendance record. |

### 2.3 Shifts & Scheduling (`/shifts`)
Manages shift templates, assignments, and swaps.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/shifts` | List organisation shift templates. |
| `POST` | `/shifts` | Create a new shift template. |
| `PUT` | `/shifts/:id` | Update shift template settings. |
| `PUT` | `/shifts/:id/set-default` | Set a shift as the default org fallback. |
| `GET` | `/shifts/assignments` | List assignments for a week/department. |
| `POST` | `/shifts/assignments` | Assign a shift to a user for a specific date. |
| `POST` | `/shifts/assignments/bulk`| Bulk assign shifts to many users. |
| `DELETE` | `/shifts/assignments/:id`| Remove a shift assignment. |
| `POST` | `/shifts/schedule/publish`| Notify employees of their weekly schedule. |
| `POST` | `/shifts/swaps` | Request a shift swap with a colleague. |
| `PUT` | `/shifts/swaps/:id/approve` | Approve a pending shift swap. |
| `POST` | `/shifts/ai-schedule` | Generate shift plan using AI. |

### 2.4 Leave Management (`/leave`)
Handles leave requests, approvals, and balances.

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/leave/requests` | Submit a new leave request. |
| `GET` | `/leave/requests/me` | Get caller's leave history. |
| `GET` | `/leave/requests/team` | List pending requests for team (Manager). |
| `PUT` | `/leave/requests/:id/approve` | Approve a leave request. |
| `PUT` | `/leave/requests/:id/reject` | Reject a leave request. |
| `GET` | `/leave/balance/me` | Get caller's remaining leave days. |
| `GET` | `/leave/calendar` | Get team leave calendar view. |

### 2.5 User Management (`/users`)
Directory and profile management.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/users/me` | Get current user's profile. |
| `PUT` | `/users/me` | Update current user's profile/avatar. |
| `GET` | `/users` | List organisation directory. |
| `POST` | `/users` | Create/Invite a new employee. |
| `PUT` | `/users/:id` | Update employee details (HR). |
| `PATCH` | `/users/:id/deactivate` | Deactivate an employee account. |
| `POST` | `/users/import` | Bulk import employees via CSV. |

### 2.5b Departments (`/org/departments`)

Structured departments with one level of sub-departments. The flat GET stays
backward-compatible with the old string list.

| Method | Path | Description |
|---|---|---|
| `GET` | `/org/departments` | Flat name list (departments table merged with legacy user strings). |
| `GET` | `/org/departments/tree` | Hierarchy with member counts. |
| `POST` | `/org/departments` | Create department or sub-department (`name`, `parent_id?`). Permission: `org.departments.manage`. |
| `PUT` | `/org/departments/:id` | Rename / re-parent. Renames sync users' legacy department strings. |
| `DELETE` | `/org/departments/:id` | Blocked while members or sub-departments exist. |

Users accept `department_id` on create/update; the legacy `department` string
is kept in sync from the department name.

### 2.6 Payroll (`/payroll`)
Generation and viewing of monthly payslips.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/payroll` | List payroll records for the org. |
| `POST` | `/payroll/generate` | Trigger payroll generation for a month. |
| `GET` | `/payroll/me` | Get caller's payslip history. |
| `GET` | `/payroll/payslips/:id/download` | Download PDF payslip. |
| `POST` | `/payroll/process-full` | Finalize and lock payroll for the month. |

### 2.7 Organisation & RBAC (`/org-rbac`)
Custom roles and permissions within an organisation.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/org-rbac/permissions` | List all available system permissions. |
| `GET` | `/org-rbac/roles` | List custom roles for the org. |
| `POST` | `/org-rbac/roles` | Create a new custom role. |
| `PUT` | `/org-rbac/users/:userId/role` | Assign a role to a user. |

### 2.8 Platform Administration (`/admin`)
Global platform management (Super Admins only).

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/admin/stats` | Platform-wide analytics dashboard. |
| `GET` | `/admin/orgs` | List all registered organisations. |
| `PATCH` | `/admin/orgs/:id/plan` | Update organisation's subscription plan. |
| `POST` | `/admin/orgs/:id/approve` | Approve a pending organisation signup. |
| `GET` | `/admin/plans` | Manage subscription plan definitions. |

---

## 3. Background Jobs (Cron)

| Job Name | Schedule | Logic |
| :--- | :--- | :--- |
| **Late Detector** | Every 1 min | Scans all orgs. If an employee is past shift start + tolerance and hasn't checked in, marks as `late` and notifies manager. |
| **Absent Detector** | Every 1 hour | Marks as `absent` if no check-in recorded 2 hours after shift start. |
| **Heartbeat Monitor** | Every 5 min | Checks `last_heartbeat_at`. If > 10 min old, auto-checks out the employee at their last known active time. |
| **Payroll Gen** | Daily 08:00 | Only fires if `today == org.payroll_day`. Calculates totals for the **previous** month. |

---

## 4. Error Codes

| Code | Status | Description |
| :--- | :--- | :--- |
| `UNAUTHORIZED` | 401 | Missing or invalid Bearer token. |
| `FORBIDDEN` | 403 | User role has insufficient permissions. |
| `NOT_FOUND` | 404 | Resource does not exist. |
| `VALIDATION_ERROR` | 422 | Invalid body parameters. |
| `CONFLICT` | 409 | Duplicate record (e.g., email or double check-in). |
