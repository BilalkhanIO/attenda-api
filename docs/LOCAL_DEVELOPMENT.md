# Local development quickstart

This is the supported workspace path for the API, web app, and Flutter app. It uses a local PostgreSQL/Redis stack and a local-only demo organization. It never requires a production tenant or production credentials.

## Prerequisites

- Node.js 20 and npm
- Docker Engine with the Docker Compose plugin
- Flutter 3.x and Dart 3.x for mobile
- Android SDK for Android builds; macOS and Xcode are required for iOS simulator/device builds

## Start API, web, and Android emulator

From the workspace root:

```bash
# Start only local data services; this does not reset application data.
docker compose -f attenda-api/docker-compose.yml up -d db redis

# Configure the API for those local services.
cp -n attenda-api/.env.example attenda-api/.env
# Set DATABASE_URL in attenda-api/.env to:
# postgresql://postgres:postgres@localhost:5432/attenda_db

cd attenda-api
npm ci
npx prisma migrate deploy
npm run db:seed:demo
npm run dev
```

In a second terminal:

```bash
cd Attenda-web
npm ci
npm run dev
```

In a third terminal, after an Android emulator is running:

```bash
cd Attenda-mobile
flutter pub get
flutter run --dart-define=API_URL=http://10.0.2.2:5000/api/v1
```

For an iOS simulator on macOS, use `http://127.0.0.1:5000/api/v1`. For a physical phone, use the development computer's reachable LAN IP, for example `http://192.168.1.20:5000/api/v1`; the phone and computer must be allowed to communicate on that network. The mobile debug log prints the selected scheme and host only.

The web app needs no `.env.local` for this local path. Its Next.js rewrite targets `http://localhost:5000/api/v1`. If the API is elsewhere, set `BACKEND_API_URL` for the web process.

## Verify the local path

- API liveness: `curl -fsS http://localhost:5000/health`
- API readiness (PostgreSQL and Redis): `curl -fsS http://localhost:5000/ready`
- Web login: open `http://localhost:3000/login`
- Mobile: confirm the login screen appears and the debug log reports the selected local API host.
- Demo accounts are created only by the explicit local `db:seed:demo` command. The seed output prints account names; its demo password is `Demo1234!`. Never use demo accounts or this password outside a local development database.

## Checks before a change is shared

Run the quickest relevant checks first. Full builds and platform-specific builds need the toolchains listed above.

| App | Fast checks | Broader checks | Prerequisites / limit |
|---|---|---|---|
| API | `npm run build`; `npm run test:unit` | `npm run test:integration`; `npm test` | Unit tests need Node dependencies; integration tests need their configured PostgreSQL/Redis services. A TypeScript build does not prove transaction behavior. |
| Web | `npm run lint`; `npm test`; `npm run check:contrast` | `npm run build` | Node dependencies; a page build does not prove authenticated workflow behavior or API compatibility. |
| Mobile | `flutter analyze --no-fatal-infos`; `flutter test` | `flutter build apk --debug` | Flutter/Dart; Android SDK for APK. iOS build requires macOS/Xcode. Analyzer and unit tests do not prove physical-device background execution. |

There is not yet one automated cross-client smoke command. For attendance, approvals, schedule publishing, or payroll changes, also run the affected manual flow on web and Android emulator/device against this local API and record the result. Do not retry a write after a timeout until its server result has been reconciled or its idempotency behavior has been confirmed.

## Time-to-first-success tracking

Record a baseline from a fresh clone until the first authenticated local API/web/mobile read, including dependency download, migrations, and demo seeding. Capture OS, toolchain versions, cache state, elapsed time, and the first blocker. **Maintainer:** unassigned. **Target:** set with the team after the first reproducible baseline; no target is invented here.
