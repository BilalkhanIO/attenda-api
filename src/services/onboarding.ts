import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { createNotification } from './notifications';
import { NotFoundError } from '../utils/response';

/**
 * Onboarding checklist materialization. A template's items are copied into
 * per-hire OnboardingTask rows at assignment time: titles/descriptions are
 * denormalized (later template edits never rewrite in-flight checklists),
 * the assignee is resolved per item (employee items → the hire, manager
 * items → their manager, falling back to the hire when they have none),
 * and due dates are computed as assignment day + due_days.
 */

export interface OnboardingItemLike {
  title: string;
  description?: string | null;
  due_days?: number | null;
  sort_order?: number | null;
  assignee_role?: string | null;
}

/** Resolve who owns an item: 'manager' items go to the hire's manager,
 *  everything else (and manager-less hires) to the hire themselves. */
export function resolveItemAssignee(
  assigneeRole: string | null | undefined,
  hireId: string,
  managerId: string | null | undefined,
): string {
  return assigneeRole === 'manager' && managerId ? managerId : hireId;
}

/** Due date = start of the assignment's UTC day + due_days. null when the
 *  item has no due_days (undated tasks never show as overdue). */
export function dueDateFor(
  dueDays: number | null | undefined,
  assignedAt: Date,
): Date | null {
  if (dueDays === null || dueDays === undefined) return null;
  const day = new Date(Date.UTC(
    assignedAt.getUTCFullYear(), assignedAt.getUTCMonth(), assignedAt.getUTCDate(),
  ));
  day.setUTCDate(day.getUTCDate() + dueDays);
  return day;
}

/** Progress = tasks that reached a terminal state (done or skipped). */
export function onboardingProgress(
  tasks: Array<{ status: string }>,
): { done: number; total: number } {
  return {
    done: tasks.filter(t => t.status !== 'pending').length,
    total: tasks.length,
  };
}

/** true ⇒ the checklist exists and every task is done/skipped. */
export function isOnboardingComplete(tasks: Array<{ status: string }>): boolean {
  return tasks.length > 0 && tasks.every(t => t.status !== 'pending');
}

export interface MaterializeResult {
  created: number;
  /** true ⇒ tasks from this template already existed for the user. */
  skipped: boolean;
  assignee_ids: string[];
}

/**
 * Materialize a template's items as tasks for one hire and notify each
 * distinct assignee. Idempotent per (user, template): if any tasks from
 * that template already exist for the user, nothing is created.
 */
export async function materializeOnboardingTasks(
  orgId: string,
  userId: string,
  templateId: string,
  now = new Date(),
): Promise<MaterializeResult> {
  const template = await prisma.onboardingTemplate.findFirst({
    where: { id: templateId, org_id: orgId, deleted_at: null },
    include: { items: { orderBy: { sort_order: 'asc' } } },
  });
  if (!template) throw new NotFoundError('Onboarding template');

  const hire = await prisma.user.findFirst({
    where: { id: userId, org_id: orgId, deleted_at: null },
    select: { id: true, name: true, manager_id: true },
  });
  if (!hire) throw new NotFoundError('User');

  const existing = await prisma.onboardingTask.count({
    where: { user_id: userId, template_id: templateId },
  });
  if (existing > 0) return { created: 0, skipped: true, assignee_ids: [] };

  const rows = template.items.map(item => ({
    org_id: orgId,
    user_id: hire.id,
    item_title: item.title,
    item_description: item.description,
    assignee_id: resolveItemAssignee(item.assignee_role, hire.id, hire.manager_id),
    due_date: dueDateFor(item.due_days, now),
    template_id: template.id,
  }));
  if (rows.length) await prisma.onboardingTask.createMany({ data: rows });

  const assigneeIds = [...new Set(rows.map(r => r.assignee_id))];
  for (const assigneeId of assigneeIds) {
    const count = rows.filter(r => r.assignee_id === assigneeId).length;
    createNotification({
      userId: assigneeId, orgId,
      type: 'onboarding_assigned',
      title: 'Onboarding tasks assigned',
      body: assigneeId === hire.id
        ? `Your onboarding checklist "${template.name}" has ${count} task${count === 1 ? '' : 's'}`
        : `${hire.name}'s onboarding gives you ${count} task${count === 1 ? '' : 's'} ("${template.name}")`,
      actionType: 'onboarding_user', actionId: hire.id,
    }).catch(() => {});
  }

  return { created: rows.length, skipped: false, assignee_ids: assigneeIds };
}

/**
 * Best-effort auto-assign of the org's default template to a new user.
 * Never throws — failure to assign must not fail user creation.
 */
export async function autoAssignDefaultTemplate(
  orgId: string,
  userId: string,
): Promise<void> {
  try {
    const defaultTemplate = await prisma.onboardingTemplate.findFirst({
      where: { org_id: orgId, is_default: true, deleted_at: null },
      select: { id: true },
    });
    if (!defaultTemplate) return;
    await materializeOnboardingTasks(orgId, userId, defaultTemplate.id);
  } catch (err) {
    logger.error({ err, org_id: orgId, user_id: userId }, 'onboarding auto-assign failed');
  }
}
