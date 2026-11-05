import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { holidaySchema } from '../schemas';
import { ok, created, noContent, NotFoundError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { idempotency } from '../middleware/idempotency';

const router = Router();
router.use(authenticate);

// ─── GET /org/holidays ─────────────────────────────────
// Open to every org member — clients render holidays on calendars.
router.get('/', async (req, res, next) => {
  try {
    const locationId = typeof req.query.location_id === 'string' ? req.query.location_id : null;
    const holidays = await prisma.orgHoliday.findMany({
      where: { org_id: req.user!.org_id, ...(locationId ? { OR: [{ location_id: null }, { location_id: locationId }] } : {}) },
      orderBy: { date: 'asc' },
    });
    ok(res, holidays);
  } catch (e) { next(e); }
});

// ─── POST /org/holidays ────────────────────────────────
router.post('/', requirePermission('org.settings.update'), idempotency, validate({ body: holidaySchema }), async (req, res, next) => {
  try {
    const { date, name, recurring = false, location_id = null } = req.body;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (isNaN(parsed.getTime())) throw new ValidationError('Invalid date');

    if (location_id) {
      const location = await prisma.location.findFirst({ where: { id: location_id, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
      if (!location) throw new ValidationError('Holiday location must be active and belong to this organization');
    }
    const existing = await prisma.orgHoliday.findFirst({
      where: { org_id: req.user!.org_id, location_id, date: parsed },
    });
    if (existing) throw new ValidationError('A holiday already exists on that date');

    const holiday = await prisma.orgHoliday.create({
      data: { org_id: req.user!.org_id, location_id, date: parsed, name, recurring },
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'org.holiday.create', entityType: 'org_holiday', entityId: holiday.id,
      after: { date, name, recurring },
    });
    created(res, holiday);
  } catch (e) { next(e); }
});

// ─── DELETE /org/holidays/:id ──────────────────────────
router.delete('/:id', requirePermission('org.settings.update'), idempotency, async (req, res, next) => {
  try {
    const holiday = await prisma.orgHoliday.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
    });
    if (!holiday) throw new NotFoundError('Holiday');

    await prisma.orgHoliday.delete({ where: { id: holiday.id } });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'org.holiday.delete', entityType: 'org_holiday', entityId: holiday.id,
      before: { date: holiday.date, name: holiday.name, recurring: holiday.recurring },
    });
    noContent(res);
  } catch (e) { next(e); }
});

export default router;
