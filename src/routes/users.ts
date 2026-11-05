import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { validate } from '../middleware/validate';
import { createUserSchema, updateUserSchema, deviceTokenSchema } from '../schemas';
import { getUserCapabilities, resolveUserPermissions, can } from '../services/authorization';
import { hashPassword, generateToken, startOfMonth, endOfMonth } from '../utils/auth';
import { ok, created, paginated, NotFoundError, ForbiddenError, ValidationError, AppError } from '../utils/response';
import { PERMISSION_CATALOG } from '../constants/rbac';
import prisma from '../utils/prisma';
import { revokeAllForUser } from '../services/refreshTokens';
import { decodeCursor, encodeCursor, keysetAfter } from '../utils/cursor';
import { normalizeNotificationPrefs } from '../services/notifications';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { setEffectiveHourlyRate } from '../services/payRates';
import { localDateStr } from '../utils/shift';

const router = Router();
router.use(authenticate);

const USER_SELECT = {
  id: true, org_id: true, name: true, email: true, role: true,
  department: true, department_id: true, job_title: true, phone: true, manager_id: true,
  primary_location_id: true,
  hourly_rate: true, avatar_url: true, is_active: true, setup_complete: true,
  created_at: true, totp_enabled: true, notification_prefs: true,
  date_of_birth: true, gender: true, address: true, city: true, country: true,
  emergency_contact_name: true, emergency_contact_phone: true,
  employment_type: true, joined_at: true, national_id: true,
  manager: { select: { id: true, name: true } },
  primary_location: { select: { id: true, name: true, timezone: true } },
  department_ref: { select: { id: true, name: true, parent_id: true } },
};

const USER_DIRECTORY_SELECT = {
  id: true, org_id: true, name: true, email: true, role: true,
  department: true, department_id: true, job_title: true, phone: true, manager_id: true,
  primary_location_id: true, avatar_url: true, is_active: true, setup_complete: true,
  created_at: true,
  manager: { select: { id: true, name: true } },
  department_ref: { select: { id: true, name: true, parent_id: true } },
  primary_location: { select: { id: true, name: true, timezone: true } },
};

// ─── GET /users/me/capabilities ────────────────────────
router.get('/me/capabilities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caps = await getUserCapabilities(req.user!.sub, req.user!.org_id, req.user!.role);
    ok(res, caps);
  } catch (e) { next(e); }
});

// Per-user calendar subscriptions are revocable. The feed secret is shown only
// when created or rotated; the database stores its SHA-256 digest only.
router.get('/me/calendar-feed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const feed = await prisma.calendarFeed.findUnique({ where: { user_id: req.user!.sub }, select: { created_at: true, revoked_at: true, last_used_at: true } });
    ok(res, { active: Boolean(feed && !feed.revoked_at), created_at: feed?.created_at ?? null, last_used_at: feed?.last_used_at ?? null });
  } catch (e) { next(e); }
});

router.post('/me/calendar-feed', idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = randomBytes(32).toString('base64url');
    const token_hash = createHash('sha256').update(token).digest('hex');
    await prisma.calendarFeed.upsert({
      where: { user_id: req.user!.sub },
      create: { org_id: req.user!.org_id, user_id: req.user!.sub, token_hash },
      update: { org_id: req.user!.org_id, token_hash, revoked_at: null, created_at: new Date(), last_used_at: null },
    });
    const origin = (process.env.API_PUBLIC_URL || process.env.API_URL || `http://localhost:${process.env.PORT || '5000'}`).replace(/\/$/, '');
    ok(res, { url: `${origin}/api/v1/calendar/${token}.ics`, token_shown_once: true });
  } catch (e) { next(e); }
});

router.delete('/me/calendar-feed', idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.calendarFeed.updateMany({ where: { user_id: req.user!.sub, revoked_at: null }, data: { revoked_at: new Date() } });
    ok(res, { revoked: true });
  } catch (e) { next(e); }
});

// ─── GET /users/me ─────────────────────────────────────
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: USER_SELECT });
    if (!user) throw new NotFoundError('User');
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── PUT /users/me ─────────────────────────────────────
router.put('/me', idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name, phone, avatar_url, date_of_birth, gender, address, city, country,
      emergency_contact_name, emergency_contact_phone,
    } = req.body;
    const update: Record<string, unknown> = {};
    if (name !== undefined)       update.name       = name;
    if (phone !== undefined)      update.phone      = phone;
    if (avatar_url !== undefined) update.avatar_url = avatar_url;
    if (gender !== undefined)     update.gender     = gender || null;
    if (address !== undefined)    update.address    = address || null;
    if (city !== undefined)       update.city       = city || null;
    if (country !== undefined)    update.country    = country || null;
    if (emergency_contact_name !== undefined)  update.emergency_contact_name  = emergency_contact_name || null;
    if (emergency_contact_phone !== undefined) update.emergency_contact_phone = emergency_contact_phone || null;
    if (date_of_birth !== undefined) {
      update.date_of_birth = date_of_birth ? new Date(date_of_birth) : null;
    }

    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: update,
      select: USER_SELECT,
    });
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── PUT /users/me/device-token ────────────────────────
// Registers the caller's FCM device token so the server can send
// presence-challenge pushes before auto-checkout (see services/pushChallenge).
router.put('/me/device-token', idempotency, validate({ body: deviceTokenSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body as { token: string };
    await prisma.user.update({
      where: { id: req.user!.sub },
      data: { fcm_token: token, fcm_token_updated_at: new Date() },
    });
    ok(res, { message: 'Device token updated' });
  } catch (e) { next(e); }
});

// ─── GET /users/me/notification-prefs ──────────────────
router.get('/me/notification-prefs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { notification_prefs: true, whatsapp_opted_in_at: true },
    });
    if (!user) throw new NotFoundError('User');
    ok(res, { ...normalizeNotificationPrefs(user.notification_prefs), whatsapp_opted_in: Boolean(user.whatsapp_opted_in_at) });
  } catch (e) { next(e); }
});

// ─── PUT /users/me/notification-prefs ──────────────────
router.put('/me/notification-prefs', idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('A notification preferences object is required');
    const incoming = req.body as Record<string, unknown>;
    const allowedTopLevel = ['categories', 'channels', 'quiet_hours', 'digest', 'whatsapp_consent'];
    if (Object.keys(incoming).some(key => !allowedTopLevel.includes(key))) throw new ValidationError('Unsupported notification preference field');
    const existing = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { notification_prefs: true, whatsapp_opted_in_at: true, phone: true } });
    if (!existing) throw new NotFoundError('User');
    const oldPrefs = normalizeNotificationPrefs(existing.notification_prefs);
    const categoryKeys = ['attendance', 'requests', 'shifts', 'projects', 'payroll', 'announcements', 'documents', 'security'];
    const channelKeys = ['in_app', 'push', 'email', 'whatsapp'];
    const validateBooleanMap = (value: unknown, keys: string[], field: string) => {
      if (value === undefined) return {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
      const entries = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(entries)) {
        if (!keys.includes(key) || typeof item !== 'boolean') throw new ValidationError(`Invalid ${field} setting: ${key}`);
      }
      return entries;
    };
    const categories = { ...(oldPrefs.categories as object), ...validateBooleanMap(incoming.categories, categoryKeys, 'categories') };
    const channels = { ...(oldPrefs.channels as object), ...validateBooleanMap(incoming.channels, channelKeys, 'channels') };
    const wantsWhatsApp = (channels as Record<string, boolean>).whatsapp;
    if (wantsWhatsApp && !existing.phone) throw new ValidationError('Add a phone number to your profile before enabling WhatsApp notifications');
    if (wantsWhatsApp && !existing.whatsapp_opted_in_at && incoming.whatsapp_consent !== true) throw new ValidationError('Explicit WhatsApp consent is required');
    let quietHours = oldPrefs.quiet_hours as Record<string, unknown>;
    if (incoming.quiet_hours !== undefined) {
      if (!incoming.quiet_hours || typeof incoming.quiet_hours !== 'object' || Array.isArray(incoming.quiet_hours)) throw new ValidationError('quiet_hours must be an object');
      const q = incoming.quiet_hours as Record<string, unknown>;
      const start = q.start ?? quietHours.start; const end = q.end ?? quietHours.end;
      if (typeof (q.enabled ?? quietHours.enabled) !== 'boolean' || typeof start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || typeof end !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start === end) throw new ValidationError('Quiet hours require enabled and different valid HH:MM start/end values');
      quietHours = { enabled: q.enabled ?? quietHours.enabled, start, end };
    }
    const digest = incoming.digest ?? oldPrefs.digest;
    if (!['off', 'daily', 'weekly'].includes(String(digest))) throw new ValidationError('digest must be off, daily, or weekly');
    const prefs = normalizeNotificationPrefs({ categories, channels, quiet_hours: quietHours, digest });
    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: {
        notification_prefs: prefs as Prisma.InputJsonValue,
        whatsapp_opted_in_at: wantsWhatsApp ? (existing.whatsapp_opted_in_at ?? new Date()) : null,
      },
      select: { notification_prefs: true, whatsapp_opted_in_at: true },
    });
    ok(res, { ...normalizeNotificationPrefs(user.notification_prefs), whatsapp_opted_in: Boolean(user.whatsapp_opted_in_at) });
  } catch (e) { next(e); }
});

router.get('/me/notification-deliveries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '30'), 10) || 30));
    const items = await prisma.notificationDelivery.findMany({
      where: { org_id: req.user!.org_id, user_id: req.user!.sub },
      select: { id: true, event_type: true, channel: true, status: true, attempts: true, available_at: true, last_error: true, sent_at: true, created_at: true },
      orderBy: { created_at: 'desc' }, take: limit,
    });
    ok(res, items);
  } catch (e) { next(e); }
});

// ─── GET /users/:id/permissions ────────────────────────
router.get('/:id/permissions', requirePermission('org.permissions.grant'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id, deleted_at: null },
    });
    if (!user) throw new NotFoundError('User');

    const grants = await prisma.userPermissionGrant.findMany({
      where: { user_id: user.id, org_id: req.user!.org_id },
      select: { permission_key: true, effect: true },
    });
    ok(res, grants);
  } catch (e) { next(e); }
});

// ─── PUT /users/:id/permissions ────────────────────────
router.put('/:id/permissions', requirePermission('org.permissions.grant'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { grants } = req.body as { grants?: Array<{ permission_key: string; effect: 'allow' | 'deny' }> };
    if (!Array.isArray(grants)) throw new ValidationError('grants must be an array');

    const user = await prisma.user.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id, deleted_at: null },
    });
    if (!user) throw new NotFoundError('User');

    const validKeys = new Set(PERMISSION_CATALOG.map(p => p.key));
    for (const g of grants) {
      if (!g.permission_key || !['allow', 'deny'].includes(g.effect)) {
        throw new ValidationError('Each grant needs permission_key and effect (allow|deny)');
      }
      if (!validKeys.has(g.permission_key)) {
        throw new ValidationError(`Unknown permission key: ${g.permission_key}`);
      }
    }

    // Transactional replace — a failed insert must not wipe existing grants
    await prisma.$transaction([
      prisma.userPermissionGrant.deleteMany({
        where: { user_id: user.id, org_id: req.user!.org_id },
      }),
      ...(grants.length ? [prisma.userPermissionGrant.createMany({
        data: grants.map(g => ({
          user_id: user.id,
          org_id: req.user!.org_id,
          permission_key: g.permission_key,
          effect: g.effect,
        })),
      })] : []),
    ]);

    const saved = await prisma.userPermissionGrant.findMany({
      where: { user_id: user.id, org_id: req.user!.org_id },
      select: { permission_key: true, effect: true },
    });
    ok(res, saved);
  } catch (e) { next(e); }
});

// ─── GET /users/meta/departments ──────────────────────
// Must be before /:id to avoid route conflict
router.get('/meta/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, department: { not: null }, deleted_at: null },
      select: { department: true },
      distinct: ['department'],
    });
    ok(res, users.map((u: typeof users[0]) => u.department).filter(Boolean));
  } catch (e) { next(e); }
});

// ─── GET /users ────────────────────────────────────────
router.get('/', requirePermission('employees.view', 'employees.view_team', 'employees.view_location'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '50', department, role, status, search, q, sort, order } = req.query as Record<string, string>;
    const pg = Math.max(1, parseInt(page));
    const lm = Math.min(100, parseInt(limit));
    const term = q || search; // q is the cross-endpoint contract; search kept for old clients

    const where: Record<string, unknown> = {
      org_id: req.user!.org_id,
      deleted_at: null,
    };
    if (department) where.department = department;
    if (role)       where.role       = role;
    if (status)     where.is_active  = status === 'active';
    if (term)       where.OR         = [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ];

    // Whitelisted sort fields only — never feed raw query strings to Prisma.
    const SORTABLE = new Set(['name', 'email', 'department', 'job_title', 'joined_at', 'created_at']);
    const sortField = SORTABLE.has(sort) ? sort : 'name';
    const sortDir = order === 'desc' ? 'desc' as const : 'asc' as const;

    // Org-wide list needs employees.view. Team and location viewers receive
    // only a constrained directory projection and their explicit scopes.
    if (!req.permissions?.has('employees.view')) {
      const scope: Record<string, unknown>[] = [];
      if (req.permissions?.has('employees.view_team')) scope.push({ manager_id: req.user!.sub });
      if (req.permissions?.has('employees.view_location')) {
        const managedLocations = await prisma.locationManager.findMany({ where: { user_id: req.user!.sub, location: { org_id: req.user!.org_id, is_active: true } }, select: { location_id: true } });
        if (managedLocations.length) scope.push({ primary_location_id: { in: managedLocations.map(item => item.location_id) } });
      }
      where.AND = [...(Array.isArray(where.AND) ? where.AND as Record<string, unknown>[] : []), { OR: scope.length ? scope : [{ id: '__no_employee_scope__' }] }];
    }
    const select = req.permissions?.has('employees.view') ? USER_SELECT : USER_DIRECTORY_SELECT;

    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string';
    if (cursorMode) {
      const cursorLimit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const position = cursor ? decodeCursor(cursor, where) : null;
      if (cursor && !position) {
        const anchor = await prisma.user.findFirst({ where: { ...where, id: cursor }, select: { id: true } });
        if (!anchor) throw new ValidationError('Invalid employee cursor');
      }
      const rows = await prisma.user.findMany({
        where: position ? { ...where, AND: [keysetAfter(position, 'created_at')] } : where,
        ...(!position && cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: cursorLimit + 1,
      });
      const hasMore = rows.length > cursorLimit;
      const items = hasMore ? rows.slice(0, cursorLimit) : rows;
      const last = items[items.length - 1];
      const total = req.query.include_total === 'true' || req.query.include_total === '1'
        ? await prisma.user.count({ where })
        : undefined;
      ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, where) : null, has_more: hasMore, limit: cursorLimit, ...(total !== undefined && { total }) });
      return;
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, select, skip: (pg - 1) * lm, take: lm, orderBy: { [sortField]: sortDir } }),
      prisma.user.count({ where }),
    ]);

    paginated(res, users, total, pg, lm);
  } catch (e) { next(e); }
});

// ─── POST /users ───────────────────────────────────────
router.post('/', requirePermission('employees.create'), idempotency, validate({ body: createUserSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name, email, role, department, department_id, job_title, phone, hourly_rate, hourly_rate_effective_from,
      manager_id, employment_type, joined_at, national_id,
      primary_location_id,
    } = req.body;
    if (!name || !email || !role) throw new ValidationError('name, email and role are required');
    if (Number(hourly_rate) > 0 && !req.permissions?.has('payroll.manage')) throw new ForbiddenError('payroll.manage permission is required to set compensation');
    const VALID_ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'];
    if (!VALID_ROLES.includes(role)) throw new ValidationError('Invalid role');
    // Assigning admin-tier roles requires role-management rights (prevents
    // HR-level users from escalating privileges)
    if (!req.permissions?.has('org.roles.manage') && !['employee', 'manager'].includes(role)) {
      throw new ForbiddenError();
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ValidationError('Email already in use');

    if (manager_id) {
      const mgr = await prisma.user.findFirst({ where: { id: manager_id, org_id: req.user!.org_id } });
      if (!mgr) throw new ValidationError('Manager not found in your organisation');
    }

    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const defaultLocation = await prisma.location.findFirst({ where: { org_id: req.user!.org_id, is_main: true, is_active: true }, select: { id: true } });
    const locationId = primary_location_id || defaultLocation?.id;
    if (!locationId) throw new ValidationError('This organization has no active primary location');
    const validLocation = await prisma.location.findFirst({ where: { id: locationId, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
    if (!validLocation) throw new ValidationError('Primary location must be active and belong to this organization');

    // Seats metering: when the platform has set a seats_limit, block
    // creation beyond the active head-count.
    if (org?.seats_limit && org.seats_limit > 0) {
      const activeCount = await prisma.user.count({
        where: { org_id: req.user!.org_id, is_active: true, deleted_at: null },
      });
      if (activeCount >= org.seats_limit) {
        throw new AppError(`Organisation seat limit reached (${org.seats_limit} seats). Contact support to add seats.`, 400, 'SEATS_LIMIT');
      }
    }

    // Structured department wins; sync the legacy free-text column from it
    let departmentName = department ?? null;
    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, org_id: req.user!.org_id },
      });
      if (!dept) throw new ValidationError('Department not found');
      departmentName = dept.name;
    }

    const initialRateStart = hourly_rate_effective_from ?? joined_at ?? localDateStr(new Date(), org?.timezone);
    const initialRateIsCurrent = initialRateStart <= localDateStr(new Date(), org?.timezone);
    const user = await prisma.$transaction(async tx => {
      const createdUser = await tx.user.create({
        data: {
          org_id: req.user!.org_id, name, email,
          primary_location_id: locationId,
          password_hash: await hashPassword(inviteToken),
          role, department: departmentName, department_id: department_id || null,
          job_title, phone,
          hourly_rate: initialRateIsCurrent ? (hourly_rate || 0) : 0,
          manager_id: manager_id || null,
          employment_type: employment_type || null,
          joined_at: joined_at ? new Date(joined_at) : null,
          national_id: national_id || null,
          invite_token: inviteToken,
          invite_expires: inviteExpires,
        },
        select: USER_SELECT,
      });
      if (Number(hourly_rate) > 0) {
        const effectiveFrom = new Date(`${initialRateStart}T00:00:00.000Z`);
        await setEffectiveHourlyRate({ tx, orgId: req.user!.org_id, userId: createdUser.id, amount: Number(hourly_rate), currency: org?.currency ?? 'PKR', effectiveFrom, actorId: req.user!.sub });
      }
      return createdUser;
    });

    // Seed UserOrgRole for the new user
    const orgRoleForUser = await prisma.orgRole.findUnique({
      where: { org_id_slug: { org_id: req.user!.org_id, slug: role } },
    });
    if (orgRoleForUser) {
      await prisma.userOrgRole.upsert({
        where: { user_id: user.id },
        update: { org_role_id: orgRoleForUser.id },
        create: { user_id: user.id, org_role_id: orgRoleForUser.id },
      });
    }

    // Send welcome email with setup link
    const { sendWelcomeEmail } = await import('../services/email');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const setupLink   = `${frontendUrl}/setup-account?token=${inviteToken}`;
    await sendWelcomeEmail(email, name, org?.name || req.user!.org_id, setupLink).catch(console.error);

    // WhatsApp invite if org has it enabled and user has a phone
    if (org?.wa_enabled && phone) {
      try {
        const { notify } = await import('../services/whatsapp');
        await notify({
          orgId: req.user!.org_id,
          event: 'invite',
          message: `Welcome to ${org.name}! Set up your Attenda account: ${setupLink}`,
          recipientType: 'individual',
          recipientId: phone,
        });
      } catch { /* silent */ }
    }

    // Create default leave balances
    const leaveTypes = ['annual', 'sick', 'wfh', 'unpaid'];
    const year = new Date().getFullYear();
    await prisma.leaveBalance.createMany({
      data: leaveTypes.map(lt => ({
        user_id: user.id, org_id: req.user!.org_id, leave_type: lt, year,
        total_days: lt === 'annual' ? 20 : lt === 'sick' ? 10 : lt === 'wfh' ? 5 : 0,
        used_days: 0,
      })),
      skipDuplicates: true,
    });

    // Auto-assign the org's default onboarding checklist. Best-effort:
    // a failed assignment must never fail user creation (logged inside).
    const { autoAssignDefaultTemplate } = await import('../services/onboarding');
    await autoAssignDefaultTemplate(req.user!.org_id, user.id);

    created(res, user);
  } catch (e) { next(e); }
});

// ─── GET /users/:id ────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    let select: Prisma.UserSelect = USER_SELECT;
    // Users can see their own profile; viewing others needs a team/org view permission
    if (id !== req.user!.sub) {
      const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
      select = can(perms, 'employees.view') ? USER_SELECT : USER_DIRECTORY_SELECT;
      const target = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null }, select: { primary_location_id: true } });
      const isLocationManager = target?.primary_location_id ? await prisma.locationManager.findFirst({ where: { user_id: req.user!.sub, location_id: target.primary_location_id } }) : null;
      if (!can(perms, 'employees.view') && !can(perms, 'employees.view_team') && !(can(perms, 'employees.view_location') && isLocationManager)) {
        throw new ForbiddenError();
      }
    }
    const user = await prisma.user.findFirst({
      where: { id, org_id: req.user!.org_id, deleted_at: null },
      select,
    });
    if (!user) throw new NotFoundError('User');
    ok(res, user);
  } catch (e) { next(e); }
});

// ─── PUT /users/:id ────────────────────────────────────
router.put('/:id', requirePermission('employees.update'), idempotency, validate({ body: updateUserSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const {
      name, role, department, department_id, job_title, phone, hourly_rate, hourly_rate_effective_from,
      manager_id, email, password, employment_type, joined_at, national_id,
      primary_location_id,
    } = req.body as {
      name?: string; role?: string; department?: string; department_id?: string | null;
      job_title?: string; phone?: string; hourly_rate?: number; hourly_rate_effective_from?: string; manager_id?: string | null;
      email?: string; password?: string; employment_type?: string | null;
      joined_at?: string | null; national_id?: string | null;
      primary_location_id?: string | null;
    };

    if (role !== undefined) {
      const VALID_ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'];
      if (!VALID_ROLES.includes(role)) throw new ValidationError('Invalid role');
      if (!req.permissions?.has('org.roles.manage') && !['employee', 'manager'].includes(role)) {
        throw new ForbiddenError();
      }
    }

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');
    let primaryLocationId: string | undefined;
    if (primary_location_id !== undefined) {
      if (primary_location_id === null || primary_location_id === '') {
        const main = await prisma.location.findFirst({ where: { org_id: req.user!.org_id, is_main: true, is_active: true }, select: { id: true } });
        if (!main) throw new ValidationError('This organization has no active primary location');
        primaryLocationId = main.id;
      } else {
        const location = await prisma.location.findFirst({ where: { id: primary_location_id, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
        if (!location) throw new ValidationError('Primary location must be active and belong to this organization');
        primaryLocationId = location.id;
      }
    }

    const rateMutation = hourly_rate !== undefined && (
      Number(hourly_rate) !== Number(user.hourly_rate) || hourly_rate_effective_from !== undefined
    );
    if (rateMutation && !req.permissions?.has('payroll.manage')) {
      throw new ForbiddenError('payroll.manage permission is required to change compensation');
    }

    if (manager_id) {
      const mgr = await prisma.user.findFirst({ where: { id: manager_id, org_id: req.user!.org_id } });
      if (!mgr) throw new ValidationError('Manager not found in your organisation');
    }

    // ─── Credentials update: email / password ──────────
    const credentialFields: Record<string, unknown> = {};
    if (email !== undefined || password !== undefined) {
      if (!req.permissions?.has('employees.credentials.update')) {
        throw new ForbiddenError('employees.credentials.update permission required');
      }

      if (email !== undefined) {
        if (!email.includes('@')) throw new ValidationError('Invalid email address');
        const existing = await prisma.user.findFirst({ where: { email, id: { not: id } } });
        if (existing) throw new ValidationError('Email already in use');
        credentialFields.email = email.toLowerCase().trim();
      }
      if (password !== undefined) {
        if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');
        credentialFields.password_hash = await hashPassword(password);
      }
    }

    // Structured department wins; keep the legacy free-text column in sync
    let departmentFields: Record<string, unknown> = {};
    if (department_id !== undefined) {
      if (department_id) {
        const dept = await prisma.department.findFirst({
          where: { id: department_id, org_id: req.user!.org_id },
        });
        if (!dept) throw new ValidationError('Department not found');
        departmentFields = { department_id, department: dept.name };
      } else {
        departmentFields = { department_id: null, ...(department !== undefined && { department }) };
      }
    } else if (department !== undefined) {
      departmentFields = { department };
    }

    const org = rateMutation ? await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { timezone: true, currency: true } }) : null;
    const localToday = new Date(`${localDateStr(new Date(), org?.timezone)}T00:00:00.000Z`);
    let effectiveRateDate = hourly_rate_effective_from;
    if (rateMutation && !effectiveRateDate) {
      const nextMonth = new Date(`${localDateStr(new Date(), org?.timezone)}T00:00:00.000Z`);
      nextMonth.setUTCDate(1);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      effectiveRateDate = nextMonth.toISOString().slice(0, 10);
    }
    if (rateMutation && effectiveRateDate && !/^\d{4}-\d{2}-01$/.test(effectiveRateDate)) {
      throw new ValidationError('Hourly rate changes must take effect on the first day of a payroll month.');
    }
    const rateEffectiveFrom = rateMutation && effectiveRateDate
      ? new Date(`${effectiveRateDate}T00:00:00.000Z`)
      : null;
    const updated = await prisma.$transaction(async tx => {
      if (rateMutation && rateEffectiveFrom) {
        const rate = await setEffectiveHourlyRate({
          tx, orgId: req.user!.org_id, userId: id, amount: Number(hourly_rate),
          currency: org?.currency ?? 'PKR', effectiveFrom: rateEffectiveFrom, actorId: req.user!.sub,
        });
        const drafts = await tx.payrollRecord.findMany({ where: { org_id: req.user!.org_id, user_id: id, status: 'draft' }, select: { id: true, period_month: true, period_year: true } });
        for (const draft of drafts) {
          if (startOfMonth(draft.period_year, draft.period_month) <= (rate.effective_to ?? new Date('9999-12-31T00:00:00.000Z')) && endOfMonth(draft.period_year, draft.period_month) >= rateEffectiveFrom) {
            await tx.payrollRecord.update({ where: { id: draft.id }, data: { inputs_stale: true } });
          }
        }
      }
      const currentEffectiveRate = rateMutation
        ? await tx.payRate.findFirst({ where: { org_id: req.user!.org_id, user_id: id, effective_from: { lte: localToday }, OR: [{ effective_to: null }, { effective_to: { gte: localToday } }] }, orderBy: { effective_from: 'desc' } })
        : null;
      return tx.user.update({
      where: { id },
      data: {
        ...(name !== undefined       && { name }),
        ...(primaryLocationId !== undefined && { primary_location_id: primaryLocationId }),
        ...(role !== undefined       && { role }),
        ...departmentFields,
        ...(job_title !== undefined  && { job_title }),
        ...(phone !== undefined      && { phone }),
        ...(currentEffectiveRate && { hourly_rate: currentEffectiveRate.amount }),
        ...(rateMutation && !currentEffectiveRate && rateEffectiveFrom && rateEffectiveFrom <= localToday && { hourly_rate }),
        ...(employment_type !== undefined && { employment_type: employment_type || null }),
        ...(joined_at !== undefined  && { joined_at: joined_at ? new Date(joined_at) : null }),
        ...(national_id !== undefined && { national_id: national_id || null }),
        manager_id: manager_id !== undefined ? (manager_id || null) : user.manager_id,
        ...credentialFields,
      },
      select: USER_SELECT,
      });
    });

    // Keep the dynamic org-role assignment in sync — it is the source of
    // truth for permissions, so a stale assignment would keep old access.
    const roleChanged = role !== undefined && role !== user.role;
    if (roleChanged) {
      const { upsertUserOrgRole } = await import('../utils/rbac-seed');
      await upsertUserOrgRole(id, req.user!.org_id, role);
    }
    // Role downgrades, administrative password resets and email changes all
    // invalidate existing sessions so old access cannot linger.
    if (roleChanged || email !== undefined || password !== undefined) await revokeAllForUser(id);

    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PATCH /users/:id/deactivate ───────────────────────
router.patch('/:id/deactivate', requirePermission('employees.deactivate'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (id === req.user!.sub) throw new ValidationError('Cannot deactivate yourself');

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');

    await revokeAllForUser(id);
    await prisma.user.update({ where: { id }, data: { is_active: false, fcm_token: null, fcm_token_updated_at: null } });

    // Send deactivation email
    const { sendDeactivationEmail } = await import('../services/email');
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    await sendDeactivationEmail(user.email, user.name, org?.name || 'your organisation').catch(console.error);

    ok(res, { message: 'User deactivated' });
  } catch (e) { next(e); }
});

// ─── PATCH /users/:id/activate ─────────────────────────
router.patch('/:id/activate', requirePermission('employees.deactivate'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');
    if (user.is_active) throw new ValidationError('User is already active');

    await prisma.user.update({ where: { id }, data: { is_active: true } });
    ok(res, { message: 'User activated' });
  } catch (e) { next(e); }
});

// ─── POST /users/import ────────────────────────────────
router.post('/import', requirePermission('employees.import'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { users } = req.body as { users: Array<{ name: string; email: string; role: string; department?: string }> };
    if (!Array.isArray(users) || users.length === 0) throw new ValidationError('No users provided');

    const org   = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const year = new Date().getFullYear();

    // Same role safeguards as POST /users: whitelist + role-management gate
    // for admin-tier roles (prevents employees.import holders from
    // mass-creating super_admin users).
    const VALID_ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'];
    const canAssignAdminRoles = !!req.permissions?.has('org.roles.manage');

    // Seats metering: same rule as POST /users, applied across the batch.
    const seatsLimit = org?.seats_limit && org.seats_limit > 0 ? org.seats_limit : null;
    let activeCount = seatsLimit === null ? 0 : await prisma.user.count({
      where: { org_id: req.user!.org_id, is_active: true, deleted_at: null },
    });
    if (seatsLimit !== null && activeCount >= seatsLimit) {
      throw new AppError(`Organisation seat limit reached (${seatsLimit} seats). Contact support to add seats.`, 400, 'SEATS_LIMIT');
    }

    for (const u of users) {
      const role = u.role || 'employee';
      if (!u?.name || !u?.email) {
        results.skipped++;
        results.errors.push(`${u?.email || '(missing email)'}: name and email are required`);
        continue;
      }
      if (!VALID_ROLES.includes(role)) {
        results.skipped++;
        results.errors.push(`${u.email}: invalid role "${u.role}"`);
        continue;
      }
      if (!canAssignAdminRoles && !['employee', 'manager'].includes(role)) {
        results.skipped++;
        results.errors.push(`${u.email}: org.roles.manage permission required to assign role "${role}"`);
        continue;
      }
      if (seatsLimit !== null && activeCount >= seatsLimit) {
        results.skipped++;
        results.errors.push(`${u.email}: SEATS_LIMIT — organisation seat limit reached (${seatsLimit} seats)`);
        continue;
      }
      try {
        const token   = generateToken();
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const user = await prisma.user.create({
          data: {
            org_id: req.user!.org_id, name: u.name, email: u.email,
            password_hash: await hashPassword(token),
            role, department: u.department || null,
            invite_token: token, invite_expires: expires,
          },
        });
        activeCount++;
        await prisma.leaveBalance.createMany({
          data: ['annual', 'sick', 'wfh', 'unpaid'].map(lt => ({
            user_id: user.id, org_id: req.user!.org_id, leave_type: lt, year,
            total_days: lt === 'annual' ? 20 : lt === 'sick' ? 10 : lt === 'wfh' ? 5 : 0,
            used_days: 0,
          })),
          skipDuplicates: true,
        });

        // Seed UserOrgRole for imported user
        const orgRoleForImport = await prisma.orgRole.findUnique({
          where: { org_id_slug: { org_id: req.user!.org_id, slug: role } },
        });
        if (orgRoleForImport) {
          await prisma.userOrgRole.upsert({
            where: { user_id: user.id },
            update: { org_role_id: orgRoleForImport.id },
            create: { user_id: user.id, org_role_id: orgRoleForImport.id },
          });
        }

        // Send welcome email
        const { sendWelcomeEmail } = await import('../services/email');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const setupLink   = `${frontendUrl}/setup-account?token=${token}`;
        await sendWelcomeEmail(u.email, u.name, org?.name || req.user!.org_id, setupLink).catch(console.error);

        // WhatsApp invite if org has it enabled and user has a phone
        if (org?.wa_enabled && (u as any).phone) {
          try {
            const { notify } = await import('../services/whatsapp');
            await notify({
              orgId: req.user!.org_id,
              event: 'invite',
              message: `Welcome to ${org.name}! Set up your Attenda account: ${setupLink}`,
              recipientType: 'individual',
              recipientId: (u as any).phone,
            });
          } catch { /* silent */ }
        }

        results.created++;
      } catch {
        results.skipped++;
        results.errors.push(`${u.email}: already exists or invalid data`);
      }
    }
    ok(res, results);
  } catch (e) { next(e); }
});

// ─── POST /users/:id/resend-invite ─────────────────────
router.post('/:id/resend-invite', requirePermission('employees.create'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findFirst({ where: { id, org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');
    if (user.setup_complete) throw new ValidationError('Account is already set up');

    const inviteToken   = generateToken();
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id },
      data: { invite_token: inviteToken, invite_expires: inviteExpires },
    });

    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const { sendWelcomeEmail } = await import('../services/email');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const setupLink   = `${frontendUrl}/setup-account?token=${inviteToken}`;
    await sendWelcomeEmail(user.email, user.name, org?.name || req.user!.org_id, setupLink).catch(console.error);

    if (org?.wa_enabled && user.phone) {
      try {
        const { notify } = await import('../services/whatsapp');
        await notify({
          orgId: req.user!.org_id,
          event: 'invite',
          message: `Welcome to ${org.name}! Set up your Attenda account: ${setupLink}`,
          recipientType: 'individual',
          recipientId: user.phone,
        });
      } catch { /* silent */ }
    }

    ok(res, { message: 'Invite resent' });
  } catch (e) { next(e); }
});

export default router;
