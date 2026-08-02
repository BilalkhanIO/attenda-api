import { Router, Request } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { onboardingTemplateSchema, onboardingAssignSchema } from '../schemas';
import { ok, created, NotFoundError, ForbiddenError, AppError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { createNotification } from '../services/notifications';
import { resolveUserPermissions } from '../services/authorization';
import {
  materializeOnboardingTasks,
  onboardingProgress,
  isOnboardingComplete,
} from '../services/onboarding';

/**
 * Onboarding checklists: HR builds templates of items (owned by the hire or
 * their manager), assigns them to new hires — items materialize as tasks
 * with resolved assignees and due dates — and everyone works their own task
 * list via /me. onboarding.manage gates template CRUD + assignment,
 * onboarding.view_team gates per-hire progress. Mounted at /onboarding.
 */

const router = Router();
router.use(authenticate);

const TEMPLATE_INCLUDE = {
  items:   { orderBy: { sort_order: 'asc' as const } },
  creator: { select: { id: true, name: true } },
} as const;

const TASK_INCLUDE = {
  user:     { select: { id: true, name: true, avatar_url: true, department: true } },
  assignee: { select: { id: true, name: true, avatar_url: true } },
} as const;

type TemplateItemInput = {
  title: string;
  description?: string | null;
  due_days?: number | null;
  sort_order?: number;
  assignee_role?: 'employee' | 'manager';
};

function itemRows(templateId: string, items: TemplateItemInput[]) {
  return items.map((item, i) => ({
    template_id: templateId,
    title: item.title,
    description: item.description ?? null,
    due_days: item.due_days ?? null,
    sort_order: item.sort_order ?? i,
    assignee_role: item.assignee_role ?? 'employee',
  }));
}

// ─── GET /onboarding/templates ─────────────────────────
router.get('/templates', requirePermission('onboarding.manage'), async (req, res, next) => {
  try {
    const templates = await prisma.onboardingTemplate.findMany({
      where: { org_id: req.user!.org_id, deleted_at: null },
      include: TEMPLATE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    ok(res, templates);
  } catch (e) { next(e); }
});

// ─── POST /onboarding/templates ────────────────────────
router.post('/templates', requirePermission('onboarding.manage'), validate({ body: onboardingTemplateSchema }), async (req, res, next) => {
  try {
    const { name, is_default, items } = req.body as {
      name: string; is_default?: boolean; items: TemplateItemInput[];
    };

    const template = await prisma.$transaction(async tx => {
      // Only one default per org — the newest default wins.
      if (is_default) {
        await tx.onboardingTemplate.updateMany({
          where: { org_id: req.user!.org_id, is_default: true, deleted_at: null },
          data: { is_default: false },
        });
      }
      const t = await tx.onboardingTemplate.create({
        data: {
          org_id: req.user!.org_id, name,
          is_default: is_default ?? false,
          created_by: req.user!.sub,
        },
      });
      await tx.onboardingTemplateItem.createMany({ data: itemRows(t.id, items) });
      return tx.onboardingTemplate.findUniqueOrThrow({
        where: { id: t.id }, include: TEMPLATE_INCLUDE,
      });
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'onboarding_template.create', entityType: 'onboarding_template', entityId: template.id,
      after: { name, is_default: is_default ?? false, items: items.length },
    });

    created(res, template);
  } catch (e) { next(e); }
});

// ─── PUT /onboarding/templates/:id ─────────────────────
// Replaces fields and items wholesale (delete-and-recreate).
router.put('/templates/:id', requirePermission('onboarding.manage'), validate({ body: onboardingTemplateSchema }), async (req, res, next) => {
  try {
    const { name, is_default, items } = req.body as {
      name: string; is_default?: boolean; items: TemplateItemInput[];
    };
    const existing = await prisma.onboardingTemplate.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, deleted_at: null },
      include: { items: true },
    });
    if (!existing) throw new NotFoundError('Onboarding template');

    const template = await prisma.$transaction(async tx => {
      if (is_default) {
        await tx.onboardingTemplate.updateMany({
          where: { org_id: req.user!.org_id, is_default: true, deleted_at: null, id: { not: existing.id } },
          data: { is_default: false },
        });
      }
      await tx.onboardingTemplate.update({
        where: { id: existing.id },
        data: { name, is_default: is_default ?? false },
      });
      await tx.onboardingTemplateItem.deleteMany({ where: { template_id: existing.id } });
      await tx.onboardingTemplateItem.createMany({ data: itemRows(existing.id, items) });
      return tx.onboardingTemplate.findUniqueOrThrow({
        where: { id: existing.id }, include: TEMPLATE_INCLUDE,
      });
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'onboarding_template.update', entityType: 'onboarding_template', entityId: existing.id,
      before: { name: existing.name, is_default: existing.is_default, items: existing.items.length },
      after: { name, is_default: is_default ?? false, items: items.length },
    });

    ok(res, template);
  } catch (e) { next(e); }
});

// ─── DELETE /onboarding/templates/:id ──────────────────
router.delete('/templates/:id', requirePermission('onboarding.manage'), async (req, res, next) => {
  try {
    const existing = await prisma.onboardingTemplate.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, deleted_at: null },
    });
    if (!existing) throw new NotFoundError('Onboarding template');

    await prisma.onboardingTemplate.update({
      where: { id: existing.id },
      data: { deleted_at: new Date() },
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'onboarding_template.delete', entityType: 'onboarding_template', entityId: existing.id,
      before: { name: existing.name, is_default: existing.is_default },
      after: { deleted_at: new Date().toISOString() },
    });

    ok(res, { id: existing.id, deleted: true });
  } catch (e) { next(e); }
});

// ─── POST /onboarding/assign ───────────────────────────
// Materializes the template's items as tasks for the hire. Idempotent per
// (user, template) — re-assigning is a no-op with skipped: true.
router.post('/assign', requirePermission('onboarding.manage'), validate({ body: onboardingAssignSchema }), async (req, res, next) => {
  try {
    const { user_id, template_id } = req.body as { user_id: string; template_id: string };

    const result = await materializeOnboardingTasks(req.user!.org_id, user_id, template_id);

    if (!result.skipped) {
      recordAudit({
        orgId: req.user!.org_id, actorId: req.user!.sub,
        action: 'onboarding.assign', entityType: 'onboarding_template', entityId: template_id,
        after: { user_id, tasks_created: result.created, assignee_ids: result.assignee_ids },
      });
    }

    ok(res, { user_id, template_id, created: result.created, skipped: result.skipped });
  } catch (e) { next(e); }
});

// ─── GET /onboarding/me ────────────────────────────────
// Tasks assigned to the caller (own onboarding and, for managers, their
// hires' manager-side items) — pending first, then terminal states.
router.get('/me', async (req, res, next) => {
  try {
    const tasks = await prisma.onboardingTask.findMany({
      where: { assignee_id: req.user!.sub },
      include: TASK_INCLUDE,
      orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }],
    });
    const pending = tasks.filter(t => t.status === 'pending');
    const rest    = tasks.filter(t => t.status !== 'pending');
    ok(res, [...pending, ...rest]);
  } catch (e) { next(e); }
});

// ─── GET /onboarding/user/:userId ──────────────────────
// A hire's full checklist + progress, for HR/managers.
router.get('/user/:userId', requirePermission('onboarding.view_team'), async (req, res, next) => {
  try {
    const hire = await prisma.user.findFirst({
      where: { id: String(req.params.userId), org_id: req.user!.org_id },
      select: { id: true, name: true, avatar_url: true, department: true },
    });
    if (!hire) throw new NotFoundError('User');

    const tasks = await prisma.onboardingTask.findMany({
      where: { user_id: hire.id, org_id: req.user!.org_id },
      include: TASK_INCLUDE,
      orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }],
    });

    ok(res, { user: hire, tasks, progress: onboardingProgress(tasks) });
  } catch (e) { next(e); }
});

// ─── PUT /onboarding/tasks/:id/complete | /skip ────────
// Allowed for the task's assignee or anyone with onboarding.manage. When
// the hire's last pending task closes, their manager and the completer get
// an onboarding_complete notification.
async function closeTask(
  req: Request,
  taskId: string,
  status: 'done' | 'skipped',
) {
  const task = await prisma.onboardingTask.findFirst({
    where: { id: taskId, org_id: req.user!.org_id },
    include: { user: { select: { id: true, name: true, manager_id: true } } },
  });
  if (!task) throw new NotFoundError('Onboarding task');

  if (task.assignee_id !== req.user!.sub) {
    const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    if (!perms.has('onboarding.manage')) throw new ForbiddenError();
  }
  if (task.status !== 'pending') {
    throw new AppError(`Task is already '${task.status}'`, 400, 'INVALID_STATUS');
  }

  const updated = await prisma.onboardingTask.update({
    where: { id: task.id },
    data: { status, completed_at: new Date(), completed_by: req.user!.sub },
    include: TASK_INCLUDE,
  });

  recordAudit({
    orgId: req.user!.org_id, actorId: req.user!.sub,
    action: `onboarding_task.${status === 'done' ? 'complete' : 'skip'}`,
    entityType: 'onboarding_task', entityId: task.id,
    before: { status: 'pending' },
    after: { status, user_id: task.user_id, item_title: task.item_title },
  });

  // Checklist-complete fan-out when the hire has no pending tasks left.
  const allTasks = await prisma.onboardingTask.findMany({
    where: { user_id: task.user_id, org_id: req.user!.org_id },
    select: { status: true },
  });
  if (isOnboardingComplete(allTasks)) {
    const recipients = [...new Set(
      [task.user.manager_id, req.user!.sub].filter((id): id is string => !!id),
    )];
    for (const userId of recipients) {
      createNotification({
        userId, orgId: req.user!.org_id,
        type: 'onboarding_complete',
        title: 'Onboarding complete',
        body: `${task.user.name} has completed all onboarding tasks`,
        actionType: 'onboarding_user', actionId: task.user_id,
      }).catch(() => {});
    }
  }

  return updated;
}

router.put('/tasks/:id/complete', async (req, res, next) => {
  try {
    ok(res, await closeTask(req, String(req.params.id), 'done'));
  } catch (e) { next(e); }
});

router.put('/tasks/:id/skip', async (req, res, next) => {
  try {
    ok(res, await closeTask(req, String(req.params.id), 'skipped'));
  } catch (e) { next(e); }
});

export default router;
