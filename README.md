# Attenda API — Node.js + Express Backend

REST API for the Attenda Workforce Management Platform.

## Stack
- **Runtime:** Node.js 20 LTS + TypeScript
- **Framework:** Express 5
- **ORM:** Prisma (PostgreSQL)
- **Auth:** JWT (access 8h + refresh 30d) + bcrypt
- **Cache/Queue:** Redis + Bull (background jobs)
- **Rate Limiting:** express-rate-limit (100 req/min global, 20/15min on auth)

## Quick Start

```bash
# 1. Copy env
cp .env.example .env
# Edit DATABASE_URL and JWT_SECRET at minimum

# 2. Install
npm install

# 3. Set up database
npm run db:push        # Push schema to DB (dev)
# OR
npm run db:migrate     # Run migrations (production)

# 4. Seed demo data
npm run db:seed

# 5. Start dev server
npm run dev
```

The API will be live at `http://localhost:5000`.

## API Base URL
All routes prefixed with `/api/v1`

## Authentication
All protected endpoints require:
```
Authorization: Bearer <access_token>
```

On 401, use `/api/v1/auth/refresh` with your refresh token to get a new access token.

## Routes Summary

### Auth (`/auth`)
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | /register | Register org + super admin | Public |
| POST | /login | Login → JWT | Public |
| POST | /logout | Invalidate token | Any |
| POST | /refresh | Refresh access token | Any |
| POST | /forgot-password | Send reset email | Public |
| POST | /reset-password | Reset with token | Public |
| POST | /setup-account | First-time setup via invite | Public |

### Users (`/users`)
| Method | Path | Auth |
|--------|------|------|
| GET | /me | Any |
| GET | / | Manager+ |
| POST | / | HR Admin+ |
| GET | /meta/departments | Any |
| GET | /:id | Manager+ |
| PUT | /:id | HR Admin+ |
| PATCH | /:id/deactivate | HR Admin+ |
| POST | /import | HR Admin+ |

### Attendance (`/attendance`)
| Method | Path | Auth |
|--------|------|------|
| GET | /today | Manager+ |
| GET | /me | Any |
| GET | /:userId | Manager+ |
| POST | /checkin | Any |
| POST | /checkout | Any |
| POST | /ip-event | Any |
| PUT | /:id/override | Manager+ |
| GET | /report/export | HR Admin+ |

### Leave (`/leave`)
| Method | Path | Auth |
|--------|------|------|
| GET | /requests/me | Any |
| GET | /requests/team | Manager+ |
| GET | /requests | HR Admin+ |
| POST | /requests | Any |
| DELETE | /requests/:id | Any (own) |
| PUT | /requests/:id/approve | Manager+ |
| PUT | /requests/:id/reject | Manager+ |
| GET | /balance/me | Any |
| GET | /balance/:userId | Manager+ |
| PUT | /balance/:userId | HR Admin+ |
| GET | /calendar | Manager+ |

### Shifts (`/shifts`)
| Method | Path | Auth |
|--------|------|------|
| GET | / | Manager+ |
| POST | / | HR Admin+ |
| PUT | /:id | HR Admin+ |
| DELETE | /:id | HR Admin+ |
| GET | /schedule | Manager+ |
| GET | /assignments | Manager+ |
| POST | /assignments | HR Admin+ |
| DELETE | /assignments/:id | HR Admin+ |
| POST | /schedule/publish | HR Admin+ |
| GET | /assignments/me | Any |
| GET | /swaps | Manager+ |
| POST | /swaps | Any |
| PUT | /swaps/:id/approve | Manager+ |
| PUT | /swaps/:id/reject | Manager+ |

### Payroll (`/payroll`)
| Method | Path | Auth |
|--------|------|------|
| GET | / | HR Admin+ |
| POST | /generate | HR Admin+ |
| GET | /me | Any |
| GET | /:id | HR Admin+ |
| PUT | /:id/adjust | HR Admin+ |
| POST | /process | HR Admin+ |
| GET | /payslips/:id | Any (own) |

### Performance (`/performance`)
| Method | Path | Auth |
|--------|------|------|
| GET | /reviews | Manager+ |
| POST | /reviews/:userId | Manager+ |
| GET | /goals | Any |
| POST | /goals | Manager+ |
| PUT | /goals/:id | Manager+ |

### Analytics (`/analytics`)
| Method | Path | Auth |
|--------|------|------|
| GET | /overview | Manager+ |
| GET | /attendance-trend | Manager+ |
| GET | /late-arrivals | Manager+ |
| GET | /payroll-cost | HR Admin+ |

### Org Settings (`/org`)
| Method | Path | Auth |
|--------|------|------|
| GET | /settings | Any |
| PUT | /settings | Super Admin |
| GET | /office-ips | Super Admin |
| PUT | /office-ips | Super Admin |
| GET | /whatsapp | Super Admin |
| PUT | /whatsapp | Super Admin |
| GET | /departments | Any |
| GET | /qr-code | HR Admin+ |

## Response Format

All responses use this envelope:
```json
{
  "success": true,
  "data": { ... }
}
```

Errors:
```json
{
  "success": false,
  "error": "Human-readable message",
  "code": "ERROR_CODE"
}
```

Paginated:
```json
{
  "success": true,
  "data": [...],
  "pagination": { "page": 1, "limit": 50, "total": 200, "pages": 4 }
}
```

## Role Hierarchy
`employee` < `manager` < `hr_admin` < `super_admin`

## Demo Credentials (after seed)
| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@demo.attenda.app | Demo1234! |
| HR Admin | hr@demo.attenda.app | Demo1234! |
| Manager | manager@demo.attenda.app | Demo1234! |
| Employee | alice@demo.attenda.app | Demo1234! |

## Environment Variables

See `.env.example` for all required variables.

## Project Structure

```
src/
├── server.ts           # Entry point + graceful shutdown
├── app.ts              # Express app + middleware + routes
├── routes/
│   ├── auth.ts         # F1 - Authentication
│   ├── users.ts        # F1 - User management
│   ├── attendance.ts   # F2 - Attendance
│   ├── leave.ts        # F5 - Leave management
│   ├── shifts.ts       # F6 - Shift scheduling
│   ├── payroll.ts      # F7 - Payroll
│   └── misc.ts         # F8 Performance + F9 Analytics + Org Settings
├── middleware/
│   ├── auth.ts         # JWT + RBAC middleware
│   └── errorHandler.ts # Global error handler
└── utils/
    ├── prisma.ts        # Prisma client singleton
    ├── auth.ts          # JWT + bcrypt + date helpers
    ├── response.ts      # Response helpers + error classes
    └── seed.ts          # Database seed script

prisma/
└── schema.prisma        # Full DB schema (14 tables)
```
