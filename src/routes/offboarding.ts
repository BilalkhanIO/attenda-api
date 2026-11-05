import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import prisma from '../utils/prisma';
import { AppError, created, ForbiddenError, NotFoundError, ok, ValidationError } from '../utils/response';
import { recordAudit } from '../services/audit';
import { idempotency } from '../middleware/idempotency';

const router = Router();
router.use(authenticate);

const CASE_INCLUDE = {
  subject: { select: { id: true, name: true, email: true, department: true, manager_id: true, is_active: true } },
  opener: { select: { id: true, name: true } },
  tasks: { orderBy: { created_at: 'asc' as const }, include: { owner: { select: { id: true, name: true } }, completer: { select: { id: true, name: true } } } },
  assets: { orderBy: { created_at: 'asc' as const } },
  settlement: { include: { creator: { select: { id: true, name: true } }, reviewer: { select: { id: true, name: true } }, locker: { select: { id: true, name: true } } } },
} as const;

const validDateOnly = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

async function scopedCase(id: string, orgId: string) {
  const result = await prisma.offboardingCase.findFirst({ where: { id, org_id: orgId }, include: CASE_INCLUDE });
  if (!result) throw new NotFoundError('Offboarding case');
  return result;
}

router.get('/', requirePermission('offboarding.view_team'), async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const cases = await prisma.offboardingCase.findMany({
      where: { org_id: req.user!.org_id, ...(status ? { status } : {}) }, include: CASE_INCLUDE,
      orderBy: [{ last_working_day: 'asc' }, { created_at: 'desc' }], take: 100,
    });
    ok(res, cases);
  } catch (error) { next(error); }
});

router.post('/', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const { user_id, case_type, last_working_day, notice_at, confidential_reason, tasks = [], assets = [] } = req.body ?? {};
    if (typeof user_id !== 'string' || !['resignation', 'termination', 'contract_end', 'retirement'].includes(case_type)) throw new ValidationError('Select an employee and a valid offboarding type');
    if (!validDateOnly(last_working_day)) throw new ValidationError('Provide a valid last working date');
    if (!Array.isArray(tasks) || tasks.length > 50 || !Array.isArray(assets) || assets.length > 50) throw new ValidationError('A case may contain up to 50 tasks and 50 assets');
    const employee = await prisma.user.findFirst({ where: { id: user_id, org_id: req.user!.org_id, is_active: true, deleted_at: null }, select: { id: true } });
    if (!employee) throw new NotFoundError('Active employee');
    const duplicate = await prisma.offboardingCase.findFirst({ where: { org_id: req.user!.org_id, user_id, status: { notIn: ['completed', 'cancelled'] } }, select: { id: true } });
    if (duplicate) throw new AppError('An active offboarding case already exists for this employee', 409, 'OFFBOARDING_CASE_EXISTS');
    for (const task of tasks) if (!task || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 200) throw new ValidationError('Every checklist item needs a title (up to 200 characters)');
    for (const asset of assets) if (!asset || typeof asset.asset_name !== 'string' || !asset.asset_name.trim() || asset.asset_name.length > 200) throw new ValidationError('Every asset needs a name (up to 200 characters)');
    const ownerIds = [...new Set(tasks.map((task: any) => task.owner_id).filter((id: unknown): id is string => typeof id === 'string'))];
    if (ownerIds.length) {
      const owners = await prisma.user.findMany({ where: { id: { in: ownerIds }, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
      if (owners.length !== ownerIds.length) throw new ValidationError('All checklist owners must be active members of this organization');
    }
    for (const task of tasks) if (task.due_date !== undefined && !validDateOnly(task.due_date)) throw new ValidationError('Checklist due dates must be valid calendar dates');
    for (const asset of assets) if (asset.due_date !== undefined && !validDateOnly(asset.due_date)) throw new ValidationError('Asset due dates must be valid calendar dates');
    const row = await prisma.offboardingCase.create({ data: {
      org_id: req.user!.org_id, user_id, opened_by: req.user!.sub, case_type,
      last_working_day: new Date(`${last_working_day}T00:00:00.000Z`),
      notice_at: notice_at ? new Date(notice_at) : new Date(),
      confidential_reason: typeof confidential_reason === 'string' ? confidential_reason.slice(0, 5000) : null,
      status: 'in_progress',
      tasks: { create: tasks.map((task: any) => ({ title: task.title.trim(), description: typeof task.description === 'string' ? task.description.slice(0, 2000) : null, owner_id: typeof task.owner_id === 'string' ? task.owner_id : null, due_date: typeof task.due_date === 'string' ? new Date(`${task.due_date}T00:00:00.000Z`) : null })) },
      assets: { create: assets.map((asset: any) => ({ asset_name: asset.asset_name.trim(), serial_number: typeof asset.serial_number === 'string' ? asset.serial_number.slice(0, 120) : null, due_date: typeof asset.due_date === 'string' ? new Date(`${asset.due_date}T00:00:00.000Z`) : null })) },
    }, include: CASE_INCLUDE });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.case.create', entityType: 'offboarding_case', entityId: row.id, after: { user_id, case_type, last_working_day } });
    created(res, row);
  } catch (error) { next(error); }
});

router.get('/:id', requirePermission('offboarding.view_team'), async (req, res, next) => {
  try { ok(res, await scopedCase(String(req.params.id), req.user!.org_id)); }
  catch (error) { next(error); }
});

router.patch('/:id', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    if (item.status !== 'in_progress') throw new AppError('This case can no longer be edited', 409, 'OFFBOARDING_CASE_CLOSED');
    const { last_working_day, confidential_reason, status, cancellation_reason } = req.body ?? {};
    if (status !== undefined && status !== 'in_progress' && status !== 'cancelled') throw new ValidationError('Status must be in progress or cancelled');
    if (status === 'cancelled' && (typeof cancellation_reason !== 'string' || cancellation_reason.trim().length < 8)) throw new ValidationError('Provide a cancellation reason of at least 8 characters');
    if (last_working_day !== undefined && !validDateOnly(last_working_day)) throw new ValidationError('Provide a valid last working date');
    const updated = await prisma.offboardingCase.update({ where: { id: item.id }, data: {
      ...(last_working_day ? { last_working_day: new Date(`${last_working_day}T00:00:00.000Z`) } : {}),
      ...(confidential_reason !== undefined ? { confidential_reason: typeof confidential_reason === 'string' ? confidential_reason.slice(0, 5000) : null } : {}),
      ...(status ? { status, ...(status === 'cancelled' ? { cancellation_reason: String(cancellation_reason).trim().slice(0, 2000) } : {}) } : {}),
    }, include: CASE_INCLUDE });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.case.update', entityType: 'offboarding_case', entityId: item.id, before: { status: item.status, last_working_day: item.last_working_day }, after: { status: updated.status, last_working_day: updated.last_working_day } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/tasks', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    const { title, description, owner_id, due_date } = req.body ?? {};
    if (item.status !== 'in_progress' || typeof title !== 'string' || !title.trim() || title.length > 200) throw new ValidationError('An active case and valid task title are required');
    if (owner_id) {
      const owner = await prisma.user.findFirst({ where: { id: owner_id, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
      if (!owner) throw new NotFoundError('Task owner');
    }
    const task = await prisma.offboardingTask.create({ data: { case_id: item.id, title: title.trim(), description: typeof description === 'string' ? description.slice(0, 2000) : null, owner_id: owner_id ?? null, due_date: typeof due_date === 'string' ? new Date(`${due_date}T00:00:00.000Z`) : null } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.task.create', entityType: 'offboarding_task', entityId: task.id, after: { case_id: item.id, title: task.title } });
    created(res, task);
  } catch (error) { next(error); }
});

router.patch('/tasks/:taskId', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const task = await prisma.offboardingTask.findFirst({ where: { id: String(req.params.taskId), offboarding: { org_id: req.user!.org_id } }, include: { offboarding: true } });
    if (!task) throw new NotFoundError('Offboarding task');
    if (task.offboarding.status !== 'in_progress') throw new AppError('Tasks on a closed or access-revoked case cannot be changed', 409, 'OFFBOARDING_CASE_CLOSED');
    const { status, owner_id } = req.body ?? {};
    if (!['pending', 'done', 'skipped'].includes(status)) throw new ValidationError('Task status must be pending, done, or skipped');
    if (owner_id !== undefined && owner_id !== null) {
      const owner = await prisma.user.findFirst({ where: { id: owner_id, org_id: req.user!.org_id, is_active: true }, select: { id: true } });
      if (!owner) throw new NotFoundError('Active task owner');
    }
    const updated = await prisma.offboardingTask.update({ where: { id: task.id }, data: { status, owner_id: owner_id ?? task.owner_id, completed_at: status === 'pending' ? null : new Date(), completed_by: status === 'pending' ? null : req.user!.sub } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.task.update', entityType: 'offboarding_task', entityId: task.id, before: { status: task.status }, after: { status: updated.status } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/assets', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    const { asset_name, serial_number, due_date } = req.body ?? {};
    if (item.status !== 'in_progress' || typeof asset_name !== 'string' || !asset_name.trim()) throw new ValidationError('An active case and asset name are required');
    const asset = await prisma.offboardingAsset.create({ data: { case_id: item.id, asset_name: asset_name.trim().slice(0, 200), serial_number: typeof serial_number === 'string' ? serial_number.slice(0, 120) : null, due_date: typeof due_date === 'string' ? new Date(`${due_date}T00:00:00.000Z`) : null } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.asset.create', entityType: 'offboarding_asset', entityId: asset.id, after: { case_id: item.id, asset_name: asset.asset_name } });
    created(res, asset);
  } catch (error) { next(error); }
});

router.patch('/assets/:assetId', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const asset = await prisma.offboardingAsset.findFirst({ where: { id: String(req.params.assetId), offboarding: { org_id: req.user!.org_id } } });
    if (!asset) throw new NotFoundError('Offboarding asset');
    const parentCase = await prisma.offboardingCase.findFirst({ where: { id: asset.case_id, org_id: req.user!.org_id }, select: { status: true } });
    if (!parentCase || parentCase.status === 'completed' || parentCase.status === 'cancelled') throw new AppError('Assets on a closed case cannot be changed', 409, 'OFFBOARDING_CASE_CLOSED');
    const { status, note } = req.body ?? {};
    if (!['outstanding', 'returned', 'missing', 'waived'].includes(status)) throw new ValidationError('Invalid asset return status');
    const updated = await prisma.offboardingAsset.update({ where: { id: asset.id }, data: { status, resolved_at: status === 'outstanding' ? null : new Date(), note: typeof note === 'string' ? note.slice(0, 2000) : asset.note } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.asset.update', entityType: 'offboarding_asset', entityId: asset.id, before: { status: asset.status }, after: { status: updated.status, note: updated.note } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.put('/:id/settlement', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    if (item.status === 'completed' || item.status === 'cancelled') throw new AppError('Settlement on a closed case cannot be changed', 409, 'OFFBOARDING_CASE_CLOSED');
    const raw = req.body?.items;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new ValidationError('Add between 1 and 100 settlement lines');
    let total = 0;
    const lines = raw.map((line: any) => {
      if (!line || typeof line.label !== 'string' || !line.label.trim() || line.label.trim().length > 160 || !['earning', 'deduction'].includes(line.kind) || !Number.isSafeInteger(line.amount) || line.amount < 0 || line.amount > 1000000000) throw new ValidationError('Each line needs a label, earning or deduction type, and whole-rupee amount');
      total += line.kind === 'earning' ? line.amount : -line.amount;
      return { label: line.label.trim(), kind: line.kind, amount: line.amount };
    });
    if (!Number.isSafeInteger(total) || total < 0) throw new ValidationError('Deductions cannot exceed settlement earnings');
    const existing = await prisma.offboardingSettlement.findFirst({ where: { case_id: item.id, org_id: req.user!.org_id } });
    if (existing && existing.status !== 'draft') throw new AppError('Only a draft settlement can be edited', 409, 'OFFBOARDING_SETTLEMENT_LOCKED');
    const settlement = existing
      ? await prisma.offboardingSettlement.update({ where: { id: existing.id }, data: { items: lines, total_amount: total } })
      : await prisma.offboardingSettlement.create({ data: { org_id: req.user!.org_id, case_id: item.id, created_by: req.user!.sub, items: lines, total_amount: total } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.settlement.save', entityType: 'offboarding_settlement', entityId: settlement.id, after: { case_id: item.id, total_amount: total, line_count: lines.length } });
    ok(res, settlement);
  } catch (error) { next(error); }
});

router.post('/:id/settlement/submit', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    const settlement = await prisma.offboardingSettlement.findFirst({ where: { case_id: item.id, org_id: req.user!.org_id } });
    if (!settlement || settlement.status !== 'draft') throw new AppError('Save a draft settlement before submitting it', 409, 'OFFBOARDING_SETTLEMENT_NOT_DRAFT');
    const moved = await prisma.offboardingSettlement.updateMany({ where: { id: settlement.id, status: 'draft' }, data: { status: 'submitted', submitted_at: new Date() } });
    if (!moved.count) throw new AppError('Settlement changed while you were submitting it; refresh and try again', 409, 'OFFBOARDING_SETTLEMENT_CONFLICT');
    const updated = await prisma.offboardingSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.settlement.submit', entityType: 'offboarding_settlement', entityId: settlement.id, after: { status: updated.status, total_amount: updated.total_amount } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/settlement/approve', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    const settlement = await prisma.offboardingSettlement.findFirst({ where: { case_id: item.id, org_id: req.user!.org_id } });
    if (!settlement || settlement.status !== 'submitted') throw new AppError('Only a submitted settlement can be reviewed', 409, 'OFFBOARDING_SETTLEMENT_NOT_SUBMITTED');
    if (settlement.created_by === req.user!.sub) throw new ForbiddenError('A different authorized HR user must review this settlement');
    const reviewerNote = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
    if (reviewerNote.length < 3) throw new ValidationError('Add a short review note before approving');
    const moved = await prisma.offboardingSettlement.updateMany({ where: { id: settlement.id, status: 'submitted', created_by: { not: req.user!.sub } }, data: { status: 'approved', reviewed_by: req.user!.sub, reviewed_at: new Date(), reviewer_note: reviewerNote } });
    if (!moved.count) throw new AppError('Settlement was already reviewed or changed; refresh and try again', 409, 'OFFBOARDING_SETTLEMENT_CONFLICT');
    const updated = await prisma.offboardingSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.settlement.approve', entityType: 'offboarding_settlement', entityId: settlement.id, after: { status: updated.status, total_amount: updated.total_amount, note: reviewerNote } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/settlement/lock', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    const settlement = await prisma.offboardingSettlement.findFirst({ where: { case_id: item.id, org_id: req.user!.org_id } });
    if (!settlement || settlement.status !== 'approved') throw new AppError('Only an approved settlement can be locked', 409, 'OFFBOARDING_SETTLEMENT_NOT_APPROVED');
    const moved = await prisma.offboardingSettlement.updateMany({ where: { id: settlement.id, status: 'approved' }, data: { status: 'locked', locked_by: req.user!.sub, locked_at: new Date() } });
    if (!moved.count) throw new AppError('Settlement was already locked or changed; refresh and try again', 409, 'OFFBOARDING_SETTLEMENT_CONFLICT');
    const updated = await prisma.offboardingSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.settlement.lock', entityType: 'offboarding_settlement', entityId: settlement.id, after: { status: updated.status, total_amount: updated.total_amount } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.post('/:id/settlement/waive', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    if (item.status === 'completed' || item.status === 'cancelled') throw new AppError('Settlement on a closed case cannot be changed', 409, 'OFFBOARDING_CASE_CLOSED');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : '';
    if (reason.length < 8) throw new ValidationError('Explain why no final settlement is required');
    const existing = await prisma.offboardingSettlement.findFirst({ where: { case_id: item.id, org_id: req.user!.org_id } });
    if (existing && existing.status !== 'draft') throw new AppError('A submitted settlement cannot be waived', 409, 'OFFBOARDING_SETTLEMENT_ALREADY_SUBMITTED');
    const settlement = existing
      ? await prisma.offboardingSettlement.update({ where: { id: existing.id }, data: { status: 'waived', waiver_reason: reason } })
      : await prisma.offboardingSettlement.create({ data: { org_id: req.user!.org_id, case_id: item.id, created_by: req.user!.sub, items: [], total_amount: 0, status: 'waived', waiver_reason: reason } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.settlement.waive', entityType: 'offboarding_settlement', entityId: settlement.id, after: { status: settlement.status, reason } });
    ok(res, settlement);
  } catch (error) { next(error); }
});

router.post('/:id/complete', requirePermission('offboarding.manage'), idempotency, async (req, res, next) => {
  try {
    const item = await scopedCase(String(req.params.id), req.user!.org_id);
    if (item.status !== 'access_revoked') throw new AppError('Access must be revoked on the last working day before closing the case', 409, 'OFFBOARDING_ACCESS_NOT_REVOKED');
    if (item.tasks.some(task => task.status === 'pending') || item.assets.some(asset => asset.status === 'outstanding')) throw new ValidationError('Complete or resolve every checklist task and asset before closing this case');
    if (!item.settlement || !['locked', 'waived'].includes(item.settlement.status)) throw new ValidationError('Approve and lock the final settlement, or record why settlement is not required');
    const updated = await prisma.offboardingCase.update({ where: { id: item.id }, data: { status: 'completed', completed_at: new Date() }, include: CASE_INCLUDE });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'offboarding.case.complete', entityType: 'offboarding_case', entityId: item.id, after: { status: updated.status, user_id: item.user_id } });
    ok(res, updated);
  } catch (error) { next(error); }
});

export default router;
