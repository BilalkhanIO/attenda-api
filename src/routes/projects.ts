import { Router, type RequestHandler } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { created, noContent, NotFoundError, ok, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { resolveUserPermissions } from '../services/authorization';
import { createNotification, emitOrgEvent } from '../services/notifications';
import { getSignedUploadUrl, getSignedDownloadUrl, isS3Configured } from '../services/s3';
import { AppError } from '../utils/response';
import { randomUUID } from 'node:crypto';
import { idempotency } from '../middleware/idempotency';
import multer from 'multer';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';

const router = Router();
router.use(authenticate);
const localFilesDir = join(tmpdir(), 'attenda-project-files');
const localUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function canAccessProject(projectId: string, userId: string, orgId: string): Promise<boolean> {
  const permissions = await resolveUserPermissions(userId, orgId);
  if (permissions.has('projects.manage')) return true;
  const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: projectId, user_id: userId } } });
  if (member) return true;
  return !!await prisma.projectTask.findFirst({ where: { project_id: projectId, assignee_id: userId }, select: { id: true } });
}

const ensureTaskCommentAccess: RequestHandler = async (req, _res, next) => {
  try {
    const task = await prisma.projectTask.findFirst({ where: { id: String(req.params.taskId), project: { org_id: req.user!.org_id } }, select: { project_id: true } });
    if (!task || !await canAccessProject(task.project_id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project task');
    next();
  } catch (error) { next(error); }
};

const ensureTaskUpdateAccess: RequestHandler = async (req, _res, next) => {
  try {
    const task = await prisma.projectTask.findFirst({ where: { id: String(req.params.taskId), project: { org_id: req.user!.org_id } }, select: { project_id: true, assignee_id: true } });
    if (!task) throw new NotFoundError('Project task');
    const permissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    if (!permissions.has('projects.tasks.manage') && task.assignee_id !== req.user!.sub) throw new NotFoundError('Project task');
    next();
  } catch (error) { next(error); }
};

const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const projectInclude = {
  owner: { select: { id: true, name: true, avatar_url: true } },
  members: { include: { user: { select: { id: true, name: true, avatar_url: true, department: true } } } },
  tasks: {
    include: {
      assignee: { select: { id: true, name: true, avatar_url: true } },
      comments: { include: { user: { select: { id: true, name: true, avatar_url: true } } }, orderBy: { created_at: 'asc' as const } },
      dependencies: { include: { depends_on: { select: { id: true, title: true, status: true } } } },
      subtasks: { select: { id: true, title: true, status: true, assignee: { select: { id: true, name: true } } } },
      attachments: { select: { id: true, task_id: true, file_name: true, file_size: true, mime_type: true, uploaded_by: true, created_at: true, uploader: { select: { id: true, name: true } } }, orderBy: { created_at: 'desc' as const } },
    },
    orderBy: { created_at: 'desc' as const },
  },
  attachments: { select: { id: true, task_id: true, file_name: true, file_size: true, mime_type: true, uploaded_by: true, created_at: true, uploader: { select: { id: true, name: true } } }, orderBy: { created_at: 'desc' as const } },
} as const;

const parseDate = (value: unknown, field: string) => {
  if (!value) return null;
  const date = new Date(`${String(value)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date`);
  return date;
};

router.get('/', requirePermission('projects.view'), async (req, res, next) => {
  try {
    const canManage = req.permissions?.has('projects.manage') ?? false;
    const projects = await prisma.project.findMany({
      where: {
        org_id: req.user!.org_id,
        ...(canManage ? {} : {
          OR: [
            { owner_id: req.user!.sub },
            { members: { some: { user_id: req.user!.sub } } },
            { tasks: { some: { assignee_id: req.user!.sub } } },
          ],
        }),
      },
      include: projectInclude,
      orderBy: { updated_at: 'desc' },
    });
    ok(res, projects);
  } catch (error) { next(error); }
});

router.post('/', requirePermission('projects.manage'), idempotency, async (req, res, next) => {
  try {
    const { name, description, priority = 'medium', start_date, due_date, member_ids = [], budget_hours } = req.body;
    if (!String(name ?? '').trim()) throw new ValidationError('Project name is required');
    if (!PRIORITIES.includes(priority)) throw new ValidationError('Invalid project priority');
    if (budget_hours !== undefined && budget_hours !== null && (!Number.isFinite(Number(budget_hours)) || Number(budget_hours) <= 0)) throw new ValidationError('Budget hours must be a positive number');
    const uniqueMembers = [...new Set([req.user!.sub, ...member_ids.map(String)])];
    const validCount = await prisma.user.count({ where: { id: { in: uniqueMembers }, org_id: req.user!.org_id, deleted_at: null } });
    if (validCount !== uniqueMembers.length) throw new ValidationError('One or more project members are invalid');

    const project = await prisma.project.create({
      data: {
        org_id: req.user!.org_id,
        owner_id: req.user!.sub,
        name: String(name).trim(), description: description?.trim() || null, priority,
        start_date: parseDate(start_date, 'start_date'), due_date: parseDate(due_date, 'due_date'),
        budget_hours: budget_hours === undefined || budget_hours === null ? null : Number(budget_hours),
        members: { create: uniqueMembers.map(user_id => ({ user_id, role: user_id === req.user!.sub ? 'owner' : 'member' })) },
      },
      include: projectInclude,
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.create', entityType: 'project', entityId: project.id, after: { name, priority } });
    created(res, project);
  } catch (error) { next(error); }
});

router.put('/:id', requirePermission('projects.manage'), idempotency, async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    const { name, description, status, priority, start_date, due_date, status_options, budget_hours } = req.body;
    if (status && !PROJECT_STATUSES.includes(status)) throw new ValidationError('Invalid project status');
    if (priority && !PRIORITIES.includes(priority)) throw new ValidationError('Invalid project priority');
    if (budget_hours !== undefined && budget_hours !== null && (!Number.isFinite(Number(budget_hours)) || Number(budget_hours) <= 0)) throw new ValidationError('Budget hours must be a positive number');
    if (status_options !== undefined) {
      if (!Array.isArray(status_options) || status_options.length < 2 || status_options.length > 12 || !status_options.includes('todo') || status_options.some((value: unknown) => typeof value !== 'string' || !/^[a-z][a-z0-9_]{1,29}$/.test(value)) || new Set(status_options).size !== status_options.length) {
        throw new ValidationError('Task statuses must contain 2–12 unique labels using letters, numbers, and underscores');
      }
      const usedStatuses = await prisma.projectTask.findMany({ where: { project_id: project.id }, distinct: ['status'], select: { status: true } });
      if (usedStatuses.some(task => !status_options.includes(task.status))) throw new ValidationError('Existing task statuses cannot be removed');
    }
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(status && { status }), ...(priority && { priority }),
        ...(start_date !== undefined && { start_date: parseDate(start_date, 'start_date') }),
        ...(due_date !== undefined && { due_date: parseDate(due_date, 'due_date') }),
        ...(budget_hours !== undefined && { budget_hours: budget_hours === null ? null : Number(budget_hours) }),
        ...(status_options !== undefined && { status_options }),
      },
      include: projectInclude,
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.update', entityType: 'project', entityId: project.id, before: { status: project.status, priority: project.priority }, after: { status: updated.status, priority: updated.priority } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/members', requirePermission('projects.manage'), idempotency, async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    const user = await prisma.user.findFirst({ where: { id: String(req.body.user_id), org_id: req.user!.org_id, deleted_at: null } });
    if (!user) throw new NotFoundError('User');
    await prisma.projectMember.upsert({
      where: { project_id_user_id: { project_id: project.id, user_id: user.id } },
      update: { role: req.body.role || 'member' },
      create: { project_id: project.id, user_id: user.id, role: req.body.role || 'member' },
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.member.add', entityType: 'project', entityId: project.id, after: { user_id: user.id } });
    ok(res, await prisma.project.findUnique({ where: { id: project.id }, include: projectInclude }));
  } catch (error) { next(error); }
});

router.delete('/:id/members/:userId', requirePermission('projects.manage'), idempotency, async (req, res, next) => {
  try {
    const projectId = String(req.params.id);
    const userId = String(req.params.userId);
    const project = await prisma.project.findFirst({ where: { id: projectId, org_id: req.user!.org_id }, select: { id: true, owner_id: true } });
    if (!project) throw new NotFoundError('Project');
    if (project.owner_id === userId) throw new ValidationError('The project owner cannot be removed. Transfer ownership first.');
    const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: projectId, user_id: userId } }, include: { user: { select: { name: true } } } });
    if (!member) throw new NotFoundError('Project member');
    const assignedOpenTasks = await prisma.projectTask.count({ where: { project_id: projectId, assignee_id: userId, status: { not: 'done' } } });
    if (assignedOpenTasks) throw new AppError(`Reassign or complete ${assignedOpenTasks} open task(s) before removing this member.`, 409, 'PROJECT_MEMBER_HAS_OPEN_TASKS');
    await prisma.$transaction(async tx => {
      await tx.projectMember.delete({ where: { project_id_user_id: { project_id: projectId, user_id: userId } } });
      await tx.auditLog.create({ data: { org_id: req.user!.org_id, actor_id: req.user!.sub, action: 'project.member.remove', entity_type: 'project', entity_id: projectId, before: { user_id: userId, role: member.role }, after: { user_id: userId, removed: true } } });
    });
    emitOrgEvent(req.user!.org_id, 'project_changed');
    noContent(res);
  } catch (error) { next(error); }
});

router.post('/:id/tasks', requirePermission('projects.tasks.manage'), idempotency, async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    const { title, description, assignee_id, priority = 'medium', start_date, due_date, performance_goal_id, parent_task_id, depends_on_ids = [], is_milestone = false } = req.body;
    if (!String(title ?? '').trim()) throw new ValidationError('Task title is required');
    if (!PRIORITIES.includes(priority)) throw new ValidationError('Invalid task priority');
    if (assignee_id) {
      const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: project.id, user_id: String(assignee_id) } } });
      if (!member) throw new ValidationError('Task assignee must be a project member');
    }
    if (performance_goal_id) {
      const goal = await prisma.performanceGoal.findFirst({ where: { id: String(performance_goal_id), user: { org_id: req.user!.org_id } }, select: { id: true, user_id: true } });
      if (!goal || (assignee_id && goal.user_id !== assignee_id)) throw new ValidationError('Linked performance goal must belong to the task assignee');
    }
    if (parent_task_id && !await prisma.projectTask.findFirst({ where: { id: String(parent_task_id), project_id: project.id } })) throw new NotFoundError('Parent task');
    if (!Array.isArray(depends_on_ids) || depends_on_ids.some((id: unknown) => typeof id !== 'string')) throw new ValidationError('Invalid task dependencies');
    const uniqueDependencies = [...new Set(depends_on_ids.map(String))];
    if (uniqueDependencies.length) {
      const matching = await prisma.projectTask.count({ where: { id: { in: uniqueDependencies }, project_id: project.id } });
      if (matching !== uniqueDependencies.length) throw new ValidationError('Dependencies must be tasks in the same project');
    }
    const task = await prisma.projectTask.create({
      data: { project_id: project.id, created_by: req.user!.sub, title: String(title).trim(), description: description?.trim() || null, assignee_id: assignee_id || null, priority, start_date: parseDate(start_date, 'start_date'), due_date: parseDate(due_date, 'due_date'), performance_goal_id: performance_goal_id || null, parent_task_id: parent_task_id || null, is_milestone: Boolean(is_milestone), dependencies: { create: uniqueDependencies.map(depends_on_id => ({ depends_on_id })) } },
      include: { assignee: { select: { id: true, name: true, avatar_url: true } } },
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.task.create', entityType: 'project_task', entityId: task.id, after: { title: task.title, assignee_id: task.assignee_id, parent_task_id: task.parent_task_id } });
    if (assignee_id && assignee_id !== req.user!.sub) {
      createNotification({ userId: assignee_id, orgId: req.user!.org_id, type: 'project_task_assigned', title: 'A project task was assigned to you', body: `${task.title} · ${project.name}`, actionType: 'project_task', actionId: task.id }).catch(() => {});
    }
    emitOrgEvent(req.user!.org_id, 'project_changed');
    created(res, task);
  } catch (error) { next(error); }
});

router.post('/tasks/:taskId/comments', ensureTaskCommentAccess, idempotency, async (req, res, next) => {
  try {
    const task = await prisma.projectTask.findFirst({ where: { id: String(req.params.taskId), project: { org_id: req.user!.org_id } }, select: { id: true, project_id: true, title: true, assignee_id: true } });
    if (!task) throw new NotFoundError('Project task');
    if (!await canAccessProject(task.project_id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project task');
    const body = String(req.body.body ?? '').trim();
    if (!body || body.length > 5000) throw new ValidationError('Comment is required and must be under 5,000 characters');
    const comment = await prisma.projectTaskComment.create({ data: { task_id: task.id, user_id: req.user!.sub, body }, include: { user: { select: { id: true, name: true, avatar_url: true } } } });
    const notifiedUsers = new Set<string>();
    const mentionEmails = [...body.matchAll(/@([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)].map(match => match[1].toLowerCase());
    const mentioned = mentionEmails.length ? await prisma.user.findMany({ where: { org_id: req.user!.org_id, deleted_at: null, email: { in: [...new Set(mentionEmails)] } }, select: { id: true } }) : [];
    for (const user of mentioned) {
      if (user.id === req.user!.sub) continue;
      notifiedUsers.add(user.id);
      createNotification({ userId: user.id, orgId: req.user!.org_id, type: 'project_task_comment', title: 'You were mentioned on a task', body: `${task.title} · ${body.slice(0, 120)}`, actionType: 'project_task', actionId: task.id }).catch(() => {});
    }
    if (task.assignee_id && task.assignee_id !== req.user!.sub && !notifiedUsers.has(task.assignee_id)) {
      createNotification({ userId: task.assignee_id, orgId: req.user!.org_id, type: 'project_task_comment', title: 'New comment on your task', body: `${task.title} · ${body.slice(0, 120)}`, actionType: 'project_task', actionId: task.id }).catch(() => {});
    }
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.task.comment', entityType: 'project_task', entityId: task.id, after: { comment_id: comment.id } });
    emitOrgEvent(req.user!.org_id, 'project_changed');
    created(res, comment);
  } catch (error) { next(error); }
});

router.put('/tasks/:taskId', ensureTaskUpdateAccess, idempotency, async (req, res, next) => {
  try {
    const task = await prisma.projectTask.findFirst({ where: { id: String(req.params.taskId), project: { org_id: req.user!.org_id } }, include: { project: { select: { status_options: true } } } });
    if (!task) throw new NotFoundError('Project task');
    const permissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    const canManage = permissions.has('projects.tasks.manage');
    if (!canManage && task.assignee_id !== req.user!.sub) throw new NotFoundError('Project task');
    const { title, description, status, priority, assignee_id, start_date, due_date, is_milestone, depends_on_ids } = req.body;
    if (status && !task.project.status_options.includes(status)) throw new ValidationError('Invalid task status');
    if (priority && !PRIORITIES.includes(priority)) throw new ValidationError('Invalid task priority');
    let uniqueDependencies: string[] | undefined;
    if (canManage && depends_on_ids !== undefined) {
      if (!Array.isArray(depends_on_ids) || depends_on_ids.some((id: unknown) => typeof id !== 'string' || id === task.id)) throw new ValidationError('Invalid task dependencies');
      uniqueDependencies = [...new Set(depends_on_ids.map(String))];
      const matching = uniqueDependencies.length ? await prisma.projectTask.count({ where: { id: { in: uniqueDependencies }, project_id: task.project_id } }) : 0;
      if (matching !== uniqueDependencies.length) throw new ValidationError('Dependencies must be tasks in the same project');
    }
    const previousAssignee = task.assignee_id;
    if (canManage && assignee_id) {
      const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: task.project_id, user_id: String(assignee_id) } }, select: { user_id: true } });
      if (!member) throw new ValidationError('Task assignee must be a project member. Add them to the project first.');
    }
    const updateData = {
      ...(canManage && title !== undefined && { title: String(title).trim() }),
      ...(canManage && description !== undefined && { description: description?.trim() || null }),
      ...(canManage && priority && { priority }), ...(canManage && assignee_id !== undefined && { assignee_id: assignee_id || null }),
      ...(canManage && start_date !== undefined && { start_date: parseDate(start_date, 'start_date') }),
      ...(canManage && due_date !== undefined && { due_date: parseDate(due_date, 'due_date') }),
      ...(canManage && is_milestone !== undefined && { is_milestone: Boolean(is_milestone) }),
      ...(canManage && uniqueDependencies !== undefined && { dependencies: { deleteMany: {}, create: uniqueDependencies.map(depends_on_id => ({ depends_on_id })) } }),
      ...(status && { status, completed_at: status === 'done' ? new Date() : null }),
    };
    let previousDependencyIds: string[] | undefined;
    const updateTask = (client: Pick<Prisma.TransactionClient, 'projectTask'>) => client.projectTask.update({
      where: { id: task.id },
      data: updateData,
      include: { assignee: { select: { id: true, name: true, avatar_url: true } } },
    });
    const updated = uniqueDependencies === undefined
      ? await updateTask(prisma)
      : await prisma.$transaction(async tx => {
          // Serialize dependency graph edits per project so concurrent edits
          // cannot both pass the cycle check and create a loop.
          await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${task.project_id} FOR UPDATE`;
          const edges = await tx.projectTaskDependency.findMany({
            where: { task: { project_id: task.project_id }, task_id: { not: task.id } },
            select: { task_id: true, depends_on_id: true },
          });
          previousDependencyIds = (await tx.projectTaskDependency.findMany({
            where: { task_id: task.id }, select: { depends_on_id: true },
          })).map(edge => edge.depends_on_id);
          const graph = new Map<string, string[]>();
          for (const edge of edges) graph.set(edge.task_id, [...(graph.get(edge.task_id) ?? []), edge.depends_on_id]);
          const reachesTask = (node: string, visited = new Set<string>()): boolean => {
            if (node === task.id) return true;
            if (visited.has(node)) return false;
            visited.add(node);
            return (graph.get(node) ?? []).some(next => reachesTask(next, visited));
          };
          if (uniqueDependencies.some(dependencyId => reachesTask(dependencyId))) {
            throw new ValidationError('These dependencies would create a cycle. Remove a dependency path that leads back to this task.');
          }
          return updateTask(tx);
        });
    if (Object.keys(updateData).length > 0) {
      recordAudit({
        orgId: req.user!.org_id,
        actorId: req.user!.sub,
        action: 'project.task.update',
        entityType: 'project_task',
        entityId: task.id,
        before: { title: task.title, description: task.description, status: task.status, assignee_id: previousAssignee, priority: task.priority, start_date: task.start_date, due_date: task.due_date, ...(previousDependencyIds && { depends_on_ids: previousDependencyIds }) },
        after: { title: updated.title, description: updated.description, status: updated.status, assignee_id: updated.assignee_id, priority: updated.priority, start_date: updated.start_date, due_date: updated.due_date, ...(uniqueDependencies && { depends_on_ids: uniqueDependencies }) },
      });
    }
    if (canManage && assignee_id && assignee_id !== previousAssignee && assignee_id !== req.user!.sub) {
      createNotification({ userId: assignee_id, orgId: req.user!.org_id, type: 'project_task_assigned', title: 'A project task was assigned to you', body: updated.title, actionType: 'project_task', actionId: updated.id }).catch(() => {});
    }
    if (status && status !== task.status && task.assignee_id && task.assignee_id !== req.user!.sub) {
      createNotification({ userId: task.assignee_id, orgId: req.user!.org_id, type: 'project_task_updated', title: 'A project task changed', body: `${updated.title} · ${status.replace('_', ' ')}`, actionType: 'project_task', actionId: updated.id }).catch(() => {});
    }
    if (updated.performance_goal_id) {
      const goal = await prisma.performanceGoal.findUnique({ where: { id: updated.performance_goal_id } });
      if (goal) {
        const linked = await prisma.projectTask.findMany({ where: { performance_goal_id: goal.id }, select: { status: true } });
        const completion = linked.length ? Math.round(linked.filter(item => item.status === 'done').length * 100 / linked.length) : 0;
        await prisma.performanceGoal.update({ where: { id: goal.id }, data: { completion } });
      }
    }
    emitOrgEvent(req.user!.org_id, 'project_changed');
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/attachments/upload-url', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    if (!await canAccessProject(project.id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project');
    const { file_name, mime_type, file_size, task_id } = req.body;
    const size = Number(file_size);
    if (!file_name || !mime_type || !Number.isFinite(size) || size <= 0 || size > 20 * 1024 * 1024) throw new ValidationError('Choose a file under 20 MB');
    if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/plain|application\/(vnd\.|msword|zip))/.test(mime_type)) throw new ValidationError('This file type is not supported');
    if (task_id && !await prisma.projectTask.findFirst({ where: { id: String(task_id), project_id: project.id } })) throw new NotFoundError('Project task');
    if (!isS3Configured()) {
      if (process.env.NODE_ENV === 'production') throw new AppError('File storage is not configured', 503, 'S3_NOT_CONFIGURED');
      ok(res, { storage: 'local' });
      return;
    }
    const safeName = String(file_name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
    const fileKey = `projects/${project.org_id}/${project.id}/${randomUUID()}-${safeName}`;
    const uploadUrl = await getSignedUploadUrl(fileKey, mime_type, 900);
    ok(res, { upload_url: uploadUrl, file_key: fileKey, headers: { 'Content-Type': mime_type }, expires_in: 900 });
  } catch (error) { next(error); }
});

router.post('/:id/attachments/upload-local', localUpload.single('file'), idempotency, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') throw new AppError('File storage is not configured', 503, 'S3_NOT_CONFIGURED');
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    if (!await canAccessProject(project.id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project');
    const file = req.file;
    if (!file) throw new ValidationError('Choose a file to upload');
    if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/plain|application\/(vnd\.|msword|zip))/.test(file.mimetype)) throw new ValidationError('This file type is not supported');
    const taskId = req.body.task_id ? String(req.body.task_id) : null;
    if (taskId && !await prisma.projectTask.findFirst({ where: { id: taskId, project_id: project.id } })) throw new NotFoundError('Project task');
    const fileKey = `local:${randomUUID()}`;
    await mkdir(localFilesDir, { recursive: true });
    await writeFile(join(localFilesDir, fileKey.slice('local:'.length)), file.buffer, { flag: 'wx' });
    const attachment = await prisma.projectAttachment.create({ data: {
      project_id: project.id, task_id: taskId, uploaded_by: req.user!.sub, file_key: fileKey,
      file_name: file.originalname.slice(0, 255), mime_type: file.mimetype, file_size: file.size,
    }, select: { id: true, task_id: true, file_name: true, file_size: true, mime_type: true, created_at: true } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.file.upload', entityType: 'project', entityId: project.id, after: { attachment_id: attachment.id, file_name: attachment.file_name } });
    emitOrgEvent(req.user!.org_id, 'project_changed');
    created(res, attachment);
  } catch (error) { next(error); }
});

router.post('/:id/attachments', idempotency, async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    if (!await canAccessProject(project.id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project');
    const { file_key, file_name, mime_type, file_size, task_id } = req.body;
    if (!String(file_key).startsWith(`projects/${project.org_id}/${project.id}/`)) throw new ValidationError('Invalid project file key');
    if (task_id && !await prisma.projectTask.findFirst({ where: { id: String(task_id), project_id: project.id } })) throw new NotFoundError('Project task');
    const attachment = await prisma.projectAttachment.create({ data: { project_id: project.id, task_id: task_id || null, uploaded_by: req.user!.sub, file_key, file_name, mime_type, file_size: Number(file_size) }, select: { id: true, task_id: true, file_name: true, file_size: true, mime_type: true, created_at: true } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'project.file.upload', entityType: 'project', entityId: project.id, after: { attachment_id: attachment.id, file_name: attachment.file_name } });
    emitOrgEvent(req.user!.org_id, 'project_changed');
    created(res, attachment);
  } catch (error) { next(error); }
});

router.get('/attachments/:attachmentId/download', async (req, res, next) => {
  try {
    const attachment = await prisma.projectAttachment.findFirst({ where: { id: String(req.params.attachmentId), project: { org_id: req.user!.org_id } } });
    if (!attachment) throw new NotFoundError('Project attachment');
    const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: attachment.project_id, user_id: req.user!.sub } } });
    if (!member && attachment.uploaded_by !== req.user!.sub && !req.permissions?.has('projects.manage')) throw new NotFoundError('Project attachment');
    if (attachment.file_key.startsWith('local:')) {
      ok(res, { local_download: true, file_name: attachment.file_name, mime_type: attachment.mime_type });
      return;
    }
    ok(res, { download_url: await getSignedDownloadUrl(attachment.file_key, 900), file_name: attachment.file_name, mime_type: attachment.mime_type, expires_in: 900 });
  } catch (error) { next(error); }
});

router.get('/attachments/:attachmentId/file', async (req, res, next) => {
  try {
    const attachment = await prisma.projectAttachment.findFirst({ where: { id: String(req.params.attachmentId), project: { org_id: req.user!.org_id } } });
    if (!attachment || !attachment.file_key.startsWith('local:')) throw new NotFoundError('Project attachment');
    const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: attachment.project_id, user_id: req.user!.sub } } });
    if (!member && attachment.uploaded_by !== req.user!.sub && !req.permissions?.has('projects.manage')) throw new NotFoundError('Project attachment');
    const buffer = await readFile(join(localFilesDir, attachment.file_key.slice('local:'.length)));
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`);
    res.send(buffer);
  } catch (error) { next(error); }
});

router.get('/:id/activity', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id }, select: { id: true } });
    if (!project || !await canAccessProject(project.id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project');
    const tasks = await prisma.projectTask.findMany({ where: { project_id: project.id }, select: { id: true } });
    const items = await prisma.auditLog.findMany({
      where: { org_id: req.user!.org_id, OR: [{ entity_type: 'project', entity_id: project.id }, { entity_type: 'project_task', entity_id: { in: tasks.map(task => task.id) } }] },
      orderBy: { created_at: 'desc' }, take: 50,
      select: { id: true, actor_id: true, action: true, entity_type: true, entity_id: true, after: true, created_at: true },
    });
    const actorIds = [...new Set(items.map(item => item.actor_id))];
    const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
    const actorNames = new Map(actors.map(actor => [actor.id, actor.name]));
    ok(res, items.map(item => ({ ...item, actor_name: actorNames.get(item.actor_id) ?? 'Former employee' })));
  } catch (error) { next(error); }
});

router.get('/:id/calendar.ics', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
      include: { tasks: { select: { id: true, title: true, description: true, status: true, start_date: true, due_date: true, assignee: { select: { name: true } } } } },
    });
    if (!project || !await canAccessProject(project.id, req.user!.sub, req.user!.org_id)) throw new NotFoundError('Project');
    const escapeIcs = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const toIcsDate = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, '');
    const events = project.tasks.filter(task => task.start_date || task.due_date).map(task => {
      const start = task.start_date ?? task.due_date!;
      const end = task.due_date ?? task.start_date!;
      const endExclusive = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      return [
        'BEGIN:VEVENT', `UID:${task.id}@attenda`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
        `DTSTART;VALUE=DATE:${toIcsDate(start)}`, `DTEND;VALUE=DATE:${toIcsDate(endExclusive)}`,
        `SUMMARY:${escapeIcs(task.title)}`, `DESCRIPTION:${escapeIcs(`${project.name} · ${task.status.replace('_', ' ')}${task.assignee ? ` · ${task.assignee.name}` : ''}${task.description ? `\n${task.description}` : ''}`)}`,
        'END:VEVENT',
      ].join('\r\n');
    });
    const calendar = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Attenda//Project Tasks//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}-tasks.ics"`);
    res.send(calendar);
  } catch (error) { next(error); }
});

router.delete('/:id', requirePermission('projects.manage'), idempotency, async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!project) throw new NotFoundError('Project');
    await prisma.project.delete({ where: { id: project.id } });
    noContent(res);
  } catch (error) { next(error); }
});

export default router;
