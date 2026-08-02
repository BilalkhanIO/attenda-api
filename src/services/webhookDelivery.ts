import { createHmac, randomBytes } from 'crypto';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { subscribeAllOrgEvents, type OrgEventType } from './notifications';

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

/** Event types an org webhook may subscribe to. */
export const WEBHOOK_EVENT_TYPES = [
  'attendance_changed',
  'leave_changed',
  'overtime_changed',
  'remote_changed',
  'swap_changed',
  'expense_changed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Consecutive delivery failures after which a hook is auto-disabled. */
export const AUTO_DISABLE_THRESHOLD = 20;

const DELIVERY_TIMEOUT_MS = 5_000;

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
export async function dispatchOrgWebhooks(orgId: string, type: OrgEventType): Promise<void> {
  const hooks = await prisma.orgWebhook.findMany({
    where: { org_id: orgId, is_active: true, events: { has: type } },
    select: { id: true, url: true, secret: true, failure_count: true },
  });
  await Promise.all(hooks.map(h => deliverToWebhook(h, type, orgId)));
}

let registered = false;

/** Hook webhook delivery into the org event bus. Called once at boot
 *  (server.ts), alongside startAllJobs. Idempotent. */
export function registerWebhookFanout(): void {
  if (registered) return;
  registered = true;
  subscribeAllOrgEvents((orgId, type) => {
    dispatchOrgWebhooks(orgId, type).catch(err =>
      logger.error({ err, org_id: orgId, event: type }, 'outbound webhook fanout failed'),
    );
  });
}
