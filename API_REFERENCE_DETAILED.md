# Attenda Exhaustive API Reference (Detailed)

This document provides the exact technical contract for Frontend and Mobile developers.

---

## 1. Authentication Module (`/auth`)

### `POST /auth/register`
*   **Description:** Creates a new organisation and the first Super Admin user.
*   **Request (Body):**
    *   `org_name` (string): Name of the company.
    *   `name` (string): Admin's full name.
    *   `email` (string): Admin's email (used for login).
    *   `password` (string): Minimum 8 characters.
    *   `timezone` (string): e.g., "Asia/Karachi" or "America/New_York".
*   **Response (data):**
    *   `user`: Object containing `id`, `name`, `email`.
    *   `org`: Object containing `id`, `name`, `timezone`.

### `POST /auth/login`
*   **Description:** Authenticates user and returns JWT.
*   **Request (Body):**
    *   `email` (string)
    *   `password` (string)
*   **Response (data):**
    *   `access_token` (string): JWT (Expires in 8h).
    *   `refresh_token` (string): Long-lived token (30d).
    *   `user`: `{ id: string, name: string, role: string, org_id: string }`
    *   `requires_2fa` (boolean): If `true`, the tokens above will be null; you must call `/2fa/authenticate` next.

---

## 2. Attendance Module (`/attendance`)

### `GET /attendance/today-status`
*   **Description:** The primary "source of truth" for the mobile dashboard.
*   **Request:** None (Header: Bearer Token).
*   **Response (data):**
    ```json
    {
      "shift": {
        "id": "uuid",
        "name": "string",
        "start_time": "HH:MM",
        "end_time": "HH:MM",
        "breaks": [
          {
            "id": "uuid",
            "name": "string",
            "break_minutes": number,
            "is_paid": boolean,
            "start_time_utc": "ISO Date",
            "end_time_utc": "ISO Date",
            "break_state": "upcoming | active | done"
          }
        ]
      },
      "attendance": {
        "id": "uuid",
        "status": "in | out | late | absent | remote",
        "check_in_at": "ISO Date | null",
        "check_out_at": "ISO Date | null",
        "late_minutes": number,
        "net_hours_worked": float
      },
      "server_time": "ISO Date"
    }
    ```

### `POST /attendance/checkin`
*   **Description:** Performs check-in based on location or QR.
*   **Request (Body):**
    *   `type` (string): `"manual" | "qr" | "remote" | "auto_ip"`.
    *   `qr_code` (string, optional): Required if type is "qr".
    *   `device_ssid` (string, optional): Used for WiFi verification.
    *   `lat` / `lng` (number, optional): For geofencing validation.
*   **Response (data):** The created `AttendanceRecord` object.

### `POST /attendance/checkout`
*   **Description:** Ends the shift.
*   **Request (Body):**
    *   `force` (boolean, optional): If `true`, ignores open break warnings.
*   **Response (data):**
    *   `id`: "uuid"
    *   `check_out_at`: "ISO Date"
    *   `hours_worked`: float (Gross hours)
    *   `net_hours_worked`: float (Actual payable hours)
    *   `adherence_score`: number (0-100)

---

## 3. Shifts & Scheduling (`/shifts`)

### `POST /shifts`
*   **Description:** Creates a shift template.
*   **Request (Body):**
    *   `name` (string)
    *   `start_time` (string): "HH:MM" format.
    *   `end_time` (string): "HH:MM" format.
    *   `active_days` (number[]): Array of integers 0-6 (0=Sun, 1=Mon).
    *   `is_org_wide` (boolean): Default false.
    *   `is_default` (boolean): Default false.
*   **Response (data):** The created `Shift` object.

### `POST /shifts/assignments/bulk`
*   **Description:** Assigns shifts to multiple users.
*   **Request (Body):**
    *   `user_ids` (string[]): Array of User UUIDs.
    *   `shift_id` (string): Shift UUID.
    *   `dates` (string[]): Array of date strings "YYYY-MM-DD".
*   **Response (data):**
    ```json
    {
      "created": number,
      "skipped": number,
      "warnings": [
        { "user_id": "uuid", "date": "string", "type": "leave_overlap | off_day" }
      ]
    }
    ```

---

## 4. Leaves (`/leave`)

### `POST /leave/requests`
*   **Description:** Submit a leave application.
*   **Request (Body):**
    *   `leave_type` (string): `"annual" | "sick" | "unpaid" | "casual"`.
    *   `start_date` (string): "YYYY-MM-DD".
    *   `end_date` (string): "YYYY-MM-DD".
    *   `is_half_day` (boolean): Default false.
    *   `half_day_period` (string, optional): `"morning" | "afternoon"`.
    *   `reason` (string, optional).
*   **Response (data):** The `LeaveRequest` object with `status: "pending"`.

---

## 5. Payroll (`/payroll`)

### `POST /payroll/generate`
*   **Description:** Pre-calculate payroll for a month.
*   **Request (Body):**
    *   `month` (number): 1-12.
    *   `year` (number): e.g., 2026.
*   **Response (data):**
    *   `count`: number (Total records generated).
    *   `incomplete`: number (Records requiring HR review due to missing hourly rates).

---

## 6. Detailed Data Types Reference

| Type | Format | Example |
| :--- | :--- | :--- |
| **UUID** | string (36 chars) | `550e8400-e29b-41d4-a716-446655440000` |
| **ISO Date** | string (ISO-8601) | `2026-06-05T09:00:00.000Z` |
| **HH:MM** | string (24h) | `14:30` |
| **Decimal** | number (float) | `8.50` |
| **JSON** | object | `{"key": "value"}` |

---

## 7. Global Sidebar: Error Response Types
All APIs return a `4xx` or `5xx` status code with this body on failure:
```json
{
  "success": false,
  "error": "Short human-readable message",
  "code": "TECHNICAL_ENUM_CODE",
  "details": [ ... ] // Optional array of validation errors
}
```
**Common Codes:** `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`.
