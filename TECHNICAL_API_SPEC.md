# Attenda Technical API Specification

This document is designed for developers to understand the deep logic, side effects, and data flows of the Attenda API.

---

## 1. Development Patterns

### 1.1 Standard Middleware Chain
Most routes follow this sequence:
1. `authenticate`: Verifies JWT and attaches `req.user`.
2. `requireRole` or `requirePermission`: Enforces RBAC.
3. `requireOrgFeature`: Checks if the organisation's plan supports the feature (e.g., WhatsApp, AI).

### 1.2 Response Helpers
Located in `src/utils/response.ts`:
- `ok(res, data)`: Returns 200 with `{ success: true, data }`.
- `created(res, data)`: Returns 201.
- `NotFoundError(resource)`: Throws 404.
- `ValidationError(message)`: Throws 422.

---

## 2. Attendance Module (`/attendance`)

### `POST /attendance/checkin`
**What it does:** Records an employee's arrival.
- **Request:**
  - Body: `{ type: "manual" | "qr" | "remote", qr_code?: string, device_ssid?: string }`
- **Response:** The created `AttendanceRecord`.
- **Background Logic:**
  1. **Org Context:** Fetches organisation timezone and `late_threshold`.
  2. **Existence Check:** Prevents double check-in for the same `date` (org-local day).
  3. **Leave Validation:** Blocks check-in if there is an approved full-day leave.
  4. **Shift Fallback:** Identifies the shift (Assignment > Org-Wide > Default).
  5. **Late Detection:** Compares current time vs `shift.start_time`. If diff > `org.late_threshold`, sets status to `late`.
  6. **Remote Handling:** If `type === 'remote'`, it creates a `RemoteSession` in `pending` status. This record will *not* contribute to `hours_worked` until a manager approves it.
  7. **IP/WiFi:** If `qr_code` or `ssid` is provided, it validates against `org.office_ips` or `org.office_ssids`.

### `POST /attendance/checkout`
**What it does:** Finalizes the workday.
- **Request:** Body: `{ force?: boolean }`
- **Background Logic:**
  1. **Break Settlement:** Calls `settleBreaks()` to close any open break records.
  2. **Hours Calculation:** Computes `gross_hours` (Checkout - Checkin).
  3. **Net Hours:** Subtracts all **unpaid** break minutes from `gross_hours`.
  4. **Adherence Score:** Calculates a 0-100 score based on `late_minutes` and `early_out_minutes`.
  5. **WhatsApp Notification:** Sends a summary message to the organisation's configured WhatsApp groups if enabled.

---

## 3. Shift Module (`/shifts`)

### `POST /shifts/assignments/bulk`
**What it does:** Assigns templates to many users at once.
- **Request:**
  - Body: `{ user_ids: string[], shift_id: string, dates: string[] }`
- **Background Logic:**
  1. **Conflict Resolution:** Searches for existing `ShiftAssignment` records for all selected users/dates. Returns a `skipped` list for conflicts.
  2. **Leave Awareness:** Cross-references `LeaveRequest`. If a user is on leave, it still creates the assignment but returns a `warning` in the response metadata.
  3. **Transaction:** Uses `prisma.$transaction` to ensure that either all assignments are created or none are (atomicity).

### `POST /shifts/ai-schedule`
**What it does:** Uses AI to generate a staffing plan.
- **Request:** Body: `{ description: string, week_start: string }`
- **Background Logic:**
  1. **Context Gathering:** Fetches all available `Shift` templates and all active `User` records.
  2. **AI Prompting:** Sends the `description` (e.g., "Need 3 people on mornings") along with the JSON of shifts/users to Claude.
  3. **Parsing:** Extracts a JSON plan from the AI response. **Note:** It does *not* save the assignments; it returns a draft for the HR Admin to review and confirm.

---

## 4. Payroll Module (`/payroll`)

### `POST /payroll/generate`
**What it does:** Pre-calculates monthly totals.
- **Request:** Body: `{ month: number, year: number, user_ids?: string[] }`
- **Background Logic:**
  1. **Aggregation:** Sums `net_hours_worked` and `overtime_hours` for the period.
  2. **Rate Application:** Multiplies hours by `user.hourly_rate`.
  3. **Unpaid Leave Deduction:** 
     - If the user is **salaried**, it subtracts `(unpaid_days * daily_rate)`.
     - If the user is **hourly**, the deduction is 0 (since they only get paid for hours clocked).
  4. **Taxes/Pension:** Applies percentages from `Organisation` settings.
  5. **Incompleteness Check:** If a user has hours but `hourly_rate` is 0, the record is flagged `is_incomplete: true` for HR intervention.

---

## 5. Performance & AI Analytics (`/performance`, `/analytics`)

### `GET /performance/reviews/:userId/insights`
**What it does:** Generates an AI performance summary.
- **Background Logic:**
  1. **Data Mining:** Aggregates the last 6 months of `PerformanceReview` ratings, 10 most recent `PerformanceGoal` completions, and 90 days of `AttendanceRecord` stats (late/absent counts).
  2. **AI Synthesis:** Claude analyzes the trends (e.g., "Performance is rising but lateness is increasing") and generates constructive feedback.

### `GET /analytics/anomalies`
**What it does:** Flags suspicious behavior.
- **Background Logic:**
  1. **Pattern Recognition:** AI scans the last 200 attendance records.
  2. **Anomaly Detection:** Flags things like "Employee always checks in from a different IP on Fridays" or "Sudden 40% jump in overtime for the Marketing dept".

---

## 6. Global Background Jobs (`src/jobs/scheduler.ts`)

| Job | Frequency | Logic |
| :--- | :--- | :--- |
| **Late Arrival** | 1 min | For every org, finds active shifts. Checks assigned users. If `now > start + tolerance` and `check_in_at` is null, it upserts a record with `status: 'late'` and triggers `whatsapp.notifyLateArrival`. |
| **Absent** | 1 hour | If `now > shift_start + 2h` and no record exists, marks as `absent`. |
| **Auto-Checkout**| 5 min | Identifies records where `last_heartbeat_at < (now - 10m)`. Runs a full checkout logic using the heartbeat time as the effective checkout time. |
| **WhatsApp Nudge**| 1 min | For remote workers, sends "Morning/Midday/EOD" nudges. If no reply is received within 60 mins of a nudge, alerts the manager. |

---

## 7. How to Update/Create an API
1. **Model:** Update `prisma/schema.prisma` if data structure changes.
2. **Utils:** Check `src/utils/shift.ts` for timezone/time math helpers.
3. **Route:** Define the endpoint in the relevant file in `src/routes/`.
4. **Validation:** Use `ValidationError` for bad input.
5. **Side Effects:** If the action needs to notify someone, use `services/notifications` (In-app) or `services/whatsapp`.
6. **Documentation:** Add the new endpoint to the table in `API_DOCUMENTATION.md`.
