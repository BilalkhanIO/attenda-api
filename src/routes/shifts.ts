import { Router } from "express";
import {
  authenticate,
  requireOrgFeature,
  requirePermission,
} from "../middleware/auth";
import {
  ok,
  created,
  noContent,
  NotFoundError,
  ValidationError,
  AppError,
} from "../utils/response";
import { createNotification, emitOrgEvent } from "../services/notifications";
import prisma from "../utils/prisma";
import { resolveUserPermissions } from "../services/authorization";
import { validate } from "../middleware/validate";
import {
  createShiftSchema,
  updateShiftSchema,
  shiftBreakSchema,
  updateShiftBreakSchema,
  shiftAssignmentSchema,
  bulkAssignmentSchema,
  publishScheduleSchema,
  swapRequestSchema,
} from "../schemas";
import { generateGeminiJson } from "../services/ai/gemini-json";

const router = Router();
router.use(authenticate);

// Employee self-service routes (visible without shifts plan feature)

function timeToMins(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function parseDateOnly(value: string, field = "date"): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ValidationError(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (isNaN(parsed.getTime())) throw new ValidationError(`Invalid ${field}`);
  return parsed;
}

function startOfCurrentWeek(): Date {
  const d = new Date();
  const utc = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

const ASSIGN_INCLUDE = {
  shift: true,
  user: {
    select: { id: true, name: true, avatar_url: true, department: true },
  },
};

function readBreakPolicy(
  body: Record<string, unknown>,
  shiftStart: string,
  existing?: {
    break_kind?: string | null;
    break_start_time?: string | null;
    break_end_time?: string | null;
    break_minutes?: number | null;
    after_minutes?: number | null;
    allowed_count_per_shift?: number | null;
    paid_within_limit?: boolean | null;
    deduct_extra_time?: boolean | null;
    allow_extra_breaks?: boolean | null;
    applies_days?: number[] | null;
    exception_dates?: string[] | null;
  },
) {
  const breakKind = String(
    body.break_kind ?? body.kind ?? existing?.break_kind ?? "fixed",
  );
  if (!["fixed", "flexible"].includes(breakKind))
    throw new ValidationError("break_kind must be fixed or flexible");

  const startTime = body.start_time as string | undefined;
  const endTime = body.end_time as string | undefined;
  let afterMinutes = 0;
  let breakMinutes = Number(
    body.break_minutes ?? body.duration_minutes ?? existing?.break_minutes ?? 0,
  );
  let breakStartTime: string | null | undefined =
    startTime ?? existing?.break_start_time ?? null;
  let breakEndTime: string | null | undefined =
    endTime ?? existing?.break_end_time ?? null;

  if (breakKind === "fixed") {
    if (!breakStartTime || !breakEndTime)
      throw new ValidationError(
        "start_time and end_time required for fixed breaks",
      );
    afterMinutes = timeToMins(breakStartTime) - timeToMins(shiftStart);
    breakMinutes = timeToMins(breakEndTime) - timeToMins(breakStartTime);
    if (breakMinutes <= 0)
      throw new ValidationError("end_time must be after start_time");
  } else {
    if (!breakMinutes || breakMinutes <= 0)
      throw new ValidationError(
        "duration_minutes is required for flexible breaks",
      );
    afterMinutes = Number(body.after_minutes ?? existing?.after_minutes ?? 0);
    breakStartTime = null;
    breakEndTime = null;
  }

  const appliesDays = Array.isArray(body.applies_days)
    ? body.applies_days.map(Number)
    : (existing?.applies_days ?? []);
  const exceptionDates = Array.isArray(body.exception_dates)
    ? body.exception_dates.map(String)
    : (existing?.exception_dates ?? []);
  return {
    break_kind: breakKind,
    break_minutes: breakMinutes,
    after_minutes: afterMinutes,
    break_start_time: breakStartTime,
    break_end_time: breakEndTime,
    allowed_count_per_shift: Number(
      body.allowed_count_per_shift ?? existing?.allowed_count_per_shift ?? 1,
    ),
    paid_within_limit:
      body.paid_within_limit !== undefined
        ? !!body.paid_within_limit
        : (existing?.paid_within_limit ?? true),
    deduct_extra_time:
      body.deduct_extra_time !== undefined
        ? !!body.deduct_extra_time
        : (existing?.deduct_extra_time ?? true),
    allow_extra_breaks:
      body.allow_extra_breaks !== undefined
        ? !!body.allow_extra_breaks
        : (existing?.allow_extra_breaks ?? true),
    applies_days: appliesDays,
    exception_dates: exceptionDates,
    // Auto-start: only meaningful for fixed breaks
    auto_start: breakKind === "fixed" ? !!body.auto_start : false,
    reminder_after_mins: Number(body.reminder_after_mins ?? 30),
    deduct_if_skipped:
      body.deduct_if_skipped !== undefined ? !!body.deduct_if_skipped : true,
  } as any;
}

// ─── GET /shifts ───────────────────────────────────────
router.get(
  "/",
  requireOrgFeature("shifts"),
  requirePermission("shifts.view"),
  async (req, res, next) => {
    try {
      const shifts = await prisma.shift.findMany({
        where: { org_id: req.user!.org_id },
        include: {
          _count: { select: { assignments: true } },
          breaks: { orderBy: { after_minutes: "asc" } },
        },
        orderBy: { name: "asc" },
      });
      ok(res, shifts);
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /shifts ──────────────────────────────────────
router.post(
  "/",
  requireOrgFeature("shifts"),
  requirePermission("shifts.manage"),
  validate({ body: createShiftSchema }),
  async (req, res, next) => {
    try {
      const {
        name,
        start_time,
        end_time,
        color,
        active_days,
        days_of_week,
        overtime_multiplier,
        min_rest_hours,
        late_tolerance_mins,
        early_checkout_tolerance_mins,
        auto_checkout,
        auto_checkout_buffer_mins,
        overtime_enabled,
        overtime_requires_approval,
        extra_time_label,
        is_org_wide,
        is_default,
      } = req.body;
      if (!name || !start_time || !end_time)
        throw new ValidationError("name, start_time and end_time required");

      const orgWide = !!is_org_wide;
      const isDefault = !!is_default;
      const orgId = req.user!.org_id;

      // org-wide / default shifts apply automatically (not via the weekly publish
      // flow), so there must be at most one of each per org and they must be
      // published immediately — otherwise effectiveShiftForUser's fallback, which
      // filters on is_published, would never match them.
      const shift = await prisma.$transaction(async (tx) => {
        if (orgWide)
          await tx.shift.updateMany({
            where: { org_id: orgId, is_org_wide: true },
            data: { is_org_wide: false },
          });
        if (isDefault)
          await tx.shift.updateMany({
            where: { org_id: orgId, is_default: true },
            data: { is_default: false },
          });
        return tx.shift.create({
          data: {
            org_id: orgId,
            name,
            start_time,
            end_time,
            color: color || "#f15153",
            active_days: active_days ?? days_of_week ?? [],
            created_by: req.user!.sub,
            is_org_wide: orgWide,
            is_default: isDefault,
            ...((orgWide || isDefault) && { is_published: true }),
            ...(overtime_multiplier !== undefined && {
              overtime_multiplier: parseFloat(overtime_multiplier),
            }),
            ...(min_rest_hours !== undefined && {
              min_rest_hours: parseFloat(min_rest_hours),
            }),
            ...(late_tolerance_mins !== undefined && {
              late_tolerance_mins: +late_tolerance_mins,
            }),
            ...(early_checkout_tolerance_mins !== undefined && {
              early_checkout_tolerance_mins: +early_checkout_tolerance_mins,
            }),
            ...(auto_checkout !== undefined && {
              auto_checkout: !!auto_checkout,
            }),
            ...(auto_checkout_buffer_mins !== undefined && {
              auto_checkout_buffer_mins: +auto_checkout_buffer_mins,
            }),
            ...(overtime_enabled !== undefined && {
              overtime_enabled: !!overtime_enabled,
            }),
            ...(overtime_requires_approval !== undefined && {
              overtime_requires_approval: !!overtime_requires_approval,
            }),
            ...(extra_time_label !== undefined && {
              extra_time_label: String(extra_time_label || "Extra office time"),
            }),
          },
        });
      });
      created(res, shift);
    } catch (e) {
      next(e);
    }
  },
);

// Return a validated template proposal for the manager to review; never save from this endpoint.
router.post(
  "/ai-template",
  requireOrgFeature("shifts"),
  requirePermission("shifts.manage"),
  async (req, res, next) => {
    try {
      const description =
        typeof req.body?.description === "string"
          ? req.body.description.trim()
          : "";
      if (!description)
        throw new ValidationError("Describe the shift template you need.");
      if (description.length > 2000)
        throw new ValidationError(
          "Template instructions must be 2,000 characters or fewer.",
        );
      const current =
        req.body?.current && typeof req.body.current === "object"
          ? req.body.current
          : {};
      const base = {
        name: String(current.name ?? "New shift"),
        start_time: String(current.start_time ?? "09:00"),
        end_time: String(current.end_time ?? "17:00"),
        color: String(current.color ?? "#00C896"),
        active_days: Array.isArray(current.active_days)
          ? current.active_days
          : [0, 1, 2, 3, 4],
        overtime_multiplier: Number(current.overtime_multiplier ?? 1.5),
        min_rest_hours: Number(current.min_rest_hours ?? 11),
        late_tolerance_mins: Number(current.late_tolerance_mins ?? 15),
        early_checkout_tolerance_mins: Number(
          current.early_checkout_tolerance_mins ?? 15,
        ),
        auto_checkout: Boolean(current.auto_checkout ?? true),
        auto_checkout_buffer_mins: Number(
          current.auto_checkout_buffer_mins ?? 30,
        ),
        overtime_enabled: Boolean(current.overtime_enabled ?? false),
        overtime_requires_approval: Boolean(
          current.overtime_requires_approval ?? true,
        ),
        extra_time_label: String(
          current.extra_time_label ?? "Extra office time",
        ),
        is_org_wide: Boolean(current.is_org_wide ?? false),
        is_default: Boolean(current.is_default ?? false),
        breaks: Array.isArray(current.breaks) ? current.breaks.slice(0, 10) : [],
        checkpoints: Array.isArray(current.checkpoints)
          ? current.checkpoints.slice(0, 50)
          : [],
      };
      const result = await generateGeminiJson<{
        template?: Record<string, unknown>;
        explanation?: string;
      }>(
        `Create or refine a reusable employee shift template from the manager's instructions. Return JSON only: {"template":{"name":"...","start_time":"HH:MM","end_time":"HH:MM","color":"#RRGGBB","active_days":[0,1,2,3,4],"overtime_multiplier":1.5,"min_rest_hours":11,"late_tolerance_mins":15,"early_checkout_tolerance_mins":15,"auto_checkout":true,"auto_checkout_buffer_mins":30,"overtime_enabled":false,"overtime_requires_approval":true,"extra_time_label":"Extra office time","breaks":[{"name":"Lunch","break_kind":"fixed","start_time":"12:00","end_time":"13:00","duration_minutes":60,"is_paid":false,"paid_within_limit":true,"deduct_extra_time":true,"auto_start":false,"reminder_after_mins":30,"deduct_if_skipped":true,"allowed_count_per_shift":1,"allow_extra_breaks":false,"applies_days":[0,1,2,3,4]}],"checkpoints":[{"name":"North entrance","instructions":"Check the door lock, access reader, and surrounding area.","sort_order":0,"required":true,"minimum_interval_mins":0,"active":true}]},"explanation":"..."}. Days are Monday=0 through Sunday=6. Use 24-hour time, valid shift settings, no more than 10 breaks, and no more than 50 checkpoints. Breaks may be fixed (name, start_time and end_time) or flexible (name, duration_minutes, after_minutes); include pay, deduction, reminder, auto-start, allowed-count and applicable-day settings. Checkpoints represent physical site inspection points and should have concise safety instructions, display order, required/optional status, minimum re-scan interval in minutes, and active state. Return empty arrays when no break or checkpoint is requested and no current ones need preserving. Preserve current settings, breaks, and checkpoints the manager did not ask to change. Never return QR tokens or secrets. Never enable organization-wide or default assignment. This is a proposal only; do not claim it is saved.\n\nInstructions: ${description}\nCurrent form values: ${JSON.stringify(base)}`,
        2200,
      );
      if (!result.template || typeof result.template !== "object")
        throw new AppError(
          "Gemini returned an incomplete template proposal. Please try again.",
          502,
          "AI_INVALID_RESPONSE",
        );
      const rawBreaks = Array.isArray(result.template.breaks)
        ? result.template.breaks
        : base.breaks;
      if (rawBreaks.length > 10)
        throw new AppError(
          "Gemini returned too many breaks. Please try a simpler request.",
          502,
          "AI_INVALID_RESPONSE",
        );
      const parsedBreaks = rawBreaks.map((breakItem: unknown) => {
        const parsedBreak = shiftBreakSchema.safeParse(breakItem);
        if (!parsedBreak.success)
          throw new AppError(
            "Gemini returned invalid break settings. Adjust the request and try again.",
            502,
            "AI_INVALID_RESPONSE",
          );
        const item = parsedBreak.data;
        const kind = item.break_kind ?? "fixed";
        const startTime = String(item.start_time ?? item.break_start_time ?? "");
        const endTime = String(item.end_time ?? item.break_end_time ?? "");
        const durationMinutes = Number(
          item.duration_minutes ?? item.break_minutes ?? 0,
        );
        if (
          kind === "fixed" &&
          (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
            timeToMins(endTime) <= timeToMins(startTime))
        )
          throw new AppError(
            "Gemini returned invalid fixed break times.",
            502,
            "AI_INVALID_RESPONSE",
          );
        if (
          kind === "flexible" &&
          (!Number.isInteger(durationMinutes) || durationMinutes < 1)
        )
          throw new AppError(
            "Gemini returned a flexible break without a duration.",
            502,
            "AI_INVALID_RESPONSE",
          );
        return {
          ...item,
          break_kind: kind,
          ...(kind === "fixed"
            ? { start_time: startTime, end_time: endTime }
            : { duration_minutes: durationMinutes }),
        };
      });
      const rawCheckpoints = Array.isArray(result.template.checkpoints)
        ? result.template.checkpoints
        : base.checkpoints;
      if (rawCheckpoints.length > 50)
        throw new AppError(
          "Gemini returned too many checkpoints. Please try a simpler request.",
          502,
          "AI_INVALID_RESPONSE",
        );
      const parsedCheckpoints = rawCheckpoints.map((point: unknown) => {
        if (!point || typeof point !== "object" || Array.isArray(point))
          throw new AppError("Gemini returned an invalid checkpoint.", 502, "AI_INVALID_RESPONSE");
        const item = point as Record<string, unknown>;
        const name = typeof item.name === "string" ? item.name.trim() : "";
        const instructions = item.instructions == null ? null : String(item.instructions).trim();
        const sortOrder = Number(item.sort_order ?? 0);
        const interval = Number(item.minimum_interval_mins ?? 0);
        if (!name || name.length > 100 || (instructions && instructions.length > 2000) || !Number.isInteger(sortOrder) || sortOrder < 0 || !Number.isInteger(interval) || interval < 0 || interval > 1440)
          throw new AppError("Gemini returned invalid checkpoint details.", 502, "AI_INVALID_RESPONSE");
        return { name, instructions, sort_order: sortOrder, minimum_interval_mins: interval, required: item.required !== false, active: item.active !== false };
      });
      const parsed = createShiftSchema.safeParse({
        ...base,
        ...result.template,
        breaks: parsedBreaks,
        checkpoints: parsedCheckpoints,
        is_org_wide: base.is_org_wide,
        is_default: base.is_default,
      });
      if (
        !parsed.success ||
        !Array.isArray(parsed.data.active_days) ||
        parsed.data.active_days.length === 0
      ) {
        throw new AppError(
          "Gemini returned invalid shift settings. Adjust the request and try again.",
          502,
          "AI_INVALID_RESPONSE",
        );
      }
      ok(res, {
        template: parsed.data,
        explanation:
          typeof result.explanation === "string"
            ? result.explanation.slice(0, 500)
            : "",
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── POST /shifts/:id/breaks ───────────────────────────
router.post(
  "/:id/breaks",
  requirePermission("shifts.breaks.manage"),
  validate({ body: shiftBreakSchema }),
  async (req, res, next) => {
    try {
      const { name, is_paid } = req.body;
      if (!name) throw new ValidationError("name required");
      const shift = await prisma.shift.findUnique({
        where: { id: req.params.id as string },
      });
      if (!shift || shift.org_id !== req.user!.org_id)
        throw new NotFoundError("Shift");
      const policy = readBreakPolicy(req.body, shift.start_time);
      const b = await prisma.shiftBreak.create({
        data: { shift_id: shift.id, name, is_paid: !!is_paid, ...policy },
      });
      created(res, b);
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/:shiftId/breaks/:breakId ─────────────
router.put(
  "/:shiftId/breaks/:breakId",
  requirePermission("shifts.breaks.manage"),
  validate({ body: updateShiftBreakSchema }),
  async (req, res, next) => {
    try {
      const { name, is_paid } = req.body;
      const b = await prisma.shiftBreak.findFirst({
        where: {
          id: req.params.breakId as string,
          shift: { org_id: req.user!.org_id },
        },
        include: { shift: true },
      });
      if (!b) throw new NotFoundError("ShiftBreak");
      const policy = readBreakPolicy(req.body, b.shift.start_time, b);
      const updated = await prisma.shiftBreak.update({
        where: { id: b.id },
        data: {
          ...(name !== undefined && { name }),
          ...(is_paid !== undefined && { is_paid: !!is_paid }),
          ...policy,
        },
      });
      ok(res, updated);
    } catch (e) {
      next(e);
    }
  },
);

// ─── DELETE /shifts/:shiftId/breaks/:breakId ──────────
router.delete(
  "/:shiftId/breaks/:breakId",
  requirePermission("shifts.breaks.manage"),
  async (req, res, next) => {
    try {
      const b = await prisma.shiftBreak.findFirst({
        where: {
          id: req.params.breakId as string,
          shift: { org_id: req.user!.org_id },
        },
      });
      if (!b) throw new NotFoundError("ShiftBreak");
      await prisma.shiftBreak.delete({ where: { id: b.id } });
      noContent(res);
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/:id ───────────────────────────────────
router.put(
  "/:id",
  requirePermission("shifts.manage"),
  validate({ body: updateShiftSchema }),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const shift = await prisma.shift.findFirst({
        where: { id, org_id: req.user!.org_id },
      });
      if (!shift) throw new NotFoundError("Shift");
      const {
        name,
        start_time,
        end_time,
        color,
        active_days,
        days_of_week,
        overtime_multiplier,
        min_rest_hours,
        late_tolerance_mins,
        early_checkout_tolerance_mins,
        auto_checkout,
        auto_checkout_buffer_mins,
        overtime_enabled,
        overtime_requires_approval,
        extra_time_label,
        is_org_wide,
        is_default,
      } = req.body;

      const orgId = req.user!.org_id;
      const turningOnDefault = is_default === true && !shift.is_default;
      const turningOnOrgWide = is_org_wide === true && !shift.is_org_wide;

      const updated = await prisma.$transaction(async (tx) => {
        // Keep at most one default / one org-wide shift per org (mirrors POST).
        if (turningOnDefault)
          await tx.shift.updateMany({
            where: { org_id: orgId, is_default: true },
            data: { is_default: false },
          });
        if (turningOnOrgWide)
          await tx.shift.updateMany({
            where: { org_id: orgId, is_org_wide: true },
            data: { is_org_wide: false },
          });
        return tx.shift.update({
          where: { id },
          data: {
            name,
            start_time,
            end_time,
            color,
            active_days: active_days ?? days_of_week,
            is_org_wide: is_org_wide !== undefined ? !!is_org_wide : undefined,
            is_default: is_default !== undefined ? !!is_default : undefined,
            // Auto-publish when promoting to org-wide/default so the fallback fires.
            ...((turningOnOrgWide || turningOnDefault) && {
              is_published: true,
            }),
            ...(overtime_multiplier !== undefined && {
              overtime_multiplier: parseFloat(overtime_multiplier),
            }),
            ...(min_rest_hours !== undefined && {
              min_rest_hours: parseFloat(min_rest_hours),
            }),
            ...(late_tolerance_mins !== undefined && {
              late_tolerance_mins: +late_tolerance_mins,
            }),
            ...(early_checkout_tolerance_mins !== undefined && {
              early_checkout_tolerance_mins: +early_checkout_tolerance_mins,
            }),
            ...(auto_checkout !== undefined && {
              auto_checkout: !!auto_checkout,
            }),
            ...(auto_checkout_buffer_mins !== undefined && {
              auto_checkout_buffer_mins: +auto_checkout_buffer_mins,
            }),
            ...(overtime_enabled !== undefined && {
              overtime_enabled: !!overtime_enabled,
            }),
            ...(overtime_requires_approval !== undefined && {
              overtime_requires_approval: !!overtime_requires_approval,
            }),
            ...(extra_time_label !== undefined && {
              extra_time_label: String(extra_time_label || "Extra office time"),
            }),
          },
        });
      });
      ok(res, updated);
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/:id/set-default ──────────────────────
router.put(
  "/:id/set-default",
  requirePermission("shifts.manage"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const shift = await prisma.shift.findFirst({
        where: { id, org_id: req.user!.org_id },
      });
      if (!shift) throw new NotFoundError("Shift");

      await prisma.$transaction([
        prisma.shift.updateMany({
          where: { org_id: req.user!.org_id },
          data: { is_default: false },
        }),
        // Publish too: a default shift applies via the (is_published) fallback.
        prisma.shift.update({
          where: { id },
          data: { is_default: true, is_published: true },
        }),
      ]);

      ok(res, { message: "Shift set as default for the organisation" });
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/:id/set-org-wide ─────────────────────
// One-click "apply this shift to the whole organisation". Makes the shift the
// single org-wide shift (everyone without a specific assignment follows it) and
// publishes it so effectiveShiftForUser's org-wide fallback matches.
router.put(
  "/:id/set-org-wide",
  requirePermission("shifts.manage"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const { org_wide = true } = req.body as { org_wide?: boolean };
      const shift = await prisma.shift.findFirst({
        where: { id, org_id: req.user!.org_id },
      });
      if (!shift) throw new NotFoundError("Shift");

      if (org_wide) {
        await prisma.$transaction([
          prisma.shift.updateMany({
            where: { org_id: req.user!.org_id, is_org_wide: true },
            data: { is_org_wide: false },
          }),
          prisma.shift.update({
            where: { id },
            data: { is_org_wide: true, is_published: true },
          }),
        ]);
        return ok(res, { message: "Shift applied to the whole organisation" });
      }

      await prisma.shift.update({
        where: { id },
        data: { is_org_wide: false },
      });
      ok(res, { message: "Org-wide shift cleared" });
    } catch (e) {
      next(e);
    }
  },
);

// ─── DELETE /shifts/:id ────────────────────────────────
router.delete(
  "/:id",
  requirePermission("shifts.manage"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const shift = await prisma.shift.findFirst({
        where: { id, org_id: req.user!.org_id },
      });
      if (!shift) throw new NotFoundError("Shift");
      await prisma.shift.delete({ where: { id } });
      ok(res, { message: "Shift template deleted" });
    } catch (e) {
      next(e);
    }
  },
);

// ─── GET /shifts/schedule ──────────────────────────────
router.get(
  "/schedule",
  requirePermission("shifts.view"),
  async (req, res, next) => {
    try {
      const { week_start } = req.query as { week_start?: string };
      const ws = week_start
        ? parseDateOnly(week_start, "week_start")
        : startOfCurrentWeek();
      const we = addUtcDays(ws, 6);

      const assignments = await prisma.shiftAssignment.findMany({
        where: {
          date: { gte: ws, lte: we },
          shift: { org_id: req.user!.org_id },
        },
        include: ASSIGN_INCLUDE,
        orderBy: { date: "asc" },
      });
      ok(res, assignments);
    } catch (e) {
      next(e);
    }
  },
);

// ─── GET /shifts/assignments ───────────────────────────
router.get(
  "/assignments",
  requirePermission("shifts.view"),
  async (req, res, next) => {
    try {
      const { week_start, department, employee_id, published } =
        req.query as Record<string, string>;
      const search =
        typeof req.query.search === "string"
          ? req.query.search.trim().slice(0, 100)
          : "";
      const ws = week_start
        ? parseDateOnly(week_start, "week_start")
        : startOfCurrentWeek();
      const we = addUtcDays(ws, 6);

      const where: Record<string, unknown> = {
        date: { gte: ws, lte: we },
        shift: { org_id: req.user!.org_id },
      };
      if (department) {
        const users = await prisma.user.findMany({
          where: { org_id: req.user!.org_id, department },
          select: { id: true },
        });
        where.user_id = { in: users.map((u) => u.id) };
      }
      if (employee_id) where.user_id = employee_id;
      if (published === "true" || published === "false")
        where.is_published = published === "true";
      if (search) {
        where.OR = [
          { shift: { name: { contains: search, mode: "insensitive" } } },
          { user: { name: { contains: search, mode: "insensitive" } } },
          { user: { email: { contains: search, mode: "insensitive" } } },
          { user: { department: { contains: search, mode: "insensitive" } } },
        ];
      }

      const assignments = await prisma.shiftAssignment.findMany({
        where,
        include: ASSIGN_INCLUDE,
        orderBy: { date: "asc" },
      });
      ok(res, assignments);
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /shifts/assignments ──────────────────────────
router.post(
  "/assignments",
  requirePermission("shifts.assign"),
  validate({ body: shiftAssignmentSchema }),
  async (req, res, next) => {
    try {
      const { user_id, shift_id, date } = req.body;
      if (!user_id || !shift_id || !date)
        throw new ValidationError("user_id, shift_id and date required");

      const assignDate = parseDateOnly(date);

      // Both the employee and the shift must belong to the caller's org
      const [user, shift] = await Promise.all([
        prisma.user.findFirst({
          where: { id: user_id, org_id: req.user!.org_id, is_active: true },
        }),
        prisma.shift.findFirst({
          where: { id: shift_id, org_id: req.user!.org_id },
        }),
      ]);
      if (!user) throw new NotFoundError("Employee");
      if (!shift) throw new NotFoundError("Shift");

      // Conflict check (scoped to org via the shift relation above)
      const conflict = await prisma.shiftAssignment.findFirst({
        where: { user_id, date: assignDate },
      });
      if (conflict)
        throw new ValidationError(
          "Employee is already assigned to a shift on this date",
        );

      // Leave conflict check
      const onLeave = await prisma.leaveRequest.findFirst({
        where: {
          user_id,
          status: "approved",
          start_date: { lte: assignDate },
          end_date: { gte: assignDate },
        },
      });
      if (onLeave)
        console.warn(
          `[SHIFTS] Warning: ${user_id} has approved leave on ${date}`,
        );

      const weekday = (assignDate.getUTCDay() + 6) % 7; // 0=Monday, matching the web and mobile schedule.
      const offDay =
        Array.isArray(shift.active_days) &&
        shift.active_days.length > 0 &&
        !shift.active_days.includes(weekday);
      const unavailable = await prisma.shiftAvailability.findMany({
        where: {
          org_id: req.user!.org_id,
          user_id,
          status: "approved",
          kind: "unavailable",
          OR: [
            { date: assignDate },
            {
              weekday,
              OR: [{ starts_on: null }, { starts_on: { lte: assignDate } }],
              AND: [
                { OR: [{ ends_on: null }, { ends_on: { gte: assignDate } }] },
              ],
            },
          ],
        },
      });
      const shiftStart = timeToMins(shift.start_time);
      let shiftEnd = timeToMins(shift.end_time);
      if (shiftEnd <= shiftStart) shiftEnd += 1440;
      const availabilityWarning = unavailable.some((rule) => {
        if (!rule.start_time || !rule.end_time) return true;
        const start = timeToMins(rule.start_time);
        const end = timeToMins(rule.end_time);
        const shiftRanges =
          shiftEnd > 1440
            ? [
                [shiftStart, 1440],
                [0, shiftEnd - 1440],
              ]
            : [[shiftStart, shiftEnd]];
        return shiftRanges.some(
          ([rangeStart, rangeEnd]) => rangeStart < end && rangeEnd > start,
        );
      });

      const assignment = await prisma.shiftAssignment.create({
        data: { shift_id, user_id, date: assignDate },
        include: ASSIGN_INCLUDE,
      });
      await prisma.shiftScheduleEvent.create({
        data: {
          org_id: req.user!.org_id,
          actor_id: req.user!.sub,
          event_type: "assignment_created",
          entity_type: "assignment",
          entity_id: assignment.id,
          details: {
            user_id,
            shift_id,
            date: assignDate.toISOString().slice(0, 10),
          },
        },
      });
      await createNotification({
        userId: user_id,
        orgId: req.user!.org_id,
        type: "shift_reminder",
        title: "New shift assigned",
        body: `You have been assigned ${shift.name} on ${assignDate.toISOString().slice(0, 10)}.`,
        actionType: "shift",
        actionId: assignment.id,
      });
      emitOrgEvent(req.user!.org_id, "shift_changed");
      created(res, {
        assignment,
        leave_warning: !!onLeave,
        off_day_warning: offDay,
        availability_warning: availabilityWarning,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/assignments/:id ──────────────────────
// Change the shift or date of an existing assignment.
router.put(
  "/assignments/:id",
  requirePermission("shifts.assign"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const assignment = await prisma.shiftAssignment.findFirst({
        where: { id, shift: { org_id: req.user!.org_id } },
      });
      if (!assignment) throw new NotFoundError("Assignment");

      const { shift_id, date } = req.body;
      const updateData: Record<string, unknown> = {};

      if (shift_id) {
        const shift = await prisma.shift.findFirst({
          where: { id: shift_id, org_id: req.user!.org_id },
        });
        if (!shift) throw new NotFoundError("Shift");
        updateData.shift_id = shift_id;
      }

      if (date) {
        const assignDate = parseDateOnly(date);

        // Conflict check: ensure no other assignment exists for this user on the new date
        const conflict = await prisma.shiftAssignment.findFirst({
          where: {
            user_id: assignment.user_id,
            date: assignDate,
            id: { not: assignment.id },
          },
        });
        if (conflict)
          throw new ValidationError(
            "Employee already has a shift on that date",
          );
        updateData.date = assignDate;
      }

      if (!shift_id && !date)
        throw new ValidationError("shift_id or date required");

      const updated = await prisma.shiftAssignment.update({
        where: { id: assignment.id },
        data: updateData,
        include: ASSIGN_INCLUDE,
      });
      await prisma.shiftScheduleEvent.create({
        data: {
          org_id: req.user!.org_id,
          actor_id: req.user!.sub,
          event_type: "assignment_updated",
          entity_type: "assignment",
          entity_id: updated.id,
          details: {
            before: {
              shift_id: assignment.shift_id,
              date: assignment.date.toISOString().slice(0, 10),
            },
            after: {
              shift_id: updated.shift_id,
              date: updated.date.toISOString().slice(0, 10),
            },
          },
        },
      });
      emitOrgEvent(req.user!.org_id, "shift_changed");
      ok(res, updated);
    } catch (e) {
      next(e);
    }
  },
);

// ─── GET /shifts/assignments/:id/detail ───────────────
router.get("/assignments/:id/detail", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const permissions = await resolveUserPermissions(
      req.user!.sub,
      req.user!.org_id,
    );
    const canViewTeam = permissions.has("shifts.view");
    const assignment = await prisma.shiftAssignment.findFirst({
      where: {
        id,
        ...(canViewTeam
          ? { shift: { org_id: req.user!.org_id } }
          : { user_id: req.user!.sub }),
      },
      include: {
        shift: { include: { breaks: { orderBy: { after_minutes: "asc" } } } },
        user: {
          select: {
            id: true,
            name: true,
            avatar_url: true,
            department: true,
            job_title: true,
          },
        },
      },
    });
    if (!assignment) throw new NotFoundError("Assignment");

    const attendance = await prisma.attendanceRecord.findUnique({
      where: {
        user_id_date: { user_id: assignment.user_id, date: assignment.date },
      },
      include: { break_records: { orderBy: { break_start: "asc" } } },
    });

    ok(res, {
      assignment,
      shift: assignment.shift,
      user: assignment.user,
      attendance,
      history: attendance
        ? {
            check_in_at: attendance.check_in_at,
            check_out_at: attendance.check_out_at,
            late_minutes: attendance.late_minutes,
            early_out_minutes: attendance.early_out_minutes,
            early_checkin_minutes: attendance.early_checkin_minutes,
            break_minutes: attendance.break_minutes,
            paid_break_minutes: attendance.paid_break_minutes,
            net_hours_worked: attendance.net_hours_worked,
            overtime_hours: attendance.overtime_hours,
            extra_office_minutes: attendance.extra_office_minutes,
            breaks: attendance.break_records,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

// ─── POST /shifts/assignments/bulk ────────────────────
// Body matches bulkAssignmentSchema: { assignments: [{user_id, shift_id, date}], dry_run? }.
// Each row is validated independently; invalid rows are reported as conflicts
// instead of failing the whole batch. With dry_run:true nothing is written —
// the response reports what WOULD be created and every conflict/warning.
router.post(
  "/assignments/bulk",
  requirePermission("shifts.assign"),
  validate({ body: bulkAssignmentSchema }),
  async (req, res, next) => {
    try {
      const { assignments, dry_run } = req.body as {
        assignments: { user_id: string; shift_id: string; date: string }[];
        dry_run?: boolean;
      };

      const userIds = [...new Set(assignments.map((a) => a.user_id))];
      const shiftIds = [...new Set(assignments.map((a) => a.shift_id))];

      // Both employees and shifts must belong to the caller's org
      const [users, shifts] = await Promise.all([
        prisma.user.findMany({
          where: {
            id: { in: userIds },
            org_id: req.user!.org_id,
            is_active: true,
          },
          select: { id: true, name: true },
        }),
        prisma.shift.findMany({
          where: { id: { in: shiftIds }, org_id: req.user!.org_id },
          select: {
            id: true,
            active_days: true,
            name: true,
            start_time: true,
            end_time: true,
          },
        }),
      ]);
      const userMap = new Map(users.map((u) => [u.id, u.name]));
      const shiftMap = new Map(shifts.map((s) => [s.id, s]));

      const parsedDates = assignments.map((a) => parseDateOnly(a.date, "date"));
      const minDate = new Date(
        Math.min(...parsedDates.map((d) => d.getTime())),
      );
      const maxDate = new Date(
        Math.max(...parsedDates.map((d) => d.getTime())),
      );

      // Pre-fetch existing assignments and approved leave to avoid N+1 checks
      const existingAssignments = await prisma.shiftAssignment.findMany({
        where: { user_id: { in: userIds }, date: { in: parsedDates } },
        select: { user_id: true, date: true },
      });
      const takenSet = new Set(
        existingAssignments.map(
          (a) => `${a.user_id}:${a.date.toISOString().split("T")[0]}`,
        ),
      );

      const approvedLeave = await prisma.leaveRequest.findMany({
        where: {
          user_id: { in: userIds },
          status: "approved",
          start_date: { lte: maxDate },
          end_date: { gte: minDate },
        },
        select: { user_id: true, start_date: true, end_date: true },
      });
      const approvedUnavailable = await prisma.shiftAvailability.findMany({
        where: {
          org_id: req.user!.org_id,
          user_id: { in: userIds },
          status: "approved",
          kind: "unavailable",
          OR: [
            { date: { gte: minDate, lte: maxDate } },
            { weekday: { not: null } },
          ],
        },
      });

      type RowRef = {
        user_id: string;
        user_name: string;
        shift_id: string;
        date: string;
      };
      const creatable: { row: RowRef; assignDate: Date }[] = [];
      const conflicts: (RowRef & { reason: string })[] = [];
      const warnings: (RowRef & { type: string })[] = [];

      for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i];
        const assignDate = parsedDates[i];
        const dateStr = assignDate.toISOString().split("T")[0];
        const row: RowRef = {
          user_id: a.user_id,
          user_name: userMap.get(a.user_id) ?? a.user_id,
          shift_id: a.shift_id,
          date: dateStr,
        };

        if (!userMap.has(a.user_id)) {
          conflicts.push({ ...row, reason: "user_not_found" });
          continue;
        }
        const shift = shiftMap.get(a.shift_id);
        if (!shift) {
          conflicts.push({ ...row, reason: "shift_not_found" });
          continue;
        }
        const key = `${a.user_id}:${dateStr}`;
        if (takenSet.has(key)) {
          conflicts.push({ ...row, reason: "already_assigned" });
          continue;
        }
        takenSet.add(key); // also catches duplicates within the same request

        // Leave, availability and off-day warnings (don't block — HR may be overriding)
        const onLeave = approvedLeave.some(
          (l) =>
            l.user_id === a.user_id &&
            new Date(l.start_date) <= assignDate &&
            new Date(l.end_date) >= assignDate,
        );
        const weekday = (assignDate.getUTCDay() + 6) % 7;
        const offDay =
          Array.isArray(shift.active_days) &&
          shift.active_days.length > 0 &&
          !shift.active_days.includes(weekday);
        if (onLeave) warnings.push({ ...row, type: "leave_overlap" });
        if (offDay) warnings.push({ ...row, type: "off_day" });
        const shiftStart = timeToMins(shift.start_time);
        let shiftEnd = timeToMins(shift.end_time);
        if (shiftEnd <= shiftStart) shiftEnd += 1440;
        const overlaps = (start: number, end: number) => {
          const ranges =
            end > start
              ? [[start, end]]
              : [
                  [start, 1440],
                  [0, end],
                ];
          const shiftRanges =
            shiftEnd > 1440
              ? [
                  [shiftStart, 1440],
                  [0, shiftEnd - 1440],
                ]
              : [[shiftStart, shiftEnd]];
          return ranges.some(([a, b]) =>
            shiftRanges.some(([c, d]) => a < d && b > c),
          );
        };
        const unavailable = approvedUnavailable.some(
          (rule) =>
            rule.user_id === a.user_id &&
            ((rule.date && rule.date.getTime() === assignDate.getTime()) ||
              (rule.weekday === weekday &&
                (!rule.starts_on || rule.starts_on <= assignDate) &&
                (!rule.ends_on || rule.ends_on >= assignDate))) &&
            (!rule.start_time ||
              !rule.end_time ||
              overlaps(timeToMins(rule.start_time), timeToMins(rule.end_time))),
        );
        if (unavailable) warnings.push({ ...row, type: "unavailable_time" });

        creatable.push({ row, assignDate });
      }

      const inserted =
        !dry_run && creatable.length > 0
          ? await prisma.shiftAssignment.createManyAndReturn({
              data: creatable.map((c) => ({
                shift_id: c.row.shift_id,
                user_id: c.row.user_id,
                date: c.assignDate,
              })),
              skipDuplicates: true,
              select: { id: true, user_id: true, shift_id: true, date: true },
            })
          : [];
      const insertedKeys = new Set(
        inserted.map(
          (item) =>
            `${item.user_id}:${item.shift_id}:${item.date.toISOString().slice(0, 10)}`,
        ),
      );
      const createdRows = creatable.filter((item) =>
        insertedKeys.has(
          `${item.row.user_id}:${item.row.shift_id}:${item.row.date}`,
        ),
      );
      if (inserted.length > 0) {
        await prisma.shiftScheduleEvent.create({
          data: {
            org_id: req.user!.org_id,
            actor_id: req.user!.sub,
            event_type: "bulk_assignments_created",
            entity_type: "schedule",
            details: { assignments: createdRows.map((c) => c.row) },
          },
        });
        const counts = new Map<string, number>();
        for (const item of createdRows)
          counts.set(item.row.user_id, (counts.get(item.row.user_id) ?? 0) + 1);
        await Promise.all(
          [...counts.entries()].map(([userId, count]) =>
            createNotification({
              userId,
              orgId: req.user!.org_id,
              type: "shift_reminder",
              title: "New shifts assigned",
              body: `${count} new shift${count === 1 ? "" : "s"} have been assigned to you.`,
              actionType: "shift_schedule",
            }),
          ),
        );
        emitOrgEvent(req.user!.org_id, "shift_changed");
      }

      ok(
        res,
        {
          dry_run: !!dry_run,
          created: inserted.length,
          would_create: creatable.length,
          conflicts: [
            ...conflicts,
            ...(!dry_run
              ? creatable
                  .filter(
                    (item) =>
                      !insertedKeys.has(
                        `${item.row.user_id}:${item.row.shift_id}:${item.row.date}`,
                      ),
                  )
                  .map((item) => ({
                    ...item.row,
                    reason: "concurrent_assignment",
                  }))
              : []),
          ],
          warnings,
          details: { created: createdRows.map((c) => c.row) },
        },
        dry_run ? 200 : 201,
      );
    } catch (e) {
      next(e);
    }
  },
);

// ─── DELETE /shifts/assignments/:id ───────────────────
router.delete(
  "/assignments/:id",
  requirePermission("shifts.assign"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const assignment = await prisma.shiftAssignment.findFirst({
        where: { id, shift: { org_id: req.user!.org_id } },
      });
      if (!assignment) throw new NotFoundError("Assignment");
      await prisma.shiftAssignment.delete({ where: { id } });
      await prisma.shiftScheduleEvent.create({
        data: {
          org_id: req.user!.org_id,
          actor_id: req.user!.sub,
          event_type: "assignment_removed",
          entity_type: "assignment",
          entity_id: id,
          details: {
            user_id: assignment.user_id,
            shift_id: assignment.shift_id,
            date: assignment.date.toISOString().slice(0, 10),
          },
        },
      });
      emitOrgEvent(req.user!.org_id, "shift_changed");
      ok(res, { message: "Assignment removed" });
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /shifts/schedule/publish ────────────────────
router.post(
  "/schedule/publish",
  requirePermission("shifts.assign"),
  validate({ body: publishScheduleSchema }),
  async (req, res, next) => {
    try {
      const ws = parseDateOnly(req.body.from_date, "from_date");
      const we = parseDateOnly(req.body.to_date, "to_date");
      if (we.getTime() - ws.getTime() > 6 * 86400000)
        throw new ValidationError("Publish one schedule week at a time");

      // Get all assignments for the week and notify employees
      const assignments = await prisma.shiftAssignment.findMany({
        where: {
          date: { gte: ws, lte: we },
          shift: { org_id: req.user!.org_id },
        },
        include: {
          user: { select: { id: true, name: true, phone: true, org_id: true } },
          shift: { select: { name: true, start_time: true } },
        },
      });

      // Mark only the shift templates that appear in this week as published
      const shiftIds = [...new Set(assignments.map((a) => a.shift_id))];
      if (shiftIds.length > 0) {
        await prisma.shift.updateMany({
          where: { id: { in: shiftIds }, org_id: req.user!.org_id },
          data: { is_published: true },
        });
        await prisma.shiftAssignment.updateMany({
          where: {
            shift_id: { in: shiftIds },
            date: { gte: ws, lte: we },
            shift: { org_id: req.user!.org_id },
          },
          data: { is_published: true },
        });
      }
      await prisma.shiftScheduleEvent.create({
        data: {
          org_id: req.user!.org_id,
          actor_id: req.user!.sub,
          event_type: "schedule_published",
          entity_type: "schedule",
          details: {
            week_start: ws.toISOString().slice(0, 10),
            assignments: assignments.length,
            shift_ids: shiftIds,
          },
        },
      });

      let notified = 0;
      const notifiedInApp = new Set<string>();
      const { notifyShiftReminder } = await import("../services/whatsapp");
      for (const a of assignments) {
        if (!notifiedInApp.has(a.user.id)) {
          notifiedInApp.add(a.user.id);
          await createNotification({
            userId: a.user.id,
            orgId: req.user!.org_id,
            type: "shift_reminder",
            title: "Schedule published",
            body: `Your shift schedule for the week of ${ws.toISOString().slice(0, 10)} is published.`,
            actionType: "shift_schedule",
            actionId: a.id,
          });
        }
        if (a.user.phone) {
          await notifyShiftReminder(
            a.user.org_id,
            a.user.name,
            a.shift.start_time,
            a.user.phone,
          ).catch(console.error);
          notified++;
        }
      }
      emitOrgEvent(req.user!.org_id, "shift_changed");

      ok(res, {
        message: `Schedule published. ${notified} employees notified via WhatsApp.`,
        week_start: ws.toISOString().split("T")[0],
        week_end: we.toISOString().split("T")[0],
        assignments: assignments.length,
        notified,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── GET /shifts/assignments/me ────────────────────────
router.get("/assignments/me", async (req, res, next) => {
  try {
    const today = parseDateOnly(new Date().toISOString().split("T")[0]);
    const future = addUtcDays(today, -1);
    const until = addUtcDays(today, 28);
    const assignments = await prisma.shiftAssignment.findMany({
      where: { user_id: req.user!.sub, date: { gte: future, lte: until } },
      include: {
        shift: {
          include: {
            breaks: { orderBy: { after_minutes: "asc" } },
            checkpoints: {
              where: { active: true },
              orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
              select: {
                id: true,
                name: true,
                instructions: true,
                sort_order: true,
                required: true,
                minimum_interval_mins: true,
              },
            },
          },
        },
      },
      orderBy: { date: "asc" },
    });
    ok(res, assignments);
  } catch (e) {
    next(e);
  }
});

// ─── GET /shifts/swaps/me ──────────────────────────────
router.get("/swaps/me", async (req, res, next) => {
  try {
    const swaps = await prisma.shiftSwap.findMany({
      where: {
        OR: [{ requester_id: req.user!.sub }, { target_id: req.user!.sub }],
      },
      include: {
        requester: { select: { id: true, name: true } },
        target: { select: { id: true, name: true } },
        requester_assignment: { include: { shift: true } },
        target_assignment: { include: { shift: true } },
      },
      orderBy: { created_at: "desc" },
    });
    ok(res, swaps);
  } catch (e) {
    next(e);
  }
});

// ─── GET /shifts/swaps ─────────────────────────────────
router.get(
  "/swaps",
  requirePermission("shifts.swaps.approve"),
  async (req, res, next) => {
    try {
      const swaps = await prisma.shiftSwap.findMany({
        where: {
          OR: [
            { requester: { org_id: req.user!.org_id } },
            { target: { org_id: req.user!.org_id } },
          ],
        },
        include: {
          requester: { select: { id: true, name: true } },
          target: { select: { id: true, name: true } },
          requester_assignment: { include: { shift: true } },
          target_assignment: { include: { shift: true } },
        },
        orderBy: { created_at: "desc" },
      });
      ok(res, swaps);
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /shifts/swaps ────────────────────────────────
router.post(
  "/swaps",
  validate({ body: swapRequestSchema }),
  async (req, res, next) => {
    try {
      const { submitShiftSwap } =
        await import("../services/shift-swap-request");
      const swap = await submitShiftSwap(
        req.user!.sub,
        req.user!.org_id,
        req.body,
      );
      ok(res, swap, 201);
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/swaps/:id/approve ────────────────────
router.put(
  "/swaps/:id/approve",
  requirePermission("shifts.swaps.approve"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const swap = (await prisma.shiftSwap.findFirst({
        where: { id, requester: { org_id: req.user!.org_id } },
        include: { requester_assignment: true, target_assignment: true },
      })) as any;
      if (!swap) throw new NotFoundError("Swap request");

      await prisma.$transaction(async (tx) => {
        // Swap the shift_ids between the two assignments
        await tx.shiftAssignment.update({
          where: { id: swap.requester_assign_id },
          data: { shift_id: swap.target_assignment.shift_id },
        });
        await tx.shiftAssignment.update({
          where: { id: swap.target_assign_id },
          data: { shift_id: swap.requester_assignment.shift_id },
        });
        await tx.shiftSwap.update({
          where: { id: swap.id },
          data: { status: "approved", manager_id: req.user!.sub },
        });
      });
      emitOrgEvent(req.user!.org_id, "swap_changed");
      ok(res, { message: "Swap approved and schedules updated" });
    } catch (e) {
      next(e);
    }
  },
);

// ─── PUT /shifts/swaps/:id/reject ─────────────────────
router.put(
  "/swaps/:id/reject",
  requirePermission("shifts.swaps.approve"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const { reason } = req.body;
      if (!reason) throw new ValidationError("Rejection reason required");
      const swap = await prisma.shiftSwap.findFirst({
        where: { id, requester: { org_id: req.user!.org_id } },
      });
      if (!swap) throw new NotFoundError("Swap request");
      await prisma.shiftSwap.update({
        where: { id: swap.id },
        data: {
          status: "rejected",
          manager_id: req.user!.sub,
          rejection_reason: reason,
        },
      });
      emitOrgEvent(req.user!.org_id, "swap_changed");
      ok(res, { message: "Swap rejected" });
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /shifts/ai-schedule ─────────────────────────
// Describe staffing needs in plain English; AI returns a shift plan
router.post(
  "/ai-schedule",
  requirePermission("shifts.ai_schedule"),
  async (req, res, next) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey)
        throw new AppError(
          "AI scheduling is not configured. Set GEMINI_API_KEY on the backend.",
          503,
          "AI_NOT_CONFIGURED",
        );

      const description =
        typeof req.body?.description === "string"
          ? req.body.description.trim()
          : "";
      const department =
        typeof req.body?.department === "string"
          ? req.body.department.trim()
          : "";
      const requestedWeekStart =
        typeof req.body?.week_start === "string" && req.body.week_start.trim()
          ? parseDateOnly(req.body.week_start.trim(), "week_start")
          : startOfCurrentWeek();
      if (!description)
        throw new ValidationError("Describe the staffing coverage you need.");
      if (description.length > 4000)
        throw new ValidationError(
          "Scheduling description must be 4,000 characters or fewer.",
        );
      const weekStart = requestedWeekStart.toISOString().slice(0, 10);

      const existingShifts = await prisma.shift.findMany({
        where: { org_id: req.user!.org_id },
        select: {
          id: true,
          name: true,
          start_time: true,
          end_time: true,
          active_days: true,
          min_rest_hours: true,
        },
      });

      const employees = await prisma.user.findMany({
        where: {
          org_id: req.user!.org_id,
          is_active: true,
          deleted_at: null,
          ...(department ? { department } : {}),
        },
        select: { id: true, name: true, department: true, job_title: true },
      });
      const weekEnd = addUtcDays(requestedWeekStart, 6);
      const [
        approvedLeave,
        approvedAvailability,
        existingAssignments,
        coverageRules,
      ] = await Promise.all([
        prisma.leaveRequest.findMany({
          where: {
            org_id: req.user!.org_id,
            status: "approved",
            user_id: { in: employees.map((user) => user.id) },
            start_date: { lte: weekEnd },
            end_date: { gte: requestedWeekStart },
          },
          select: { user_id: true, start_date: true, end_date: true },
        }),
        prisma.shiftAvailability.findMany({
          where: {
            org_id: req.user!.org_id,
            status: "approved",
            user_id: { in: employees.map((user) => user.id) },
            kind: "unavailable",
          },
        }),
        prisma.shiftAssignment.findMany({
          where: {
            date: { gte: requestedWeekStart, lte: weekEnd },
            user_id: { in: employees.map((user) => user.id) },
            shift: { org_id: req.user!.org_id },
          },
          select: {
            user_id: true,
            shift_id: true,
            date: true,
            user: { select: { department: true } },
          },
        }),
        prisma.shiftCoverageRule.findMany({
          where: { org_id: req.user!.org_id },
          select: {
            shift_id: true,
            weekday: true,
            required_count: true,
            department: true,
          },
        }),
      ]);
      const schedulingContext = {
        approved_leave: approvedLeave.map((item) => ({
          user_id: item.user_id,
          from: item.start_date.toISOString().slice(0, 10),
          to: item.end_date.toISOString().slice(0, 10),
        })),
        unavailable: approvedAvailability.map((item) => ({
          user_id: item.user_id,
          date: item.date?.toISOString().slice(0, 10),
          weekday: item.weekday,
          starts_on: item.starts_on?.toISOString().slice(0, 10),
          ends_on: item.ends_on?.toISOString().slice(0, 10),
          start_time: item.start_time,
          end_time: item.end_time,
        })),
        already_scheduled: existingAssignments.map((item) => ({
          user_id: item.user_id,
          date: item.date.toISOString().slice(0, 10),
        })),
        coverage_targets: coverageRules,
      };

      const axios = await import("axios");
      const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      let aiRes;
      try {
        aiRes = await axios.default.post(
          endpoint,
          {
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `You are an HR scheduling assistant. Draft a shift plan from this request. Return only JSON matching this shape: {"plan":[{"user_id":"...","user_name":"...","shift_id":"...","shift_name":"...","dates":["YYYY-MM-DD"]}],"summary":"...","warnings":["..."]}. Only use listed employee and shift IDs, schedule only within the requested week, honor active weekdays, approved leave and unavailability, existing assignments, and coverage targets. Never schedule an employee twice on a date. The result is a draft for a manager to review; do not claim that it has been applied.\n\nRequest: ${description}\nWeek starting: ${weekStart}\nDepartment: ${department || "all"}\nAvailable shifts: ${JSON.stringify(existingShifts)}\nAvailable employees: ${JSON.stringify(employees)}\nExisting scheduling constraints: ${JSON.stringify(schedulingContext)}`,
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 2048,
              responseMimeType: "application/json",
            },
          },
          {
            headers: {
              "x-goog-api-key": apiKey,
              "content-type": "application/json",
            },
            timeout: 120_000,
          },
        );
      } catch (providerError: any) {
        const status = providerError?.response?.status;
        if (
          providerError?.code === "ECONNABORTED" ||
          providerError?.code === "ETIMEDOUT"
        ) {
          throw new AppError(
            "The AI scheduler timed out. Please try again with a shorter request.",
            504,
            "AI_TIMEOUT",
          );
        }
        if (status === 401 || status === 403)
          throw new AppError(
            "Gemini rejected the configured API key. Check GEMINI_API_KEY on the backend.",
            502,
            "AI_AUTH_FAILED",
          );
        if (status === 404)
          throw new AppError(
            `The configured Gemini model "${model}" was not found. Check GEMINI_MODEL.`,
            502,
            "AI_MODEL_NOT_FOUND",
          );
        throw new AppError(
          "Gemini could not create a schedule right now. Please try again.",
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const text = (aiRes.data?.candidates?.[0]?.content?.parts ?? [])
        .map((part: { text?: string }) => part.text ?? "")
        .join("\n")
        .trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch)
        throw new AppError(
          "Gemini returned an invalid schedule. Please try a more specific staffing request.",
          502,
          "AI_INVALID_RESPONSE",
        );
      let result: any;
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch {
        throw new AppError(
          "Gemini returned an unreadable schedule. Please try again.",
          502,
          "AI_INVALID_RESPONSE",
        );
      }
      if (!Array.isArray(result.plan) || typeof result.summary !== "string") {
        throw new AppError(
          "Gemini returned an incomplete schedule. Please try again.",
          502,
          "AI_INVALID_RESPONSE",
        );
      }
      const allowedUsers = new Map(
        employees.map((employee) => [employee.id, employee.name]),
      );
      const allowedShifts = new Map(
        existingShifts.map((shift) => [shift.id, shift.name]),
      );
      const shiftById = new Map(
        existingShifts.map((shift) => [shift.id, shift]),
      );
      const assignedDays = new Set<string>();
      const warnings = Array.isArray(result.warnings)
        ? result.warnings.filter(
            (warning: unknown): warning is string =>
              typeof warning === "string",
          )
        : [];
      const plan = result.plan.flatMap((entry: any) => {
        if (
          !allowedUsers.has(entry?.user_id) ||
          !allowedShifts.has(entry?.shift_id) ||
          !Array.isArray(entry?.dates)
        ) {
          warnings.push(
            "AI suggested an employee or shift that is unavailable; that assignment was omitted.",
          );
          return [];
        }
        const dates = entry.dates.filter((date: unknown) => {
          if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
            return false;
          const assignDate = new Date(`${date}T00:00:00.000Z`);
          if (
            Number.isNaN(assignDate.getTime()) ||
            assignDate < requestedWeekStart ||
            assignDate > weekEnd
          ) {
            warnings.push(
              `An assignment outside the requested week was omitted (${date}).`,
            );
            return false;
          }
          const dayKey = `${entry.user_id}:${date}`;
          if (assignedDays.has(dayKey)) {
            warnings.push(
              `${allowedUsers.get(entry.user_id)} was assigned more than once on ${date}; a duplicate assignment was omitted.`,
            );
            return false;
          }
          if (
            existingAssignments.some(
              (item) =>
                item.user_id === entry.user_id &&
                item.date.toISOString().slice(0, 10) === date,
            )
          ) {
            warnings.push(
              `${allowedUsers.get(entry.user_id)} already has a shift on ${date}; the conflicting suggestion was omitted.`,
            );
            return false;
          }
          const shift = shiftById.get(entry.shift_id);
          const weekday = (assignDate.getUTCDay() + 6) % 7;
          if (
            shift?.active_days.length &&
            !shift.active_days.includes(weekday)
          ) {
            warnings.push(
              `${shift.name} is not active on ${date}; the suggestion was omitted.`,
            );
            return false;
          }
          if (
            approvedLeave.some(
              (item) =>
                item.user_id === entry.user_id &&
                item.start_date <= assignDate &&
                item.end_date >= assignDate,
            )
          ) {
            warnings.push(
              `${allowedUsers.get(entry.user_id)} has approved leave on ${date}; the suggestion was omitted.`,
            );
            return false;
          }
          const blocked = approvedAvailability.some(
            (item) =>
              item.user_id === entry.user_id &&
              ((item.date && item.date.toISOString().slice(0, 10) === date) ||
                (item.weekday === weekday &&
                  (!item.starts_on || item.starts_on <= assignDate) &&
                  (!item.ends_on || item.ends_on >= assignDate))) &&
              (!item.start_time ||
                (timeToMins(shift!.start_time) < timeToMins(item.end_time!) &&
                  timeToMins(shift!.end_time) > timeToMins(item.start_time!))),
          );
          if (blocked) {
            warnings.push(
              `${allowedUsers.get(entry.user_id)} is marked unavailable on ${date}; the suggestion was omitted.`,
            );
            return false;
          }
          assignedDays.add(dayKey);
          return true;
        });
        return dates.length
          ? [
              {
                ...entry,
                user_name: allowedUsers.get(entry.user_id),
                shift_name: allowedShifts.get(entry.shift_id),
                dates,
              },
            ]
          : [];
      });
      for (const rule of coverageRules) {
        const matchingDates = Array.from({ length: 7 }, (_, offset) =>
          addUtcDays(requestedWeekStart, offset),
        ).filter((date) => (date.getUTCDay() + 6) % 7 === rule.weekday);
        for (const date of matchingDates) {
          const key = date.toISOString().slice(0, 10);
          const already = existingAssignments.filter(
            (item) =>
              item.shift_id === rule.shift_id &&
              item.date.toISOString().slice(0, 10) === key &&
              (!rule.department || item.user.department === rule.department),
          ).length;
          const proposed = plan.filter(
            (entry: any) =>
              entry.shift_id === rule.shift_id &&
              entry.dates.includes(key) &&
              (!rule.department ||
                employees.find((user) => user.id === entry.user_id)
                  ?.department === rule.department),
          ).length;
          if (already + proposed < rule.required_count)
            warnings.push(
              `${allowedShifts.get(rule.shift_id) ?? "Shift"} coverage is ${already + proposed}/${rule.required_count} for ${key}${rule.department ? ` in ${rule.department}` : ""}.`,
            );
        }
      }
      result = { plan, summary: result.summary, warnings };
      ok(res, result);
    } catch (e) {
      next(e);
    }
  },
);

// ─── GET /shifts/:id/breaks ────────────────────────────
// Must be registered after all literal two-segment routes (/assignments/me, /swaps/me)
router.get(
  "/:id/breaks",
  requirePermission("shifts.view"),
  async (req, res, next) => {
    try {
      const shift = await prisma.shift.findUnique({
        where: { id: req.params.id as string },
        include: { breaks: { orderBy: { after_minutes: "asc" } } },
      });
      if (!shift || shift.org_id !== req.user!.org_id)
        throw new NotFoundError("Shift");
      ok(res, shift.breaks);
    } catch (e) {
      next(e);
    }
  },
);

// ─── GET /shifts/:id ───────────────────────────────────
// Must be registered after all literal single-segment routes (/schedule, /assignments, /swaps)
router.get("/:id", requirePermission("shifts.view"), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findUnique({
      where: { id: req.params.id as string },
      include: { breaks: { orderBy: { after_minutes: "asc" } } },
    });
    if (!shift || shift.org_id !== req.user!.org_id)
      throw new NotFoundError("Shift");
    ok(res, shift);
  } catch (e) {
    next(e);
  }
});

export default router;
