# Presence Tracking — How WiFi Auto Check-in/out Works

This document explains the full presence pipeline across the mobile app and
the API, including the doze-tolerance design that prevents phantom checkouts
when a phone's screen is off.

## The pipeline

```
 Flutter app (foreground service, 4-min cadence)
   │
   ├─ POST /attendance/ip-event  { ip, ssid, event: 'match' }
   │    server matches against org office_ips / office_ssids
   │    → checked_in | re_entered | already_in | none | no_networks_configured
   │
   └─ POST /attendance/heartbeat { ip, ssid }          (while checked in)
        → heartbeat_accepted (+ grace_mins) | not_on_office_network | not_checked_in

 API cron (every 5 min): Heartbeat Expiry Monitor
   records with last_heartbeat_at older than the org's
   heartbeat_grace_mins (default 20) → auto checkout
   (check_out_at = last heartbeat, auto_checked_out = true)
```

## The screen-off problem and its fix

Android Doze rate-limits background work to roughly **one wake per 9 minutes**
with the screen off, and OEM battery managers (Samsung, Xiaomi, Huawei…) can
suspend the foreground service entirely. The phone is still on office WiFi —
but its heartbeats stall. With the old fixed 10-minute expiry the server
would check the user out and, on the next successful ping, log the gap as an
"away" break. Users sitting at their desks saw phantom checkouts and breaks.

Three layers now prevent that:

### 1. Configurable grace window (server)
`organisations.heartbeat_grace_mins` (default **20**, min 10, max 120) replaces
the hardcoded 10-minute expiry. The expiry job evaluates each record against
its own org's window. The heartbeat ack returns `grace_mins`, so the mobile
client drives its disconnect-countdown UI from the same value.

### 2. Doze-gap forgiveness (server)
`organisations.gap_forgiveness_mins` (default **15**, 0 disables). When an
auto-checked-out user re-appears **on a registered office network** within
the forgiveness window, the record is stitched back together as if the
checkout never happened: no away break, no break-minute deduction, late
status preserved. The response carries `forgiven: true` so clients show
"brief signal drop" instead of "away logged as break". Longer gaps follow
the normal re-entry flow (away break logged, optionally counted against a
shift break policy).

### 3. Client hardening (mobile)
- The foreground service type is **`location` only**. The previous
  `dataSync|location` declaration was fatal on Android 15+: the `dataSync`
  type carries a hard 6-hour timeout that killed tracking mid-shift.
- `allowWakeLock` + `allowWifiLock` are enabled; battery-optimization
  exemption is requested during onboarding.
- The offline event queue (Hive) retains events for 12 hours (was 2), so
  same-day events survive long doze/offline stretches and replay on
  reconnect.

## Status & re-entry semantics

- Reopened records preserve their original `late` status (`late_minutes > 0`).
- `auto_checked_out: true` marks any server-initiated checkout; re-entry
  clears it.
- A re-entry response is `{ action: 're_entered', gap_mins, forgiven, warning }`.

## Tuning

| Setting | Default | Where | Effect |
|---|---|---|---|
| `heartbeat_grace_mins` | 20 | PUT /org/settings | How long without heartbeats before auto-checkout |
| `gap_forgiveness_mins` | 15 | PUT /org/settings | Same-network reconnects within this window are stitched silently |
| Client cadence | 4 min | `wifi_service.dart` | Heartbeat interval (foreground service) |

Recommended: grace ≥ 2× the worst-case doze wake interval (≈ 9 min) — hence 20.
Orgs with strict presence requirements can lower it; orgs with aggressive OEM
fleets (Xiaomi/Huawei) may want 30.

## FCM presence challenge (server half — shipped)

Before the heartbeat-expiry job auto-checks a user out, it gives the device
one last chance to prove presence via a high-priority FCM data message —
high-priority pushes punch through Android Doze even when normal background
work is suspended.

Flow, per expired record (grace window already elapsed):

1. If push is configured **and** the user has a registered `fcm_token`
   **and** no unanswered challenge exists for this record: send
   `{ type: 'presence_challenge' }` (data-only, `android.priority: high`),
   stamp `attendance_records.challenge_sent_at`, and **skip checkout this
   tick** (the job runs every 5 minutes — that is the device's grace tick).
2. The mobile app, woken by the push, runs its normal WiFi check and posts
   `POST /attendance/heartbeat`. A fresh heartbeat refreshes
   `last_heartbeat_at`, so the record drops out of the expired set —
   checkout cancelled. A heartbeat newer than `challenge_sent_at` marks the
   challenge as answered, so a *later* signal loss gets a fresh challenge.
3. If the challenge is 5+ minutes old and no heartbeat arrived, the checkout
   proceeds exactly as before (checkout at last heartbeat, breaks settled,
   `challenge_sent_at` cleared).

When Firebase is **not** configured, the whole layer is inert: the job
behaves exactly as documented above and a single startup log line notes that
challenges are disabled.

### Setup

1. Create a Firebase project and a service account
   (Project settings → Service accounts → Generate new private key).
2. Set the env var to the JSON key **as a string**:

   ```bash
   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"…","private_key":"-----BEGIN PRIVATE KEY-----\n…","client_email":"…"}'
   ```

3. The mobile client registers its token via
   `PUT /users/me/device-token` `{ "token": "<fcm-registration-token>" }`
   (authenticated; stored on `users.fcm_token` / `fcm_token_updated_at`).

Server pieces live in `src/services/pushChallenge.ts` (lazy firebase-admin
init, `isPushConfigured()`, `sendPresenceChallenge(userId)`) and the
heartbeat-expiry job in `src/jobs/scheduler.ts`. The mobile half (FCM wiring
+ answering the challenge from a killed app) is roadmap #24.

## Future hardening (researched, not yet implemented)

See `ATTENDANCE_RESEARCH.md` for the full analysis. The highest-value next
steps are:
1. AlarmManager-driven heartbeats (`setExactAndAllowWhileIdle`) as a floor
   under the in-process timer.
2. Mobile FCM wiring for the presence challenge (server half shipped — see
   above).
3. A per-OEM reliability-check screen in the app (dontkillmyapp patterns).
4. Heartbeat telemetry (`screen_on`, `battery_saver`, `device_model`) to
   drive adaptive grace windows.
