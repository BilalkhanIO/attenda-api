import { createHmac, randomBytes, randomUUID } from 'crypto';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import type { OrgEventType } from './notifications';

// ─── Outbound webhook delivery ────────────────────────
// Fans org-bus events (the same coarse types SSE clients receive) out to the
// org's registered HTTPS endpoints. Strictly fire-and-forget: nothing here
// may block or throw into the mutation handler that emitted the event.
//
// Payload:   {"event":"leave_changed","org_id":"…","timestamp":"ISO-8601"}
// Signature: X-Attenda-Signature: hex(HMAC-SHA256(secret, rawBody))
// Receivers verify authenticity by recomputing the HMAC over the raw body
// with their stored secret; the embedded timestamp bounds replay windows.
//
// SECURITY: secrets are generated with crypto.randomBytes, stored server-side,
// returned to the caller exactly once (at creation) and NEVER logged.

// Event types an org webhook may subscribe to — canonical list lives in
// src/schemas (kept prisma-free so pure schema consumers can import it).
export { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '../schemas';

/** Consecutive delivery failures after which a hook is auto-disabled. */
export const AUTO_DISABLE_THRESHOLD = 20;

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

/** 32 random bytes, hex-encoded (64 chars). Returned only at creation. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Hex HMAC-SHA256 of the raw request body, keyed by the webhook secret. */
export function signWebhookPayload(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Pure threshold rule: disable once the failure streak reaches the cap. */
export function shouldAutoDisable(consecutiveFailures: number): boolean {
  return consecutiveFailures >= AUTO_DISABLE_THRESHOLD;
}

export interface DeliverableWebhook {
  id: string;
  url: string;
  secret: string;
  failure_count: number;
}

/** POST one signed event to one endpoint. Returns delivery success. */
export async function deliverToWebhook(
  hook: DeliverableWebhook,
  event: string,
  orgId: string,
): Promise<boolean> {
  const rawBody = JSON.stringify({
    event,
    org_id: orgId,
    timestamp: new Date().toISOString(),
  });

  let delivered = false;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Attenda-Signature': signWebhookPayload(hook.secret, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    delivered = res.ok;
  } catch {
    delivered = false; // network error / timeout
  }

  try {
    if (delivered) {
      await prisma.orgWebhook.update({
        where: { id: hook.id },
        data: { failure_count: 0, last_success_at: new Date() },
      });
    } else {
      const failures = hook.failure_count + 1;
      await prisma.orgWebhook.update({
        where: { id: hook.id },
        data: {
          failure_count: failures,
          last_failure_at: new Date(),
          ...(shouldAutoDisable(failures) ? { is_active: false } : {}),
        },
      });
      logger.warn(
        { webhook_id: hook.id, event, failures, disabled: shouldAutoDisable(failures) },
        'outbound webhook delivery failed',
      );
    }
  } catch (err) {
    logger.error({ err, webhook_id: hook.id }, 'outbound webhook bookkeeping failed');
  }
  return delivered;
}

/** Deliver one org event to every active, subscribed hook of that org. */
export async function dispatchOrgWebhooks(orgId: string, type: OrgEventType, outboxEventId: string, occurredAt = new Date()): Promise<void> {
  const hooks = await prisma.orgWebhook.findMany({
    where: { org_id: orgId, is_active: true, events: { has: type } },
    select: { id: true, url: true, secret: true, failure_count: true },
  });
  if (!hooks.length) return;
  await prisma.orgWebhookDelivery.createMany({
    data: hooks.map(hook => {
      const payload = JSON.stringify({ id: outboxEventId, event: type, org_id: orgId, timestamp: occurredAt.toISOString() });
      return {
        id: randomUUID(), outbox_event_id: outboxEventId, webhook_id: hook.id, org_id: orgId, event: type,
        endpoint_url: hook.url, payload, signature: signWebhookPayload(hook.secret, payload),
      };
    }),
    skipDuplicates: true,
  });
}

/** Claim one due row so an immediate dispatch and the retry worker cannot send it concurrently. */
async function attemptQueuedDelivery(id: string): Promise<void> {
  const now = new Date();
  const claimed = await prisma.orgWebhookDelivery.updateMany({
    where: { id, status: { in: ['queued', 'retrying'] }, next_attempt_at: { lte: now } },
    data: { status: 'delivering', attempts: { increment: 1 }, last_attempt_at: now },
  });
  if (!claimed.count) return;

  const delivery = await prisma.orgWebhookDelivery.findUnique({ where: { id } });
  if (!delivery) return;

  let responseStatus: number | null = null;
  let errorMessage: string | null = null;
  try {
    const response = await fetch(delivery.endpoint_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Attenda-Signature': delivery.signature },
      body: delivery.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = response.status;
    if (!response.ok) errorMessage = `Endpoint returned HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 2000) : 'Network error';
  }

  if (!errorMessage) {
    await prisma.orgWebhookDelivery.update({
      where: { id }, data: { status: 'delivered', delivered_at: new Date(), response_status: responseStatus, last_error: null },
    });
    if (delivery.webhook_id) {
      await prisma.orgWebhook.updateMany({ where: { id: delivery.webhook_id }, data: { failure_count: 0, last_success_at: new Date() } });
    }
    return;
  }

  const deadLetter = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  const delayMs = Math.min(30_000 * (2 ** Math.max(0, delivery.attempts - 1)), MAX_RETRY_DELAY_MS);
  await prisma.orgWebhookDelivery.update({
    where: { id },
    data: {
      status: deadLetter ? 'dead_letter' : 'retrying',
      next_attempt_at: new Date(Date.now() + delayMs),
      response_status: responseStatus,
      last_error: errorMessage,
    },
  });
  if (delivery.webhook_id) {
    await prisma.orgWebhook.updateMany({
      where: { id: delivery.webhook_id },
      data: { failure_count: { increment: 1 }, last_failure_at: new Date() },
    });
    const hook = await prisma.orgWebhook.findUnique({ where: { id: delivery.webhook_id }, select: { failure_count: true } });
    if (hook && shouldAutoDisable(hook.failure_count)) {
      await prisma.orgWebhook.updateMany({ where: { id: delivery.webhook_id }, data: { is_active: false } });
    }
  }
  logger.warn({ delivery_id: id, webhook_id: delivery.webhook_id, event: delivery.event, attempts: delivery.attempts, dead_letter: deadLetter }, 'outbound webhook delivery failed');
}

/** Retry due deliveries; stale claims recover after worker restarts. */
export async function retryDueWebhookDeliveries(now = new Date()): Promise<number> {
  const staleClaim = new Date(now.getTime() - 10 * 60_000);
  await prisma.orgWebhookDelivery.updateMany({
    where: { status: 'delivering', updated_at: { lt: staleClaim } },
    data: { status: 'retrying', next_attempt_at: now, last_error: 'Recovered stale delivery claim' },
  });
  const due = await prisma.orgWebhookDelivery.findMany({
    where: { status: { in: ['queued', 'retrying'] }, next_attempt_at: { lte: now } },
    orderBy: { next_attempt_at: 'asc' }, take: 100, select: { id: true },
  });
  await Promise.all(due.map(row => attemptQueuedDelivery(row.id)));
  return due.length;
}

export async function replayWebhookDelivery(orgId: string, webhookId: string, deliveryId: string): Promise<boolean> {
  const delivery = await prisma.orgWebhookDelivery.findFirst({
    where: { id: deliveryId, webhook_id: webhookId, org_id: orgId, status: 'dead_letter' },
    select: { id: true },
  });
  if (!delivery) return false;
  await prisma.orgWebhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'queued', attempts: 0, next_attempt_at: new Date(), last_attempt_at: null, last_error: null, response_status: null },
  });
  await attemptQueuedDelivery(delivery.id);
  return true;
}

let registered = false;

/** Hook webhook delivery into the org event bus. Called once at boot
 *  (server.ts), alongside startAllJobs. Idempotent. */
export function registerWebhookFanout(): void {
  if (registered) return;
  registered = true;
  // Webhook delivery now consumes transactionally written outbox rows.
}
