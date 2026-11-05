import { randomBytes } from "node:crypto";
import { Router } from "express";
import { idempotency } from "../middleware/idempotency";
import prisma from "../utils/prisma";
import {
  ConflictError,
  created,
  NotFoundError,
  ok,
  ValidationError,
} from "../utils/response";
import { authenticate, requireOrgFeature, requirePermission } from "../middleware/auth";
import { createNotification, emitOrgEvent } from "../services/notifications";
import { resolveUserPermissions } from "../services/authorization";

const router = Router();
router.use(authenticate);

function dateOnly(value: string, field = "date"): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ValidationError(`${field} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new ValidationError(`${field} is invalid`);
  return date;
}

function timeToMins(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new ValidationError("Shift times must use HH:MM format");
  return Number(match[1]) * 60 + Number(match[2]);
}

function shiftInterval(date: Date, start: string, end: string) {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startMinutes = timeToMins(start);
  let endMinutes = timeToMins(end);
  if (endMinutes <= startMinutes) endMinutes += 1440;
  return {
    start: day + startMinutes * 60_000,
    end: day + endMinutes * 60_000,
  };
}

function overlaps(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && startB < endA;
}

async function eligibleEmployees(orgId: string, shiftId: string, date: Date) {
  const dayEnd = new Date(date.getTime() + 86_400_000);
  const [users, assignments, leaves, unavailable] = await Promise.all([
    prisma.user.findMany({
      where: { org_id: orgId, is_active: true, deleted_at: null },
      select: { id: true },
    }),
    prisma.shiftAssignment.findMany({
      where: { date },
      select: { user_id: true },
    }),
    prisma.leaveRequest.findMany({
      where: { status: "approved", start_date: { lt: dayEnd }, end_date: { gte: date } },
      select: { user_id: true },
    }),
    prisma.shiftAvailability.findMany({
      where: {
        org_id: orgId,
        status: "approved",
        kind: "unavailable",
        OR: [
          { date },
          {
            weekday: (date.getUTCDay() + 6) % 7,
            OR: [{ starts_on: null }, { starts_on: { lte: date } }],
            AND: [{ OR: [{ ends_on: null }, { ends_on: { gte: date } }] }],
          },
        ],
      },
      select: { user_id: true, start_time: true, end_time: true },
    }),
  ]);
  const shift = await prisma.shift.findFirst({
    where: { id: shiftId, org_id: orgId },
    select: { start_time: true, end_time: true },
  });
  if (!shift) throw new NotFoundError("Shift");
  const shiftStart = timeToMins(shift.start_time);
  let shiftEnd = timeToMins(shift.end_time);
  if (shiftEnd <= shiftStart) shiftEnd += 1440;
  const ranges = shiftEnd > 1440
    ? [[shiftStart, 1440], [0, shiftEnd - 1440]]
    : [[shiftStart, shiftEnd]];
  const assigned = new Set(assignments.map((item) => item.user_id));
  const onLeave = new Set(leaves.map((item) => item.user_id));
  const blocked = new Set<string>();
  for (const rule of unavailable) {
    if (!rule.start_time || !rule.end_time) {
      blocked.add(rule.user_id);
      continue;
    }
    const from = timeToMins(rule.start_time);
    const to = timeToMins(rule.end_time);
    if (ranges.some(([a, b]) => overlaps(a, b, from, to))) blocked.add(rule.user_id);
  }
  return users
    .map((item) => item.id)
    .filter((userId) => !assigned.has(userId) && !onLeave.has(userId) && !blocked.has(userId));
}

// Open emergency opportunities are visible to active organisation employees.
router.get("/open-shifts", requireOrgFeature("shifts"), async (req, res, next) => {
  try {
    const now = new Date();
    await prisma.emergencyShiftOffer.updateMany({
      where: { org_id: req.user!.org_id, status: "open", expires_at: { lte: now } },
      data: { status: "expired" },
    });
    const today = dateOnly(now.toISOString().slice(0, 10));
    const rows = await prisma.emergencyShiftOffer.findMany({
      where: {
        org_id: req.user!.org_id,
        status: "open",
        expires_at: { gt: now },
        date: { gte: today },
      },
      include: {
        shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true, min_rest_hours: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: [{ date: "asc" }, { created_at: "asc" }],
      take: 100,
    });
    if (!rows.length) return ok(res, []);
    const userId = req.user!.sub;
    const dateKeys = [...new Set(rows.map((row) => row.date.toISOString().slice(0, 10)))];
    const dates = dateKeys.map((value) => dateOnly(value));
    const [assigned, leaves, unavailable] = await Promise.all([
      prisma.shiftAssignment.findMany({ where: { user_id: userId, date: { in: dates } }, select: { date: true } }),
      prisma.leaveRequest.findMany({ where: { user_id: userId, status: "approved", start_date: { lte: dates[dates.length - 1] }, end_date: { gte: dates[0] } }, select: { start_date: true, end_date: true } }),
      prisma.shiftAvailability.findMany({ where: { org_id: req.user!.org_id, user_id: userId, status: "approved", kind: "unavailable" }, select: { date: true, weekday: true, starts_on: true, ends_on: true, start_time: true, end_time: true } }),
    ]);
    const assignedDates = new Set(assigned.map((item) => item.date.toISOString().slice(0, 10)));
    const response = rows.map((row) => {
      const key = row.date.toISOString().slice(0, 10);
      const shiftStart = timeToMins(row.shift.start_time);
      let shiftEnd = timeToMins(row.shift.end_time);
      if (shiftEnd <= shiftStart) shiftEnd += 1440;
      const ranges = shiftEnd > 1440 ? [[shiftStart, 1440], [0, shiftEnd - 1440]] : [[shiftStart, shiftEnd]];
      const weekday = (row.date.getUTCDay() + 6) % 7;
      const unavailableConflict = unavailable.some((rule) => {
        const matchesDate = (rule.date && rule.date.toISOString().slice(0, 10) === key) ||
          (rule.weekday === weekday && (!rule.starts_on || rule.starts_on <= row.date) && (!rule.ends_on || rule.ends_on >= row.date));
        if (!matchesDate) return false;
        if (!rule.start_time || !rule.end_time) return true;
        return ranges.some(([a, b]) => overlaps(a, b, timeToMins(rule.start_time!), timeToMins(rule.end_time!)));
      });
      const leaveConflict = leaves.some((leave) => leave.start_date <= row.date && leave.end_date >= row.date);
      const reason = assignedDates.has(key) ? "You already have a shift on this date" : leaveConflict ? "You have approved leave on this date" : unavailableConflict ? "Your approved availability conflicts with this shift" : null;
      return { ...row, eligibility: { can_claim: !reason, reason } };
    });
    ok(res, response);
  } catch (error) { next(error); }
});

router.post("/open-shifts", requireOrgFeature("shifts"), requirePermission("shifts.assign"), idempotency, async (req, res, next) => {
  try {
    const { shift_id, date, note } = req.body ?? {};
    if (typeof shift_id !== "string" || !shift_id) throw new ValidationError("shift_id is required");
    if (typeof date !== "string") throw new ValidationError("date is required");
    const shiftDate = dateOnly(date);
    const today = dateOnly(new Date().toISOString().slice(0, 10));
    if (shiftDate < today) throw new ValidationError("Emergency shifts must be today or in the future");
    if (shiftDate.getTime() > today.getTime() + 90 * 86_400_000) throw new ValidationError("Emergency shifts can only be offered up to 90 days ahead");
    if (note != null && (typeof note !== "string" || note.trim().length > 500)) throw new ValidationError("Note must be 500 characters or fewer");
    const expiresIn = Number(req.body.expires_in_minutes ?? 240);
    if (!Number.isInteger(expiresIn) || expiresIn < 5 || expiresIn > 10_080) throw new ValidationError("Offer expiry must be between 5 minutes and 7 days");
    const shift = await prisma.shift.findFirst({ where: { id: shift_id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError("Shift");
    const expiresAt = new Date(Date.now() + expiresIn * 60_000);
    const recipients = await eligibleEmployees(req.user!.org_id, shift.id, shiftDate);
    if (!recipients.length) throw new ConflictError("No eligible employees are available to notify for this date");
    const offer = await prisma.emergencyShiftOffer.create({
      data: { org_id: req.user!.org_id, shift_id: shift.id, date: shiftDate, note: note?.trim() || null, expires_at: expiresAt, created_by: req.user!.sub },
      include: { shift: true },
    });
    await prisma.shiftScheduleEvent.create({
      data: { org_id: req.user!.org_id, actor_id: req.user!.sub, event_type: "emergency_shift_opened", entity_type: "emergency_shift_offer", entity_id: offer.id, details: { shift_id: shift.id, date } },
    });
    await Promise.all(recipients.map((userId) => createNotification({
      userId, orgId: req.user!.org_id, type: "emergency_shift_offer", title: "Emergency shift available",
      body: `${shift.name} · ${date} · ${shift.start_time}–${shift.end_time}${note?.trim() ? ` · ${note.trim()}` : ""}`,
      actionType: "emergency_shift_offer", actionId: offer.id,
    })));
    emitOrgEvent(req.user!.org_id, "shift_changed");
    created(res, { ...offer, notified_count: recipients.length });
  } catch (error) { next(error); }
});

router.post("/open-shifts/:id/claim", requireOrgFeature("shifts"), idempotency, async (req, res, next) => {
  try {
    const offerId = String(req.params.id);
    const userId = req.user!.sub;
    const orgId = req.user!.org_id;
    const offer = await prisma.emergencyShiftOffer.findFirst({
      where: { id: offerId, org_id: orgId },
      include: { shift: true },
    });
    if (!offer) throw new NotFoundError("Emergency shift");
    if (offer.status !== "open" || offer.expires_at <= new Date()) throw new ConflictError("This emergency shift is no longer available");
    const shiftDateKey = offer.date.toISOString().slice(0, 10);
    const todayKey = new Date().toISOString().slice(0, 10);
    if (shiftDateKey < todayKey) throw new ConflictError("This shift date has already passed");

    const claimed = await prisma.$transaction(async (tx) => {
      const claimLock = await tx.emergencyShiftOffer.updateMany({
        where: { id: offerId, org_id: orgId, status: "open", expires_at: { gt: new Date() } },
        data: { status: "claimed", claimed_by: userId, claimed_at: new Date() },
      });
      if (claimLock.count !== 1) throw new ConflictError("Another employee has already claimed this shift");
      const [user, sameDayAssignment, leave, unavailable] = await Promise.all([
        tx.user.findFirst({ where: { id: userId, org_id: orgId, is_active: true, deleted_at: null }, select: { id: true, name: true, primary_location_id: true } }),
        tx.shiftAssignment.findFirst({ where: { user_id: userId, date: offer.date }, select: { id: true } }),
        tx.leaveRequest.findFirst({ where: { user_id: userId, status: "approved", start_date: { lte: offer.date }, end_date: { gte: offer.date } }, select: { id: true } }),
        tx.shiftAvailability.findMany({
          where: { org_id: orgId, user_id: userId, status: "approved", kind: "unavailable", OR: [
            { date: offer.date },
            { weekday: (offer.date.getUTCDay() + 6) % 7, OR: [{ starts_on: null }, { starts_on: { lte: offer.date } }], AND: [{ OR: [{ ends_on: null }, { ends_on: { gte: offer.date } }] }] },
          ] },
          select: { start_time: true, end_time: true },
        }),
      ]);
      if (!user) throw new NotFoundError("Employee");
      if (sameDayAssignment) throw new ConflictError("You already have a shift on this date");
      if (leave) throw new ConflictError("You have approved leave on this date");
      const newInterval = shiftInterval(offer.date, offer.shift.start_time, offer.shift.end_time);
      const shiftStartMins = timeToMins(offer.shift.start_time);
      let shiftEndMins = timeToMins(offer.shift.end_time);
      if (shiftEndMins <= shiftStartMins) shiftEndMins += 1440;
      const newRanges = shiftEndMins > 1440 ? [[shiftStartMins, 1440], [0, shiftEndMins - 1440]] : [[shiftStartMins, shiftEndMins]];
      if (unavailable.some((rule) => !rule.start_time || !rule.end_time || newRanges.some(([a, b]) => overlaps(a, b, timeToMins(rule.start_time!), timeToMins(rule.end_time!))))) throw new ConflictError("Your approved availability conflicts with this shift");

      const dayBefore = new Date(offer.date.getTime() - 86_400_000);
      const dayAfter = new Date(offer.date.getTime() + 86_400_000);
      const neighbors = await tx.shiftAssignment.findMany({
        where: { user_id: userId, date: { gte: dayBefore, lte: dayAfter } },
        include: { shift: { select: { start_time: true, end_time: true, min_rest_hours: true } } },
      });
      for (const neighbor of neighbors) {
        const existing = shiftInterval(neighbor.date, neighbor.shift.start_time, neighbor.shift.end_time);
        const restNeeded = Math.max(offer.shift.min_rest_hours, neighbor.shift.min_rest_hours) * 3_600_000;
        if (overlaps(newInterval.start, newInterval.end, existing.start, existing.end) ||
          newInterval.start - existing.end < restNeeded && existing.end <= newInterval.start ||
          existing.start - newInterval.end < restNeeded && newInterval.end <= existing.start) {
          throw new ConflictError("This shift conflicts with another shift or required rest time");
        }
      }
      const assignment = await tx.shiftAssignment.create({
        data: { shift_id: offer.shift_id, user_id: userId, date: offer.date, location_id: user.primary_location_id, is_published: true },
        include: { shift: true },
      });
      await tx.emergencyShiftOffer.update({ where: { id: offerId }, data: { assignment_id: assignment.id } });
      await tx.shiftScheduleEvent.create({
        data: { org_id: orgId, actor_id: userId, event_type: "emergency_shift_claimed", entity_type: "emergency_shift_offer", entity_id: offerId, details: { assignment_id: assignment.id, date: shiftDateKey } },
      });
      return { user, assignment };
    });

    const recipients = await prisma.inAppNotification.findMany({
      where: { org_id: orgId, action_type: "emergency_shift_offer", action_id: offerId },
      select: { user_id: true },
      distinct: ["user_id"],
    });
    await Promise.all([
      createNotification({ userId, orgId, type: "emergency_shift_claimed", title: "Emergency shift claimed", body: `You claimed ${offer.shift.name} on ${shiftDateKey}.`, actionType: "shift", actionId: claimed.assignment.id }),
      createNotification({ userId: offer.created_by, orgId, type: "emergency_shift_claimed", title: "Emergency shift filled", body: `${claimed.user.name} claimed ${offer.shift.name} on ${shiftDateKey}.`, actionType: "shift", actionId: claimed.assignment.id }),
      ...recipients.filter((item) => item.user_id !== userId).map((item) => createNotification({ userId: item.user_id, orgId, type: "emergency_shift_claimed", title: "Emergency shift filled", body: `${offer.shift.name} on ${shiftDateKey} was claimed by another employee.`, actionType: "emergency_shift_offer", actionId: offerId })),
    ]);
    emitOrgEvent(orgId, "shift_changed");
    created(res, claimed.assignment);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return next(new ConflictError("You or another employee already claimed a shift for this date"));
    next(error);
  }
});

router.post("/open-shifts/:id/cancel", requireOrgFeature("shifts"), requirePermission("shifts.assign"), idempotency, async (req, res, next) => {
  try {
    const offer = await prisma.emergencyShiftOffer.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, status: "open" } });
    if (!offer) throw new NotFoundError("Open emergency shift");
    await prisma.emergencyShiftOffer.update({ where: { id: offer.id }, data: { status: "cancelled" } });
    await prisma.shiftScheduleEvent.create({ data: { org_id: req.user!.org_id, actor_id: req.user!.sub, event_type: "emergency_shift_cancelled", entity_type: "emergency_shift_offer", entity_id: offer.id, details: {} } });
    const recipients = await prisma.inAppNotification.findMany({ where: { org_id: req.user!.org_id, action_type: "emergency_shift_offer", action_id: offer.id }, select: { user_id: true }, distinct: ["user_id"] });
    await Promise.all(recipients.map((item) => createNotification({ userId: item.user_id, orgId: req.user!.org_id, type: "emergency_shift_claimed", title: "Emergency shift closed", body: "This shift offer has been withdrawn.", actionType: "shift_schedule" })));
    emitOrgEvent(req.user!.org_id, "shift_changed");
    ok(res, { cancelled: true });
  } catch (error) { next(error); }
});

router.get("/:shiftId/checkpoints", requireOrgFeature("shifts"), requirePermission("shifts.checkpoints.manage"), async (req, res, next) => {
  try {
    const shiftId = String(req.params.shiftId);
    const shift = await prisma.shift.findFirst({ where: { id: shiftId, org_id: req.user!.org_id }, select: { id: true } });
    if (!shift) throw new NotFoundError("Shift");
    const checkpoints = await prisma.shiftCheckpoint.findMany({ where: { shift_id: shift.id, org_id: req.user!.org_id }, include: { _count: { select: { scans: true } } }, orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] });
    ok(res, checkpoints.map((item) => ({ ...item, qr_payload: `ATTENDA_CHECKPOINT:${item.qr_token}` })));
  } catch (error) { next(error); }
});

router.post("/:shiftId/checkpoints", requireOrgFeature("shifts"), requirePermission("shifts.checkpoints.manage"), idempotency, async (req, res, next) => {
  try {
    const shiftId = String(req.params.shiftId);
    const { name, instructions } = req.body ?? {};
    const order = Number(req.body?.sort_order ?? 0);
    const interval = Number(req.body?.minimum_interval_mins ?? 0);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new ValidationError("Checkpoint name is required and must be 100 characters or fewer");
    if (instructions != null && (typeof instructions !== "string" || instructions.length > 2000)) throw new ValidationError("Instructions must be 2,000 characters or fewer");
    if (!Number.isInteger(order) || order < 0) throw new ValidationError("Checkpoint order must be a non-negative number");
    if (!Number.isInteger(interval) || interval < 0 || interval > 1440) throw new ValidationError("Minimum scan interval must be between 0 and 1,440 minutes");
    const shift = await prisma.shift.findFirst({ where: { id: shiftId, org_id: req.user!.org_id }, select: { id: true } });
    if (!shift) throw new NotFoundError("Shift");
    const item = await prisma.shiftCheckpoint.create({ data: { org_id: req.user!.org_id, shift_id: shiftId, name: name.trim(), instructions: instructions?.trim() || null, sort_order: order, required: req.body?.required !== false, minimum_interval_mins: interval, active: req.body?.active !== false, qr_token: randomBytes(24).toString("base64url"), created_by: req.user!.sub } });
    await prisma.shiftScheduleEvent.create({ data: { org_id: req.user!.org_id, actor_id: req.user!.sub, event_type: "checkpoint_created", entity_type: "shift_checkpoint", entity_id: item.id, details: { shift_id: shiftId, name: item.name } } });
    emitOrgEvent(req.user!.org_id, "shift_changed");
    created(res, { ...item, qr_payload: `ATTENDA_CHECKPOINT:${item.qr_token}` });
  } catch (error) { next(error); }
});

router.put("/:shiftId/checkpoints/:checkpointId", requireOrgFeature("shifts"), requirePermission("shifts.checkpoints.manage"), idempotency, async (req, res, next) => {
  try {
    const item = await prisma.shiftCheckpoint.findFirst({ where: { id: String(req.params.checkpointId), shift_id: String(req.params.shiftId), org_id: req.user!.org_id } });
    if (!item) throw new NotFoundError("Checkpoint");
    const { name, instructions } = req.body ?? {};
    const order = req.body?.sort_order === undefined ? item.sort_order : Number(req.body.sort_order);
    const interval = req.body?.minimum_interval_mins === undefined ? item.minimum_interval_mins : Number(req.body.minimum_interval_mins);
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.trim().length > 100)) throw new ValidationError("Checkpoint name is required and must be 100 characters or fewer");
    if (instructions !== undefined && instructions !== null && (typeof instructions !== "string" || instructions.length > 2000)) throw new ValidationError("Instructions must be 2,000 characters or fewer");
    if (!Number.isInteger(order) || order < 0 || !Number.isInteger(interval) || interval < 0 || interval > 1440) throw new ValidationError("Invalid sequence or minimum interval");
    const updated = await prisma.shiftCheckpoint.update({ where: { id: item.id }, data: { ...(name !== undefined && { name: name.trim() }), ...(instructions !== undefined && { instructions: instructions?.trim() || null }), sort_order: order, minimum_interval_mins: interval, ...(req.body?.required !== undefined && { required: !!req.body.required }), ...(req.body?.active !== undefined && { active: !!req.body.active }) } });
    emitOrgEvent(req.user!.org_id, "shift_changed");
    ok(res, { ...updated, qr_payload: `ATTENDA_CHECKPOINT:${updated.qr_token}` });
  } catch (error) { next(error); }
});

router.post("/:shiftId/checkpoints/:checkpointId/rotate-qr", requireOrgFeature("shifts"), requirePermission("shifts.checkpoints.manage"), idempotency, async (req, res, next) => {
  try {
    const item = await prisma.shiftCheckpoint.findFirst({ where: { id: String(req.params.checkpointId), shift_id: String(req.params.shiftId), org_id: req.user!.org_id } });
    if (!item) throw new NotFoundError("Checkpoint");
    const updated = await prisma.shiftCheckpoint.update({ where: { id: item.id }, data: { qr_token: randomBytes(24).toString("base64url") } });
    await prisma.shiftScheduleEvent.create({ data: { org_id: req.user!.org_id, actor_id: req.user!.sub, event_type: "checkpoint_qr_rotated", entity_type: "shift_checkpoint", entity_id: item.id, details: {} } });
    ok(res, { ...updated, qr_payload: `ATTENDA_CHECKPOINT:${updated.qr_token}` });
  } catch (error) { next(error); }
});

router.delete("/:shiftId/checkpoints/:checkpointId", requireOrgFeature("shifts"), requirePermission("shifts.checkpoints.manage"), idempotency, async (req, res, next) => {
  try {
    const item = await prisma.shiftCheckpoint.findFirst({ where: { id: String(req.params.checkpointId), shift_id: String(req.params.shiftId), org_id: req.user!.org_id } });
    if (!item) throw new NotFoundError("Checkpoint");
    await prisma.shiftCheckpoint.delete({ where: { id: item.id } });
    await prisma.shiftScheduleEvent.create({ data: { org_id: req.user!.org_id, actor_id: req.user!.sub, event_type: "checkpoint_deleted", entity_type: "shift_checkpoint", entity_id: item.id, details: { name: item.name } } });
    emitOrgEvent(req.user!.org_id, "shift_changed");
    ok(res, { deleted: true });
  } catch (error) { next(error); }
});

router.get("/assignments/:assignmentId/checkpoints", requireOrgFeature("shifts"), async (req, res, next) => {
  try {
    const assignment = await prisma.shiftAssignment.findFirst({ where: { id: String(req.params.assignmentId), shift: { org_id: req.user!.org_id } }, include: { shift: { select: { id: true, name: true, start_time: true, end_time: true, checkpoints: { where: { active: true }, orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] } } } } });
    if (!assignment) throw new NotFoundError("Assignment");
    const permissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    if (assignment.user_id !== req.user!.sub && !permissions.has("shifts.view")) throw new NotFoundError("Assignment");
    const scans = await prisma.shiftCheckpointScan.findMany({ where: { assignment_id: assignment.id }, orderBy: { scanned_at: "desc" } });
    const checkpoints = assignment.shift.checkpoints.map((checkpoint) => {
      const history = scans.filter((scan) => scan.checkpoint_id === checkpoint.id);
      return { id: checkpoint.id, name: checkpoint.name, instructions: checkpoint.instructions, sort_order: checkpoint.sort_order, required: checkpoint.required, minimum_interval_mins: checkpoint.minimum_interval_mins, scan_count: history.length, last_scanned_at: history[0]?.scanned_at ?? null };
    });
    ok(res, { assignment_id: assignment.id, shift: assignment.shift, checkpoints, completed: checkpoints.filter((item) => item.required && item.scan_count > 0).length, required: checkpoints.filter((item) => item.required).length, history: scans });
  } catch (error) { next(error); }
});

router.post("/checkpoints/scan", requireOrgFeature("shifts"), idempotency, async (req, res, next) => {
  try {
    const assignmentId = String(req.body?.assignment_id ?? "");
    const rawCode = String(req.body?.qr_code ?? "").trim();
    const token = rawCode.replace(/^ATTENDA_CHECKPOINT:/i, "");
    if (!assignmentId || !token || token.length > 64) throw new ValidationError("Scan a valid shift checkpoint QR code");
    const checkpoint = await prisma.shiftCheckpoint.findFirst({ where: { qr_token: token, org_id: req.user!.org_id, active: true }, include: { shift: true } });
    if (!checkpoint) throw new ValidationError("This checkpoint QR code is invalid or has been replaced");
    const assignment = await prisma.shiftAssignment.findFirst({ where: { id: assignmentId, user_id: req.user!.sub, shift_id: checkpoint.shift_id, shift: { org_id: req.user!.org_id } }, include: { shift: true } });
    if (!assignment) throw new ConflictError("This checkpoint is not part of your assigned shift");
    const today = dateOnly(new Date().toISOString().slice(0, 10));
    if (assignment.date.getTime() !== today.getTime()) throw new ConflictError("Checkpoint scans are available only on the assigned shift date");
    const attendance = await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: req.user!.sub, date: today } }, select: { check_in_at: true, check_out_at: true } });
    if (!attendance?.check_in_at || attendance.check_out_at) throw new ConflictError("Check in to this shift before scanning its checkpoints");
    const previous = await prisma.shiftCheckpointScan.findFirst({ where: { checkpoint_id: checkpoint.id, assignment_id: assignment.id }, orderBy: { scanned_at: "desc" }, select: { scanned_at: true } });
    if (previous && checkpoint.minimum_interval_mins > 0) {
      const nextScanAt = previous.scanned_at.getTime() + checkpoint.minimum_interval_mins * 60_000;
      if (Date.now() < nextScanAt) throw new ConflictError(`This point can be scanned again in ${Math.ceil((nextScanAt - Date.now()) / 60_000)} minute(s)`);
    }
    const latitude = req.body?.latitude == null ? null : Number(req.body.latitude);
    const longitude = req.body?.longitude == null ? null : Number(req.body.longitude);
    const accuracy = req.body?.accuracy_m == null ? null : Number(req.body.accuracy_m);
    if (latitude != null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) throw new ValidationError("Invalid latitude");
    if (longitude != null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) throw new ValidationError("Invalid longitude");
    if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000)) throw new ValidationError("Invalid GPS accuracy");
    const scan = await prisma.shiftCheckpointScan.create({ data: { org_id: req.user!.org_id, checkpoint_id: checkpoint.id, assignment_id: assignment.id, user_id: req.user!.sub, latitude, longitude, accuracy_m: accuracy } });
    const checkpoints = await prisma.shiftCheckpoint.findMany({ where: { shift_id: checkpoint.shift_id, active: true }, select: { id: true, required: true } });
    const uniqueScanned = await prisma.shiftCheckpointScan.findMany({ where: { assignment_id: assignment.id, checkpoint_id: { in: checkpoints.map((item) => item.id) } }, distinct: ["checkpoint_id"], select: { checkpoint_id: true } });
    const scannedIds = new Set(uniqueScanned.map((item) => item.checkpoint_id));
    ok(res, { scan, checkpoint: { id: checkpoint.id, name: checkpoint.name, instructions: checkpoint.instructions }, progress: { completed: checkpoints.filter((item) => item.required && scannedIds.has(item.id)).length, required: checkpoints.filter((item) => item.required).length } }, 201);
  } catch (error) { next(error); }
});

export default router;
