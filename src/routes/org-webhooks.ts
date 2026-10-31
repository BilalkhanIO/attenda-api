import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { orgWebhookSchema } from '../schemas';
import { ok, created, noContent, NotFoundError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { deliverToWebhook, generateWebhookSecret } from '../services/webhookDelivery';

/**
 * Outbound webhook management. Mounted at /org/outbound-webhooks; every route
 * requires org.settings.update.
 *
 * Security model: each hook gets a server-generated secret (crypto
 * randomBytes, 64 hex chars) returned ONLY in the POST / response — it is
 * never listed, logged, or shown again. Every delivery is a JSON body
 * {event, org_id, timestamp} with an X-Attenda-Signature header carrying the
 * hex HMAC-SHA256 of the raw body under that secret: receivers recompute the
 * HMAC to verify the payload really came from Attenda and is untampered, and
 * use the embedded timestamp to reject stale/replayed deliveries.
 */

const router = Router();
router.use(authenticate);
router.use(requirePermission('org.settings.update'));

// Everything except the secret.
const WEBHOOK_SELECT = {
  id: true, org_id: true, url: true, events: true, is_active: true,
  last_success_at: true, last_failure_at: true, failure_count: true, created_at: true,
} as const;

// ─── GET /org/outbound-webhooks ────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const hooks = await prisma.orgWebhook.findMany({
      where: { org_id: req.user!.org_id },
      select: WEBHOOK_SELECT,
      orderBy: { created_at: 'desc' },
    });
    ok(res, hooks);
  } catch (e) { next(e); }
});

// Recent per-endpoint delivery outcomes for diagnostics and dead-letter review.
router.get('/:id/deliveries', async (req, res, next) => {
  try {
    const hook = await prisma.orgWebhook.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
      select: { id: true },
    });
    if (!hook) throw new NotFoundError('Webhook');
    const parsedLimit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 50;
    const deliveries = await prisma.orgWebhookDelivery.findMany({
      where: { org_id: req.user!.org_id, webhook_id: hook.id },
      orderBy: { created_at: 'desc' }, take: limit,
      select: {
        id: true, event: true, status: true, attempts: true,
        next_attempt_at: true, last_attempt_at: true, delivered_at: true,
        response_status: true, last_error: true, created_at: true,
      },
    });
    ok(res, { items: deliveries, limit });
  } catch (e) { next(e); }
});

router.post('/:id/deliveries/:deliveryId/replay', async (req, res, next) => {
  try {
    const webhookId = String(req.params.id);
    const deliveryId = String(req.params.deliveryId);
    const replayed = await import('../services/webhookDelivery').then(({ replayWebhookDelivery }) =>
      replayWebhookDelivery(req.user!.org_id, webhookId, deliveryId),
    );
    if (!replayed) throw new NotFoundError('Dead-letter webhook delivery');
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'org.webhook.delivery.replay', entityType: 'org_webhook_delivery', entityId: deliveryId,
      after: { webhook_id: webhookId },
    });
    ok(res, { replayed: true, delivery_id: deliveryId });
  } catch (e) { next(e); }
});

// ─── POST /org/outbound-webhooks ───────────────────────
router.post('/', validate({ body: orgWebhookSchema }), async (req, res, next) => {
  try {
    const { url, events } = req.body;
    const secret = generateWebhookSecret();

    const hook = await prisma.orgWebhook.create({
      data: {
        org_id: req.user!.org_id,
        url,
        secret,
        events: [...new Set(events as string[])],
      },
      select: WEBHOOK_SELECT,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'org.webhook.create', entityType: 'org_webhook', entityId: hook.id,
      after: { url, events: hook.events },
    });
    // The one and only time the secret leaves the server.
    created(res, { ...hook, secret });
  } catch (e) { next(e); }
});

// ─── DELETE /org/outbound-webhooks/:id ─────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const hook = await prisma.orgWebhook.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
    });
    if (!hook) throw new NotFoundError('Webhook');

    await prisma.orgWebhook.delete({ where: { id: hook.id } });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'org.webhook.delete', entityType: 'org_webhook', entityId: hook.id,
      before: { url: hook.url, events: hook.events, is_active: hook.is_active },
    });
    noContent(res);
  } catch (e) { next(e); }
});

// ─── POST /org/outbound-webhooks/:id/test ──────────────
// Sends a signed 'test' event so receivers can verify their endpoint +
// signature handling. Updates the hook's success/failure bookkeeping.
router.post('/:id/test', async (req, res, next) => {
  try {
    const hook = await prisma.orgWebhook.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
      select: { id: true, url: true, secret: true, failure_count: true },
    });
    if (!hook) throw new NotFoundError('Webhook');

    const delivered = await deliverToWebhook(hook, 'test', req.user!.org_id);
    ok(res, { delivered });
  } catch (e) { next(e); }
});

export default router;
