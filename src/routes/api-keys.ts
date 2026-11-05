import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { authenticate, requireOrgFeature, requirePermission } from '../middleware/auth';
import { createPublicApiKeySchema } from '../schemas/api-keys';
import { PUBLIC_API_SCOPES } from '../constants/public-api';
import { PERMISSION_CATALOG } from '../constants/rbac';
import { validate } from '../middleware/validate';
import { recordAudit } from '../services/audit';
import { resolveUserPermissions } from '../services/authorization';
import prisma from '../utils/prisma';
import { created, NotFoundError, ok, ValidationError } from '../utils/response';
import { idempotency, sensitiveResponseIdempotency } from '../middleware/idempotency';

const router = Router();
router.use(authenticate);
router.use(requirePermission('org.settings.update'));
router.use(requireOrgFeature('api_access'));

const keySelect = {
  id: true, name: true, key_prefix: true, scopes: true, last_used_at: true,
  expires_at: true, revoked_at: true, created_at: true,
} as const;

function makeKey() {
  const prefix = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `attenda_${prefix}_${secret}`;
  return { prefix, token, hash: createHash('sha256').update(token).digest('hex') };
}

router.get('/scopes', async (_req, res) => {
  const byKey = new Map(PERMISSION_CATALOG.map(permission => [permission.key, permission]));
  const permissions = await resolveUserPermissions(_req.user!.sub, _req.user!.org_id);
  ok(res, PUBLIC_API_SCOPES.filter(key => permissions.has(key)).map(key => byKey.get(key)).filter(Boolean));
});

router.get('/', async (req, res, next) => {
  try {
    const items = await prisma.publicApiKey.findMany({
      where: { org_id: req.user!.org_id }, select: keySelect,
      orderBy: { created_at: 'desc' },
    });
    ok(res, { items });
  } catch (error) { next(error); }
});

router.post('/', sensitiveResponseIdempotency, validate({ body: createPublicApiKeySchema }), async (req, res, next) => {
  try {
    if (req.user!.role === 'platform_admin') throw new ValidationError('API keys are organization scoped');
    const { name, expires_in_days } = req.body as { name: string; scopes: string[]; expires_in_days?: number };
    const scopes = [...new Set(req.body.scopes as string[])];
    const currentPermissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    if (scopes.some(scope => !PUBLIC_API_SCOPES.includes(scope as (typeof PUBLIC_API_SCOPES)[number]) || !currentPermissions.has(scope))) {
      throw new ValidationError('Choose only API scopes that your account currently has permission to use');
    }
    const material = makeKey();
    const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 24 * 60 * 60_000) : null;
    const apiKey = await prisma.publicApiKey.create({
      data: {
        org_id: req.user!.org_id, user_id: req.user!.sub, name: name.trim(),
        key_prefix: material.prefix, key_hash: material.hash, scopes, expires_at: expiresAt,
      },
      select: keySelect,
    });
    await recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'org.api_key.create', entityType: 'public_api_key', entityId: apiKey.id, after: { name: apiKey.name, scopes, expires_at: expiresAt } });
    created(res, { ...apiKey, token: material.token });
  } catch (error) { next(error); }
});

router.post('/:id/rotate', sensitiveResponseIdempotency, async (req, res, next) => {
  try {
    const apiKey = await prisma.publicApiKey.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, revoked_at: null } });
    if (!apiKey) throw new NotFoundError('Active API key');
    if (apiKey.expires_at && apiKey.expires_at <= new Date()) throw new ValidationError('This API key has expired; create a new key instead');
    const material = makeKey();
    const rotated = await prisma.$transaction(async tx => {
      const revoked = await tx.publicApiKey.updateMany({ where: { id: apiKey.id, org_id: req.user!.org_id, revoked_at: null }, data: { revoked_at: new Date() } });
      if (!revoked.count) throw new ValidationError('This API key was rotated or revoked by another request');
      return tx.publicApiKey.create({
        data: {
          org_id: apiKey.org_id, user_id: apiKey.user_id, name: apiKey.name,
          key_prefix: material.prefix, key_hash: material.hash, scopes: apiKey.scopes, expires_at: apiKey.expires_at,
        }, select: keySelect,
      });
    });
    await recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'org.api_key.rotate', entityType: 'public_api_key', entityId: rotated.id, before: { id: apiKey.id, name: apiKey.name }, after: { id: rotated.id, name: rotated.name, scopes: rotated.scopes, expires_at: rotated.expires_at } });
    created(res, { ...rotated, token: material.token });
  } catch (error) { next(error); }
});

router.delete('/:id', idempotency, async (req, res, next) => {
  try {
    const apiKey = await prisma.publicApiKey.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!apiKey) throw new NotFoundError('API key');
    if (apiKey.revoked_at) { ok(res, { revoked: true, already_revoked: true }); return; }
    await prisma.publicApiKey.updateMany({ where: { id: apiKey.id, org_id: req.user!.org_id, revoked_at: null }, data: { revoked_at: new Date() } });
    await recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'org.api_key.revoke', entityType: 'public_api_key', entityId: apiKey.id, before: { name: apiKey.name, scopes: apiKey.scopes }, after: { revoked: true } });
    ok(res, { revoked: true });
  } catch (error) { next(error); }
});

export default router;
