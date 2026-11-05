import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import prisma from '../utils/prisma';
import { created, ok, ValidationError } from '../utils/response';

const router = Router();
router.use(authenticate);

const DEFINITIONS: Record<string, { label: string; keys: string[] }> = {
  max_weekly_hours: { label: 'Maximum scheduled hours per week', keys: ['hours'] },
  min_rest_hours: { label: 'Minimum rest between shifts', keys: ['hours'] },
  max_shift_hours: { label: 'Maximum shift duration', keys: ['hours'] },
  max_spread_over_hours: { label: 'Maximum shift spread-over', keys: ['hours'] },
  mandatory_break: { label: 'Mandatory break threshold', keys: ['after_hours', 'break_minutes'] },
};

function validateRule(value: any) {
  if (!value || typeof value.code !== 'string' || !DEFINITIONS[value.code]) throw new ValidationError('Unknown compliance rule code');
  if (!['info', 'warn', 'block'].includes(value.severity)) throw new ValidationError('Rule severity must be info, warn, or block');
  if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) throw new ValidationError('Rule params must be an object');
  const definition = DEFINITIONS[value.code];
  const keys = Object.keys(value.params);
  if (keys.length !== definition.keys.length || definition.keys.some(key => !keys.includes(key))) throw new ValidationError(`${value.code} requires params: ${definition.keys.join(', ')}`);
  for (const key of definition.keys) {
    const number = value.params[key];
    const maximum = key === 'break_minutes' ? 1440 : 168;
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0 || number > maximum) throw new ValidationError(`${key} must be a number greater than 0 and at most ${maximum}`);
  }
  const sourceRef = value.source_ref == null ? null : String(value.source_ref).trim().slice(0, 500);
  return { code: value.code as string, severity: value.severity as string, params: value.params as Record<string, number>, source_ref: sourceRef };
}

router.get('/rules', requirePermission('compliance.view', 'compliance.manage'), async (req, res, next) => {
  try {
    const orgId = req.user!.org_id;
    const effectiveOnText = typeof req.query.effective_on === 'string' ? req.query.effective_on : null;
    if (effectiveOnText && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveOnText)) throw new ValidationError('effective_on must be YYYY-MM-DD');
    const effectiveOn = effectiveOnText ? new Date(`${effectiveOnText}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(effectiveOn.getTime()) || (effectiveOnText && effectiveOn.toISOString().slice(0, 10) !== effectiveOnText)) throw new ValidationError('effective_on is invalid');
    const [org, rules] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: orgId }, select: { compliance_pack_key: true, timezone: true } }),
      prisma.complianceRule.findMany({ where: { org_id: orgId, effective_from: { lte: effectiveOn }, OR: [{ effective_to: null }, { effective_to: { gte: effectiveOn } }] }, orderBy: [{ code: 'asc' }, { effective_from: 'desc' }] }),
    ]);
    ok(res, { pack_key: org?.compliance_pack_key ?? 'unconfigured', timezone: org?.timezone, effective_on: effectiveOn.toISOString().slice(0, 10), rules: rules.map(rule => ({ ...rule, label: DEFINITIONS[rule.code]?.label ?? rule.code })) });
  } catch (error) { next(error); }
});

router.get('/violations', requirePermission('compliance.view', 'compliance.manage'), async (req, res, next) => {
  try {
    const week = typeof req.query.week_start === 'string' ? req.query.week_start : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new ValidationError('week_start must be YYYY-MM-DD');
    const from = new Date(`${week}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== week) throw new ValidationError('week_start is invalid');
    const items = await prisma.complianceViolation.findMany({ where: { org_id: req.user!.org_id, week_start: from }, orderBy: [{ severity: 'desc' }, { created_at: 'desc' }], take: 500 });
    const ids = [...new Set(items.flatMap(item => [item.user_id, item.override_by]).filter((value): value is string => !!value))];
    const users = ids.length ? await prisma.user.findMany({ where: { org_id: req.user!.org_id, id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map(user => [user.id, user.name]));
    ok(res, items.map(item => ({ ...item, user_name: item.user_id ? names.get(item.user_id) ?? null : null, override_by_name: item.override_by ? names.get(item.override_by) ?? null : null })));
  } catch (error) { next(error); }
});

// Effective-dated versions are retained; edits to a same-day draft replace it, with before/after audit snapshots.
router.put('/rules', requirePermission('compliance.manage'), idempotency, async (req, res, next) => {
  try {
    const packKey = String(req.body?.pack_key ?? '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(packKey)) throw new ValidationError('pack_key must be 2–80 letters, numbers, dots, underscores, or hyphens');
    if (!Array.isArray(req.body?.rules) || req.body.rules.length > Object.keys(DEFINITIONS).length) throw new ValidationError('rules must be an array of up to five rules');
    const rules = req.body.rules.map(validateRule);
    if (new Set(rules.map((rule: { code: string }) => rule.code)).size !== rules.length) throw new ValidationError('Each rule code may appear only once in a pack');
    const effectiveFrom = req.body?.effective_from == null ? new Date() : new Date(`${String(req.body.effective_from)}T00:00:00.000Z`);
    if (Number.isNaN(effectiveFrom.getTime()) || effectiveFrom.toISOString().slice(0, 10) !== String(req.body?.effective_from ?? effectiveFrom.toISOString().slice(0, 10))) throw new ValidationError('effective_from must be a valid YYYY-MM-DD date');
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (effectiveFrom < today) throw new ValidationError('effective_from cannot be in the past');
    const orgId = req.user!.org_id;
    const saved = await prisma.$transaction(async tx => {
      const org = await tx.organisation.findUnique({ where: { id: orgId }, select: { compliance_pack_key: true } });
      const rows = [];
      const activeAtStart = await tx.complianceRule.findMany({ where: { org_id: orgId, effective_from: { lte: effectiveFrom }, OR: [{ effective_to: null }, { effective_to: { gte: effectiveFrom } }] } });
      await tx.organisation.update({ where: { id: orgId }, data: { compliance_pack_key: packKey } });
      const codesInPayload = new Set(rules.map((rule: { code: string }) => rule.code));
      const dayBefore = new Date(effectiveFrom); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      for (const current of activeAtStart) if (!codesInPayload.has(current.code) || current.effective_from < effectiveFrom) {
        if (current.effective_from.getTime() === effectiveFrom.getTime()) await tx.complianceRule.delete({ where: { id: current.id } });
        else await tx.complianceRule.update({ where: { id: current.id }, data: { effective_to: dayBefore } });
      }
      for (const rule of rules) {
        const sameDay = activeAtStart.find(current => current.code === rule.code && current.effective_from.getTime() === effectiveFrom.getTime());
        if (sameDay) {
          rows.push(await tx.complianceRule.update({ where: { id: sameDay.id }, data: { severity: rule.severity, params: rule.params, source_ref: rule.source_ref, created_by: req.user!.sub } }));
        } else {
          const nextVersion = await tx.complianceRule.findFirst({ where: { org_id: orgId, code: rule.code, effective_from: { gt: effectiveFrom } }, orderBy: { effective_from: 'asc' }, select: { effective_from: true } });
          const effectiveTo = nextVersion ? new Date(nextVersion.effective_from) : null;
          if (effectiveTo) effectiveTo.setUTCDate(effectiveTo.getUTCDate() - 1);
          rows.push(await tx.complianceRule.create({ data: { org_id: orgId, ...rule, effective_from: effectiveFrom, effective_to: effectiveTo, created_by: req.user!.sub } }));
        }
      }
      await tx.auditLog.create({ data: {
        org_id: orgId,
        actor_id: req.user!.sub,
        action: 'compliance_rules_updated',
        entity_type: 'compliance_pack',
        entity_id: orgId,
        before: { pack_key: org?.compliance_pack_key ?? 'unconfigured', rules: activeAtStart.map(rule => ({ code: rule.code, severity: rule.severity, params: rule.params, source_ref: rule.source_ref, effective_from: rule.effective_from.toISOString().slice(0, 10), effective_to: rule.effective_to?.toISOString().slice(0, 10) ?? null })) },
        after: { pack_key: packKey, effective_from: effectiveFrom.toISOString().slice(0, 10), rules: rules.map((rule: { code: string; severity: string; params: Record<string, number>; source_ref: string | null }) => rule) },
      } });
      return rows;
    });
    created(res, { pack_key: packKey, rules: saved });
  } catch (error) { next(error); }
});

export default router;
