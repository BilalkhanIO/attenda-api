# Attenda Research Report: Attendance Check-in Methods, Android Screen-off Reliability, Policy Features, and Dependency Versions

**Date:** 2026-06-10
**Context:** Attenda — Node/Express/Prisma/Postgres API, Next.js 16 web, Flutter Android app. Current design: WiFi-based auto check-in via persistent foreground service (`flutter_foreground_task`, `AttendaTaskHandler` isolate firing every 4 minutes), `POST /attendance/ip-event` + `POST /attendance/heartbeat`, server auto-checkout after 10 minutes without a heartbeat, Hive offline queue, VPN blocking.

**Verification note:** Web search and registry lookups (npmjs.org, pub.dev API) were available and used. Package versions in §6 were verified directly against registries on 2026-06-10. Android API behavior claims are sourced from developer.android.com / source.android.com and corroborating engineering posts; a small number of fine-grained API details (marked "from Android API docs, not re-verified live") rely on well-established documentation knowledge where live fetches returned only index pages.

---

## 1. Industry-standard check-in/out approaches

Survey of Deputy, When I Work, Connecteam, Jibble, Clockify, Hubstaff, Keka, Rippling. The clear industry pattern: **no leading product relies on a single passive signal**. They layer (a) an *event* (a punch — tap, QR, face, NFC), (b) a *verification* (GPS/geofence/WiFi/selfie), and (c) *exception review* for managers. Fully passive presence (your current model) is rare as the *only* mechanism precisely because of the Android reliability problems in §2.

### 1.1 GPS + Geofence (the de facto standard)
**Who:** Deputy, Connecteam, Jibble, Hubstaff, Timeero, Keka, Rippling — essentially everyone.
**How it works:** Admin draws a radius (typically 100–250 m) around a site. Two flavors:
- *Punch validation* (most common): employee taps "clock in"; the app captures a GPS fix and accepts/flags/blocks the punch if outside the fence. Deputy captures GPS at clock-in and clock-out with optional geofence enforcement ([Jibble's Deputy review](https://www.jibble.io/reviews/deputy)).
- *Auto clock-in/out on fence crossing* (Hubstaff Geofence Time Clock, Timeero, Connecteam): the app registers a geofence with the OS and clocks in/out (or prompts) on enter/exit ([Hubstaff geofence](https://hubstaff.com/features/geofence_time_clock)).

**Android constraints:** `ACCESS_FINE_LOCATION` + — for background fence transitions — `ACCESS_BACKGROUND_LOCATION`, which requires a separate "Allow all the time" settings flow and a Play Store declaration. The platform `GeofencingClient` is OS-managed (survives Doze better than your own timer) but transition latency can be 2–15 min, and OEM battery managers still delay callbacks. GPS indoors is poor (often 30–100 m error), which is why office-based products pair it with WiFi.
**Pros:** Works anywhere, well-understood by users, OS-assisted. **Cons:** indoor inaccuracy, spoofable (mock-location apps — Hubstaff/Timeero detect mock locations), privacy perception, background-location review friction on Play.

### 1.2 WiFi network validation (your current approach)
**Who:** Buddy Punch ("WiFi punch" — can only punch on company WiFi), Truein, Keka (WiFi/IP-based attendance), Jibble (network restriction), several kiosk products. Buddy Punch describes it as: employees can only punch in/out when connected to business WiFi ([Buddy Punch](https://buddypunch.com/blog/mobile-time-clock-app/)).
**Crucial difference from Attenda:** these products use WiFi as a **punch-time validator** (or as a passive *assist*), not as the sole continuous-presence signal with server-side auto-checkout on heartbeat loss.
**Android constraints (severe, and growing):**
- Reading SSID/BSSID (`network_info_plus`) requires fine location permission **and location services enabled**; on Android 10+ the SSID is `<unknown ssid>` otherwise.
- Background SSID reads are throttled; with screen off and Doze active, WiFi may power-save or the device may even drop WiFi (OEM "WiFi sleep" policies).
- A safer signal than SSID is "is the device's egress IP in the office range" — which your `/attendance/ip-event` server check already leverages; that works regardless of SSID permission but breaks behind VPNs/CGNAT (you already block VPN).
**Pros:** zero-effort for employees, precise to the building, cheap. **Cons:** the entire §2 problem set; MAC randomization; guest-network/NAT ambiguity; phone-on-desk ≠ person-at-desk.

### 1.3 BLE beacons
**Who:** Timeero (beacon add-on), several enterprise systems; less common in the SMB products surveyed.
**How:** iBeacon/Eddystone transmitters in the office; the app ranges/monitors beacon UUIDs. Android lets you register beacon scans with the OS (`BluetoothLeScanner` with `ScanFilter` + `PendingIntent`), which **wakes the app on detection even when the process is dead** — materially better than self-timed WiFi polling.
**Android constraints:** `BLUETOOTH_SCAN` (Android 12+, with `neverForLocation` flag if appropriate), battery cost of continuous ranging (mitigated by OS-batched scans). Hardware cost ~$10–30/beacon.
**Pros:** room-level accuracy, OS-wakeup semantics solve part of the screen-off problem, works without internet. **Cons:** hardware deployment, beacon battery maintenance, still proves *phone* presence, not *person* presence.

### 1.4 QR / kiosk
**Who:** Connecteam (kiosk mode with PIN/selfie), Deputy (kiosk with PIN + facial recognition), Jibble (free kiosk), Rippling ("touchless experience via QR code" — [Rippling](https://www.rippling.com/blog/tracking-employee-attendance)), Clockify (kiosk with PIN).
**How:** A tablet at the entrance runs kiosk mode; employees punch by PIN, face, or by scanning a rotating QR with their phone (or the kiosk scans a QR from the employee app). Rotating/TOTP-style QR codes defeat photo-of-the-code fraud.
**Android constraints:** trivial — the kiosk device is plugged in, screen on, exempt from every problem in §2. Employee-phone QR scanning needs only camera permission.
**Pros:** extremely reliable, deliberate act (legally clean punch time), cheap (one old tablet), buddy-punch resistant when paired with selfie/PIN. **Cons:** queueing at shift start, doesn't capture early departures unless punching out is enforced, hardware at every entrance.
**Note:** Attenda already has a `/attendance/qr` overlay route — extending this to a rotating-QR kiosk flow is a small step.

### 1.5 NFC
**Who:** Jibble (NFC clock-in is in its free tier — [Connecteam's Jibble review](https://connecteam.com/reviews/jibble/)), Connecteam, several EU products (NFC is popular where face capture is GDPR-sensitive).
**How:** NTAG stickers at entrances; employee taps phone to tag, app reads tag ID (optionally with rolling counter on NTAG 424 to prevent cloning) and punches.
**Android constraints:** minimal — NFC reading works with screen on; foreground dispatch is simple. ~10–15% of low-end Androids lack NFC.
**Pros:** sub-second, deliberate, cheap (<$1/tag), offline-capable. **Cons:** clonable unless using dynamic tags; requires the tap (no passive presence).

### 1.6 Face verification / selfie capture
**Who:** Jibble (AI facial recognition auto-verifies at clock-in, free tier), Deputy (touchless face on kiosk), Connecteam (selfie on shared-device punches), Truein, Keka (selfie attendance with face match — [Keka GPS/Mobile attendance](https://www.keka.com/gps-mobile-attendance)), Rippling (selfie requirement option).
**How:** Two tiers: (a) *selfie capture* — store the photo on the punch for manager spot-checks; (b) *face match* — on-device or server model compares against enrollment photo. Liveness detection defeats photo replay.
**Android constraints:** camera permission only; on-device matching via ML Kit face detection + an embedding model is feasible on mid-range hardware.
**Pros:** kills buddy punching (the #1 fraud vector), strong audit trail. **Cons:** biometric-privacy law exposure (Illinois BIPA, GDPR Art. 9 — EU products often require explicit consent and offer PIN fallback), lighting/mask failure modes.

### 1.7 What the competitive set implies for Attenda
1. **Keep WiFi auto-presence as a convenience layer, but add a deliberate punch path** (QR kiosk or geofenced manual punch) as the *legal* time record. Passive presence then enriches/validates rather than solely determining pay-relevant events.
2. **Selfie-on-first-punch** is the cheapest fraud control with the highest perceived rigor.
3. Every surveyed product treats anomalies as **flags for manager review**, not silent auto-corrections — Attenda's auto-checkout should follow suit (see §2.9).

---

## 2. The Android screen-off problem

### 2.1 What actually happens to Attenda's 4-minute heartbeat when the screen goes off

Chain of failures, in order of onset:

1. **Screen off, device still active (0–30 min):** WiFi may enter power-save polling; your Dart timer in the `flutter_foreground_task` isolate generally still fires. Mostly OK.
2. **Doze "light" then "deep" (stationary, unplugged, screen off ~30 min+):** the system restricts **network access and defers jobs/syncs/standard alarms** ([Doze & App Standby docs](https://developer.android.com/training/monitoring-device-state/doze-standby)). A foreground service gives meaningful protection (the app stays out of the cached/frozen bucket and FGS is exempted from many Doze network restrictions), **but it is "a privilege, not a loophole"** — OEM layers and WiFi power policy still apply ([ProAndroidDev: Beyond Doze](https://proandroiddev.com/beyond-doze-building-reliable-background-execution-on-modern-android-including-oem-realities-5fa0a6e05672)). Doze maintenance windows mean your 4-minute cadence can stretch to 15–60+ min gaps even when the timer "fires" — the network call blocks or fails.
3. **OEM battery managers (the dominant real-world killer):** Xiaomi/MIUI, Samsung, Huawei, OnePlus, Oppo/Vivo aggressively kill or freeze foreground services that the user hasn't manually whitelisted. Samsung "kills background processes and renders alarm clocks and apps relying on background processing useless" without per-app exemption; Xiaomi requires Autostart + "No restrictions" battery settings ([dontkillmyapp.com](https://dontkillmyapp.com/), [/xiaomi](https://dontkillmyapp.com/xiaomi), [/samsung](https://dontkillmyapp.com/samsung)). **This is why "user left at 14:32" reports appear for users sitting at their desks.**
4. **Result:** server sees ≥10 min without heartbeat → auto-checkout → false "departed" record → payroll dispute.

### 2.2 Foreground service types (Android 14/15/16 rules)

Android 14+ **requires** `android:foregroundServiceType` on the service declaration; flutter_foreground_task 9.x exposes this in config ([pub.dev/flutter_foreground_task](https://pub.dev/packages/flutter_foreground_task)). Choice matters a lot now:

| Type | Timeout | Fit for Attenda | Notes |
|---|---|---|---|
| `dataSync` | **Hard 6 h / 24 h limit on Android 15+** — system calls `Service.onTimeout()`, you must `stopSelf()` within seconds or get an ANR-class failure ([FGS timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout)) | **Unsuitable** — a workday is 8–9 h | Timer resets when user foregrounds the app, but you can't rely on that. Also cannot be launched from `BOOT_COMPLETED` on 15+. |
| `location` | **No automatic timeout** | **Best fit** | Requires location permission (which you already need for SSID reads) + `FOREGROUND_SERVICE_LOCATION`. Honest framing: the service *does* determine workplace presence from network location. Play review requires a prominent disclosure for background location. |
| `connectedDevice` | No automatic timeout | Defensible only if you adopt BLE beacons or actively manage a WiFi connection; Play policy reviews this type's justification | Used by wearable/IoT apps. |
| `specialUse` | No timeout; requires Play declaration of the use case | Fallback if `location` framing fails review | Google is increasingly strict here. |

**Recommendation:** declare `location` (primary). If you add BLE beacons, `connectedDevice` becomes legitimately accurate. Audit what flutter_foreground_task currently has in your `AndroidManifest.xml` — if it's `dataSync`, Android 15 devices will start killing the service mid-shift with `onTimeout`.

### 2.3 WifiLock: LOW_LATENCY vs HIGH_PERF — the trap

- `WIFI_MODE_FULL_HIGH_PERF` (API 12): keeps WiFi active at high performance "**even when the device screen is off**" ([WifiManager docs mirror](http://marpol.i234.me/android_sdk_doc/reference/android/net/wifi/WifiManager.html)). *From Android API docs (not re-verified live):* deprecated at API 34, where it is treated the same as low-latency mode.
- `WIFI_MODE_FULL_LOW_LATENCY` (API 29): optimizes for latency, **but is only honored while the acquiring app is in the foreground and the screen is ON**; the lock silently degrades when the screen turns off (*from the WifiLock API docs and the [AOSP low-latency mode doc](https://source.android.com/docs/core/connect/wifi-low-latency); not re-verified live — confirm against current docs before relying on it*).

**Implication:** for a screen-off heartbeat use case, LOW_LATENCY is the *wrong* lock despite being the newer API. On devices ≤ API 33 prefer HIGH_PERF semantics; on API 34+ the deprecation means WifiLock alone no longer guarantees screen-off WiFi performance, so pair it with the strategies below and treat WifiLock as best-effort. `flutter_foreground_task` exposes `allowWifiLock: true` (plus `allowWakeLock` for a partial wakelock) in `ForegroundTaskOptions` — enable both ([pub.dev](https://pub.dev/packages/flutter_foreground_task)).

Also note the policy trend: guidance circulating for 2026 suggests Play vitals now penalize apps holding wakelocks/wifilocks for very long cumulative durations (one source cites pressure to keep holds under ~2 h/day; treat the exact threshold as unverified — [copyprogramming summary](https://copyprogramming.com/howto/wifilock-and-wakelock-not-working-correctly-on-android)). Prefer **acquiring locks briefly around each heartbeat** (acquire → check → POST → release) over holding them all day.

### 2.4 Partial wakelocks
`PowerManager.PARTIAL_WAKE_LOCK` keeps the CPU running with screen off. Within a foreground service it's legitimate. Same pattern: hold only across the heartbeat work (a 5–15 s window), with a timeout on acquire so a bug can't pin the CPU. flutter_foreground_task's `allowWakeLock` holds one for the service's lifetime — fine for reliability, but watch Play vitals "excessive wakeups/partial wakelock" metrics; the acquire-around-work model is the modern best practice.

### 2.5 AlarmManager as the heartbeat scheduler (replace the Dart timer)

The single highest-impact client change: **don't trust an in-process timer under Doze; use OS alarms to drive each heartbeat.**

- `setExactAndAllowWhileIdle()`: fires even in Doze, **but is rate-limited to once per ~9 minutes per app in deep Doze**, and "exact" really means "as nearly as possible" ([Igor Dias on AlarmManager](https://medium.com/@igordias/android-scheduling-alarms-with-precise-delivery-time-using-alarmmanager-75c409f3bde0), [Schedule alarms docs](https://developer.android.com/develop/background-work/services/alarms)). When it fires, the app gets ~10 s on the temporary power allowlist — enough for one HTTP POST. **Consequence: a 4-minute cadence is impossible in deep Doze; 9–10 minutes is the floor.** This interacts directly with your 10-minute server window (see §2.9).
- `setAlarmClock()`: the strongest option — flagged `FLAG_WAKE_FROM_IDLE` + `FLAG_STANDALONE`, never batched, wakes the device from idle, no 9-minute throttle ([same sources](https://medium.com/@avidraghav/simplifying-alarmmanager-understanding-alarm-scheduling-in-android-bde954b6f346)). Cost: it surfaces an alarm-clock icon/indicator to the user and is intended for user-visible alarms; using it for a 4-min heartbeat is policy-gray and battery-hostile. Reasonable as an *escalation* (e.g., one `setAlarmClock` shortly before the server deadline if recent heartbeats failed), not the steady-state scheduler.
- Permissions: exact alarms need `SCHEDULE_EXACT_ALARM` (user-revocable, request via `openAlarmsAndRemindersSettings()` — flutter_foreground_task ships this helper) or `USE_EXACT_ALARM` (auto-granted but Play restricts it to alarm/calendar apps — **do not use** for Attenda) ([alarms docs](https://developer.android.com/develop/background-work/services/alarms)).

### 2.6 WorkManager / JobScheduler as the safety net
- WorkManager periodic work has a 15-minute minimum and is deferred in Doze — **not** a heartbeat mechanism, but the right tool for: replaying the Hive offline queue, daily reconciliation sync, and re-starting the foreground service if it died ([softaai: surviving Doze](https://softaai.com/building-resilient-android-apps-surviving-doze-standby/)).
- Expedited work (`setExpedited`) runs ASAP with foreground-like treatment but quotas apply and it's still deferred in deep Doze; use it for "connectivity just came back, flush the queue now."
- `JobScheduler` with `NetworkType.UNMETERED`/connectivity constraints gives you OS-triggered execution on network changes even if the process was dead — a good backstop to `connectivity_plus` (which only works while the process lives).
- **FCM high-priority push** is the one channel designed to punch through Doze ([Doze docs](https://developer.android.com/training/monitoring-device-state/doze-standby)). Server-side "are you still there?" pings via FCM high-priority data messages, sent when heartbeats stop, let the device respond from Doze before you auto-checkout. (High-priority quota is enforced if the user doesn't engage — use sparingly, e.g., max 2 pings per pending checkout.)

### 2.7 Battery-optimization exemption + OEM allowlisting (the unavoidable UX)
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` → `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` dialog. Play permits this for apps whose **core function** breaks under Doze — a workplace-presence app qualifies, but write the declaration carefully. flutter_foreground_task ships `requestIgnoreBatteryOptimization()` ([pub.dev](https://pub.dev/packages/flutter_foreground_task)).
- Exemption from Doze ≠ exemption from OEM killers. Per [dontkillmyapp.com](https://dontkillmyapp.com/): Xiaomi needs Autostart enabled + Battery saver "No restrictions"; Samsung needs the app removed from "Sleeping apps"/"Deep sleeping apps" and "Put unused apps to sleep" disabled for it; Huawei needs "Manage manually" launch settings. **Best practice (used by Tasker, Sleep as Android, home-automation apps): an in-app "Reliability check" screen** that detects the manufacturer, deep-links into the right OEM settings page, and shows a live status ("Last background heartbeat succeeded 3 min ago ✓"). Libraries like `disable_battery_optimization` / `dontkillmyapp`-style helper flows exist for Flutter; even a hand-rolled manufacturer switch covering Xiaomi/Samsung/Huawei/OnePlus covers >80% of problem devices.
- Detect-and-coach: if the app process observes it was killed (e.g., service restart counter, or server tells the app "you went silent yesterday at 15:02"), show a card: "Your phone stopped Attenda in the background yesterday — fix settings."

### 2.8 flutter_foreground_task specifics (v9.2.2)
Confirmed current options relevant to you ([pub.dev](https://pub.dev/packages/flutter_foreground_task)): `ForegroundTaskOptions(eventAction: ForegroundTaskEventAction.repeat(ms) | .once() | .nothing())`, `allowWakeLock`, `allowWifiLock`, two-way isolate messaging (`sendDataToMain`/`sendDataToTask` — you already use the former), `requestIgnoreBatteryOptimization()`, `openAlarmsAndRemindersSettings()`, Android 14 `foregroundServiceType` declaration support, and explicit README warnings about the Android 15 dataSync 6-hour cap and `BOOT_COMPLETED` restrictions. The package's `repeat()` is a Handler-based timer — subject to Doze deferral exactly like your current setup; the recommended architecture is `eventAction: nothing` + AlarmManager-driven invocations, or keep `repeat()` as the optimistic path with AlarmManager as the guaranteed-floor path.

### 2.9 Server-side mitigations (do these regardless of client work)

This is where presence systems win or lose; chat-presence architecture transfers directly ([heartbeat presence design](https://medium.com/@onakoyak/real-time-reliability-using-client-server-heartbeats-to-ensure-consistent-online-status-in-a-chat-429ae3c2d94a)):

1. **N consecutive missed heartbeats, not a wall-clock deadline.** Require ≥3 consecutive misses *and* elapsed > grace before acting. With a 4-min cadence and 10-min window you currently tolerate ~1.5 misses — far too tight given the 9-minute Doze alarm floor (§2.5). **Minimum viable fix: raise the grace window to 20–30 min** (3–5 missed beats at a Doze-realistic cadence).
2. **Adaptive grace windows.** Widen the window when context says "asleep, not gone": last heartbeat carried `screen_off: true` or `battery_saver: true` or `doze_bucket` telemetry → 30–45 min; screen-on, charging, active → 10 min is fine. Also widen automatically per-device for models with poor track records (you'll see it in your data: Xiaomi/Redmi devices missing beats at 10x the rate of Pixels).
3. **Soft-checkout state machine.** `checked_in → presence_stale (heartbeats missed) → auto_checked_out (grace expired) → reconciled`. `presence_stale` is invisible to payroll; only `auto_checked_out` ends the work segment, and it must be **provisional + flagged**, never silently final.
4. **Gap forgiveness / reconciliation on reconnect.** When the device reconnects and the **first event is another `match` on the same office network** (same BSSID/SSID/egress IP as the pre-gap heartbeat), infer "device slept on premises": stitch the gap, delete or amend the provisional checkout, and log a `gap_reconciled` audit event. Cap stitchable gap length by policy (e.g., ≤ 60–90 min auto-stitch; longer → manager review). If the reconnect comes from a *different* network (home WiFi, cellular), the departure was real — keep the checkout and backdate it to `last_heartbeat + grace/2` or last-known-good.
5. **Client-assisted reconciliation.** On reconnect, have the client upload its local evidence: the Hive queue already stores failed events with timestamps — extend it to also record *successful local WiFi observations that couldn't be sent*. "I saw OfficeSSID at 14:36, 14:40, 14:44 but POSTs failed" is exactly the proof the server needs to stitch. (Your 2-hour queue-expiry should be raised to cover a full shift for this evidence class.)
6. **FCM challenge before checkout.** When entering `presence_stale`, send a high-priority data push: device wakes (Doze-exempt path), checks WiFi, replies. Only if the challenge goes unanswered do you proceed to auto-checkout.
7. **Distinguish event types in the record.** `checkout_reason: manual | heartbeat_timeout | network_left | end_of_day` — and surface `heartbeat_timeout` checkouts in a manager exception queue (industry norm per §1.7) and in the employee's own timeline with one-tap "I was here" dispute → manager approval.
8. **End-of-day sweep:** auto-close any still-open session at shift end + buffer with `end_of_day` reason rather than leaving phantom 16-hour sessions when a phone dies.

---

## 3. Late/absence handling — what good products do

Sources: [Timeero attendance-policy guide](https://timeero.com/post/employee-attendance-policy), [Indeed attendance policies](https://www.indeed.com/hire/c/info/attendance-policies), [greytHR policy template](https://www.greythr.com/downloadable-resource/attendance-policy/), [CurrentWare template](https://www.currentware.com/blog/employee-attendance-policy-template/).

- **Grace periods:** 5–7 minutes is the most common US hourly norm; 5–15 min overall range. Make it **configurable per org/shift**, and apply it to *status classification only* — the actual punch timestamp is recorded raw (legal requirement in many jurisdictions; also matches your existing raw-event design).
- **Late tiers:** classify beyond the grace window, e.g. `on_time` (≤ grace) → `late` (grace–15 min) → `very_late` (15–30) → `half_day` / points. Indian-market products (greytHR, Keka) commonly auto-convert repeated lateness to leave deductions ("late >15 min on 3 days in a month → ½ day leave"); US products prefer **points systems** (late = 0.5 pt, no-call-no-show = 4 pts; thresholds trigger warnings).
- **Pattern clauses:** good systems detect patterns that never cross point thresholds — "3 tardies in any rolling 30 days triggers a written warning regardless of points" (closes the every-Monday-late loophole) ([CurrentWare](https://www.currentware.com/blog/employee-attendance-policy-template/)).
- **Notice workflows:** "reported late" ≠ "unreported late." An employee who flags lateness in-app before shift start (with reason) gets a lighter/no penalty; the app should offer a "Running late" quick action that notifies the manager. Call-out deadlines (e.g., ≥ 2 h before shift) belong in policy config.
- **Auto-absence marking:** standard pattern — if no check-in by `shift_start + threshold` (commonly half the shift, or a fixed 2–4 h), mark **provisional absent**, notify employee + manager, and let leave requests retroactively convert it (`absent → on_leave`). Never finalize automatically same-day; run a nightly job that finalizes yesterday's statuses after the leave-request cutoff.
- **Consistency requirement:** the written policy numbers must exactly match system configuration (grace, rounding, call-out deadlines) — auditability is a selling point ([fieldservicely guide](https://www.fieldservicely.com/employee-attendance-policy)).

**For Attenda:** add an org-level policy object (`grace_min`, late tier boundaries, points map, pattern rule, auto-absent threshold, call-out deadline) consumed by a nightly classification job; surface a manager exception queue. Your `StatusColors` already maps `'late'`/`'absent'` — the gap is the policy engine, not the UI.

## 4. Break management

Sources: [ADP on rest-break compliance](https://www.adp.com/spark/articles/2025/12/compliance-in-action-how-time-tracking-software-helps-with-rest-break-compliance.aspx), [Timeero California break compliance](https://timeero.com/post/california-break-law-compliance-timeero), [DATABASICS CA tracking](https://blog.data-basics.com/timesheet-automation-can-solve-californias-meal-and-break-tracking-laws), [calaborlaw charts](https://www.calaborlaw.com/california-meal-break-law-for-employees/), [EU WTD](https://employment-social-affairs.ec.europa.eu/policies-and-activities/rights-work/labour-law/working-conditions/working-time-directive_en).

- **Manual breaks (punch out/in) are the compliance-safe default.** Auto-deduction ("subtract 30 min from any 6h+ shift") is widespread in payroll-lite tools but is a litigation magnet: if an employee worked through lunch, the deduction creates unpaid work time. Best-practice middle ground: **auto-deduct only with employee attestation** — at the next punch the employee confirms "I took my 30-min meal break" or flags "I worked through it," which blocks the deduction and flags the manager ([epay systems](https://www.epaysystems.com/time-tracking-features-meal-breaks/), [DATABASICS](https://blog.data-basics.com/timesheet-automation-can-solve-californias-meal-and-break-tracking-laws)).
- **California rules (the strictest common template):** ≥ 30-min unpaid, off-duty meal break **before the end of the 5th hour** for shifts > 5 h; second meal break before end of 10th hour for shifts > 10 h; paid 10-min rest break per 4 h "or major fraction thereof"; missed/late/short meal → **1 hour premium pay** per day per violation type ([calaborlaw](https://www.calaborlaw.com/california-meal-break-law-for-employees/), [California Employment Law Report](https://www.californiaemploymentlawreport.com/2025/09/five-compliance-reminders-on-meal-and-rest-breaks-to-protect-against-costly-claims/)). Good software **proactively notifies before the 5th hour** ("take your meal break in the next 20 minutes") and auto-computes premiums into payroll exports ([Timeero](https://timeero.com/post/california-break-law-compliance-timeero)).
- **EU rules:** ≥ 20-min uninterrupted break when the working day exceeds 6 h; 11 h consecutive daily rest; 24 h weekly rest (or 48 h/fortnight); 48-h average max week; plus the 2019 ECJ ruling requiring an "objective, reliable and accessible" working-time recording system ([EU WTD](https://employment-social-affairs.ec.europa.eu/policies-and-activities/rights-work/labour-law/working-conditions/working-time-directive_en), [Toggl on the ECJ ruling](https://toggl.com/blog/eu-mandatory-time-tracking)). Member states gold-plate these (e.g., Germany: 30 min after 6 h, 45 min after 9 h) — so keep rules data-driven per jurisdiction, not hard-coded.
- **Paid vs unpaid:** model `break_type {meal_unpaid, rest_paid, custom}`; paid breaks stay inside the work segment for pay math, unpaid breaks split it. Rounding of break durations is another lawsuit vector — store raw, round only at the pay-export layer per policy.
- **Reminders:** push at configurable offsets (CA: before 5th hour; EU: at 6 h), escalate to the manager if no break is taken. Note interplay with Attenda's WiFi model: an unpaid off-premises lunch looks identical to a heartbeat gap — break state must **suspend the auto-checkout state machine** (employee on break → no `presence_stale` escalation).

## 5. Shift scheduling

Sources: [Deputy scheduling](https://www.deputy.com/features/scheduling-software), [Deputy shift swapping](https://www.deputy.com/features/shift-swapping), [Workforce.com shift swaps](https://www.workforce.com/software/shift-swapping), [Evolia](https://evolia.com/shift-swaps-software/), [Factorial roundup](https://factorialhr.com/blog/best-shift-scheduling-software/), [gitnux bidding software](https://gitnux.org/best/schedule-bidding-software/).

- **Draft → validate → publish → notify lifecycle:** schedules are built in draft, run through rule validation, then *published* — publishing is the event that pushes notifications and makes shifts visible. Unpublished edits never notify. Track acknowledgment ("seen/confirmed") per employee; some jurisdictions' fair-workweek laws require advance-notice windows (e.g., 14 days) with predictability-pay penalties for late changes — make publish-lead-time a tracked metric.
- **Open shifts:** manager publishes an unassigned shift to an eligible pool (role/skill/site-filtered); employees claim, first-come or manager-confirmed. The standard mechanism for coverage gaps.
- **Shift bidding:** employees submit bids on posted openings; rules rank by seniority/hours-balance/skill ([gitnux](https://gitnux.org/best/schedule-bidding-software/)). Mostly enterprise/union; lower priority for SMB.
- **Swap marketplace:** employee offers a shift; qualified colleagues accept; manager approval configurable (auto-approve if rule-clean is the modern default — Deputy supports both). Validation must re-run at accept time: qualification match, overtime impact, rest-period conflicts ([Deputy](https://www.deputy.com/features/shift-swapping), [Workforce.com](https://www.workforce.com/software/shift-swapping)).
- **Availability & preferences:** recurring weekly availability + date-specific exceptions + max-hours preferences; the scheduler treats availability as hard constraint, preferences as soft.
- **Conflict/rest validation (the compliance core):** pre-publish checks for double-booking, min rest between shifts (EU: 11 h; "clopening" bans), max consecutive days, weekly-hour caps, minor-labor rules; violations flagged **before** publishing ([SafetyCulture](https://safetyculture.com/apps/shift-management-software), [Virto](https://www.virtosoftware.com/shift-scheduling/shift-scheduling-software/)).
- **Demand-based auto-scheduling:** Deputy and peers generate schedules from demand signals (sales/foot traffic) + availability + compliance rules. High effort; current products market "AI scheduling" but the core is constraint solving. Defer until the manual lifecycle exists.
- **Attendance integration (relevant to Attenda's core):** shifts give the late/absence engine (§3) its reference times, give auto-checkout an "expected end" (§2.9 sweep), and enable no-show alerts ("shift started 15 min ago, no check-in") — the single most valuable scheduling feature for an attendance-first product.

---

## 6. Dependency versions — verified against registries 2026-06-10

### Node/web (npm `latest` dist-tags, fetched live)

| Package | Latest | Notes / within-major risks |
|---|---|---|
| express | **5.2.1** | 5.x line stable. If still on 4.x: v5 removed callback-style API, changed `req.query` to a getter (non-writable), path-route syntax changes (`path-to-regexp@8`: no regex in strings, `:name` required), async error forwarding now built-in. Within-5.x bumps low-risk. |
| prisma / @prisma/client | **7.8.0** | **Major-7 migration is significant**: Rust-free `prisma-client` generator is default; `prisma.config.ts` required (DATABASE_URL moves out of schema); generated client output path mandatory (no more node_modules generation); ESM output; **driver adapters required** (`@prisma/adapter-pg` for Postgres); enum `@map` behavior changes flagged as a migration blocker for some schemas ([upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [7.0 announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0), [issue #28599](https://github.com/prisma/prisma/issues/28599)). Within-7.x: watch changelogs, the new client is young — pin minor and test query behavior on upgrade. |
| next | **16.2.9** | Within-16.x bumps are generally safe, but per the repo's own AGENTS.md: **this Next.js diverges from training data — read `node_modules/next/dist/docs/` before writing code.** Turbopack interplay with Prisma 7 has a documented fix path ([buildwithmatija](https://www.buildwithmatija.com/blog/migrate-prisma-v7-nextjs-16-turbopack-fix)). |
| react | **19.2.7** | 19.x stable; within-major safe. |
| axios | **1.17.0** | Still 1.x; frequent small CVE-fix releases — keep current; low breakage risk within 1.x. |
| tailwindcss | **4.3.0** | v4 is CSS-first config (`@theme`), no `tailwind.config.js` by default, new `@tailwindcss/postcss`/Vite plugin. Within-4.x low risk. |

### Flutter (pub.dev `latest`, fetched live)

| Package | Latest | Notes / within-major risks |
|---|---|---|
| flutter_foreground_task | **9.2.2** (2026-04-01) | 9.x added Android 14 service-type declarations and Android 15 timeout handling. **Within-9.x is safe; the action item is config, not version:** verify `foregroundServiceType` ≠ `dataSync` (§2.2). Historically this package makes breaking API changes at majors (8→9 changed init/options APIs) — read CHANGELOG on any major bump. |
| connectivity_plus | **7.1.1** (2026-04-10) | v6+ returns `List<ConnectivityResult>` (multi-transport) — if Attenda still handles a single enum, that's a latent bug source on VPN+WiFi devices. Within-7.x safe. |
| network_info_plus | **8.1.0** (2026-04-21) | Requires Dart ≥3.10 / Flutter ≥3.38 — **this transitively forces a Flutter SDK upgrade**; check your CI image. SSID reads still need location permission + services on. |
| dio | **5.9.2** | Long-stable 5.x; interceptor API unchanged. Low risk. |
| go_router | **17.3.0** (2026-06-02) | go_router ships **frequent majors with real breaking changes** (redirect signatures, `GoRouterState` accessors, ShellRoute APIs have all changed across recent majors). Budget a focused pass over `router.dart` (redirect guard, `refreshListenable`, ShellRoute, `parentNavigatorKey`) when bumping majors; also requires Dart 3.10/Flutter 3.38. |
| permission_handler | **12.0.3** (2026-06-01) | Majors track new Android permission types; 12.x current. Verify location / notification permission enums after bump. |
| hive | **2.2.3** (last published **June 2022** — effectively unmaintained) | **Migrate.** Options: |
| → hive_ce | **2.19.3** (2026-02-03) | Drop-in community fork, active. **Lowest-effort path for the offline queue** — near-zero code change. |
| → drift | **2.33.0** (2026-05-03) | SQLite-backed, actively maintained, queryable — the right choice if the offline queue grows into structured local attendance history. Higher effort (schema, codegen). |
| → isar | 3.1.0+1 (Apr **2023**; v4 stuck in dev since Aug 2023) | **Avoid** — stalled; community fork `isar_community` exists but hive_ce/drift are safer. |

---

## 7. Recommendations ranked by impact/effort for this codebase

### Tier 1 — High impact, low effort (do first)
1. **Server: widen + smarten the grace window.** Raise 10 min → 20–30 min, require ≥3 consecutive missed heartbeats, and make auto-checkout *provisional* with `checkout_reason` and a manager exception flag. Pure backend change (Express/Prisma), kills most false departures immediately, no app release needed. (§2.5, §2.9)
2. **Server: gap stitching on reconnect.** If the first post-gap event is a `match` from the same network identity as the pre-gap heartbeat and the gap ≤ 60–90 min, reconcile the provisional checkout. (§2.9 #4)
3. **Client config audit (one PR):** ensure `foregroundServiceType` is `location` not `dataSync` (Android 15 six-hour kill), enable `allowWakeLock`/`allowWifiLock` in `ForegroundTaskOptions`, and add `requestIgnoreBatteryOptimization()` to onboarding. (§2.2, §2.3, §2.7)
4. **Heartbeat telemetry:** include `screen_on`, `battery_saver`, `charging`, `device_model` in heartbeat payloads so the server can do adaptive grace and you can quantify the OEM problem from real data. (§2.9 #2)
5. **Swap `hive` → `hive_ce`.** Drop-in, removes a dead dependency from the critical offline-queue path; raise the 2 h queue expiry to ≥ a full shift. (§6, §2.9 #5)

### Tier 2 — High impact, medium effort
6. **AlarmManager-driven heartbeats** (`setExactAndAllowWhileIdle`, accepting the 9-min Doze floor) as the guaranteed path alongside the existing 4-min timer; optional single `setAlarmClock` escalation just before the server deadline. Needs platform-channel/native work. (§2.5)
7. **FCM high-priority "presence challenge"** before any auto-checkout. Server + client; reuses standard FCM plumbing. (§2.9 #6)
8. **Reliability-check screen** with per-OEM deep links (Xiaomi/Samsung/Huawei/OnePlus per dontkillmyapp.com) + live "last background heartbeat" status + server-detected-kill coaching. This is what reliability-dependent Android apps actually ship. (§2.7)
9. **Late/absence policy engine:** org-configurable grace, late tiers, points, pattern clause, auto-provisional-absent + nightly finalization job, "running late" quick action. Backend + modest UI. (§3)
10. **Manual punch fallback path** (geo/WiFi-validated button + the existing QR route as a rotating-QR kiosk) so passive WiFi is convenience, not the sole legal record. (§1.7)

### Tier 3 — Valuable, higher effort / later
11. **Break management** with attestation-based deduction, CA/EU rule packs, pre-5th-hour reminders, and break-state suspension of the auto-checkout machine. (§4)
12. **Scheduling MVP:** shifts + draft/publish/notify + availability + rest-period validation + no-show alerts wired into the attendance engine; defer bidding/auto-scheduling. (§5)
13. **Selfie-on-punch** (capture first, face-match later) for buddy-punch resistance — mind BIPA/GDPR consent. (§1.6)
14. **BLE beacon option** for sites that want room-level accuracy; legitimizes the `connectedDevice` FGS type and adds OS-wakeup-on-detection semantics. (§1.3)
15. **Dependency bumps:** Prisma 7 migration (config file, driver adapter, generated-client path — plan a day, mind the Turbopack note), go_router major (focused `router.dart` pass), network_info_plus 8 / Flutter SDK 3.38 CI update. (§6)

---

## Sources

**Competitor features:** [Jibble review (Connecteam)](https://connecteam.com/reviews/jibble/) · [Connecteam vs Deputy](https://connecteam.com/connecteam-vs-deputy/) · [Deputy review (Jibble)](https://www.jibble.io/reviews/deputy) · [Connecteam review (Jibble)](https://www.jibble.io/reviews/connecteam) · [Connecteam time clock review](https://brainsensei.com/connecteam-time-clock-app-review/) · [Hubstaff geofence time clock](https://hubstaff.com/features/geofence_time_clock) · [Keka GPS/mobile attendance](https://www.keka.com/gps-mobile-attendance) · [Rippling on attendance tracking](https://www.rippling.com/blog/tracking-employee-attendance) · [Buddy Punch mobile time clock apps](https://buddypunch.com/blog/mobile-time-clock-app/) · [Truein geofencing apps](https://truein.com/blogs/best-geofencing-time-clock-apps-for-employees)

**Android background execution:** [Doze & App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby) · [Power management limits](https://developer.android.com/topic/performance/power/power-details) · [FGS timeouts (Android 15)](https://developer.android.com/develop/background-work/services/fgs/timeout) · [FGS service types](https://developer.android.com/develop/background-work/services/fgs/service-types) · [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) · [Schedule alarms](https://developer.android.com/develop/background-work/services/alarms) · [Beyond Doze (ProAndroidDev)](https://proandroiddev.com/beyond-doze-building-reliable-background-execution-on-modern-android-including-oem-realities-5fa0a6e05672) · [Surviving Doze (softaai)](https://softaai.com/building-resilient-android-apps-surviving-doze-standby/) · [Precise alarms (Igor Dias)](https://medium.com/@igordias/android-scheduling-alarms-with-precise-delivery-time-using-alarmmanager-75c409f3bde0) · [AlarmManager guide (Raghav Aggarwal)](https://medium.com/@avidraghav/simplifying-alarmmanager-understanding-alarm-scheduling-in-android-bde954b6f346) · [AOSP Wi-Fi low-latency mode](https://source.android.com/docs/core/connect/wifi-low-latency) · [WifiManager.WifiLock reference](https://developer.android.com/reference/android/net/wifi/WifiManager.WifiLock) · [WifiLock/WakeLock fixes (copyprogramming)](https://copyprogramming.com/howto/wifilock-and-wakelock-not-working-correctly-on-android) · [dontkillmyapp.com](https://dontkillmyapp.com/) ([Xiaomi](https://dontkillmyapp.com/xiaomi), [Samsung](https://dontkillmyapp.com/samsung), [General](https://dontkillmyapp.com/general)) · [flutter_foreground_task (pub.dev)](https://pub.dev/packages/flutter_foreground_task) · [Home Assistant FGS 6-hour issue](https://github.com/home-assistant/android/issues/5338)

**Presence/heartbeat design:** [Client-server heartbeats for presence (Onakoya Korede)](https://medium.com/@onakoyak/real-time-reliability-using-client-server-heartbeats-to-ensure-consistent-online-status-in-a-chat-429ae3c2d94a)

**Late/absence & breaks:** [Timeero attendance policy](https://timeero.com/post/employee-attendance-policy) · [Indeed attendance policies](https://www.indeed.com/hire/c/info/attendance-policies) · [greytHR template](https://www.greythr.com/downloadable-resource/attendance-policy/) · [CurrentWare template](https://www.currentware.com/blog/employee-attendance-policy-template/) · [Fieldservicely guide](https://www.fieldservicely.com/employee-attendance-policy) · [ADP rest-break compliance](https://www.adp.com/spark/articles/2025/12/compliance-in-action-how-time-tracking-software-helps-with-rest-break-compliance.aspx) · [Timeero CA break compliance](https://timeero.com/post/california-break-law-compliance-timeero) · [DATABASICS CA meal tracking](https://blog.data-basics.com/timesheet-automation-can-solve-californias-meal-and-break-tracking-laws) · [calaborlaw CA charts](https://www.calaborlaw.com/california-meal-break-law-for-employees/) · [CA Employment Law Report](https://www.californiaemploymentlawreport.com/2025/09/five-compliance-reminders-on-meal-and-rest-breaks-to-protect-against-costly-claims/) · [epay break features](https://www.epaysystems.com/time-tracking-features-meal-breaks/) · [EU Working Time Directive](https://employment-social-affairs.ec.europa.eu/policies-and-activities/rights-work/labour-law/working-conditions/working-time-directive_en) · [Toggl on EU time tracking](https://toggl.com/blog/eu-mandatory-time-tracking) · [Your Europe working hours](https://europa.eu/youreurope/business/human-resources/general-employment-terms-conditions/working-hours/index_en.htm)

**Scheduling:** [Deputy scheduling](https://www.deputy.com/features/scheduling-software) · [Deputy shift swapping](https://www.deputy.com/features/shift-swapping) · [Workforce.com swaps](https://www.workforce.com/software/shift-swapping) · [Evolia](https://evolia.com/shift-swaps-software/) · [Factorial roundup](https://factorialhr.com/blog/best-shift-scheduling-software/) · [SafetyCulture shift software](https://safetyculture.com/apps/shift-management-software) · [gitnux bidding software](https://gitnux.org/best/schedule-bidding-software/) · [Virto shift scheduling](https://www.virtosoftware.com/shift-scheduling/shift-scheduling-software/)

**Versions:** registry.npmjs.org and pub.dev/api (fetched 2026-06-10) · [Prisma v7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) · [Prisma 7 announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0) · [Prisma changelog 2025-11-19](https://www.prisma.io/changelog/2025-11-19) · [prisma#28599 enum mapping](https://github.com/prisma/prisma/issues/28599) · [Prisma 7 + Next 16 Turbopack fix](https://www.buildwithmatija.com/blog/migrate-prisma-v7-nextjs-16-turbopack-fix)
