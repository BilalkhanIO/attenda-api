import { randomUUID } from 'node:crypto';
import prisma from '../utils/prisma';
import { jobLogger } from '../utils/logger';
import { createNotification, publishOutboxOrgEvent, type NotifPayload, type OrgEventType } from './notifications';
import { dispatchOrgWebhooks } from './webhookDelivery';
import { Counter, Gauge } from 'prom-client';
import { registry } from '../utils/metrics';

type OutboxRow = {
  id: string; org_id: string; event_type: string; entity_type: string;
  entity_id: string; payload: unknown; created_at: Date; attempts: number; schema_version: number;
};
const MAX_ATTEMPTS = 8;
const publishedCounter = new Counter({ name: 'attenda_outbox_published_total', help: 'Outbox events successfully published', labelNames: ['event_type'] as const, registers: [registry] });
const failureCounter = new Counter({ name: 'attenda_outbox_publish_failures_total', help: 'Outbox event publication attempts that failed', labelNames: ['event_type'] as const, registers: [registry] });
const pendingGauge = new Gauge({ name: 'attenda_outbox_pending', help: 'Outbox events waiting for publication', registers: [registry] });
const deadLetterGauge = new Gauge({ name: 'attenda_outbox_dead_letters', help: 'Outbox events in dead-letter state', registers: [registry] });
const oldestPendingGauge = new Gauge({ name: 'attenda_outbox_oldest_pending_seconds', help: 'Age of the oldest pending outbox event in seconds', registers: [registry] });

async function refreshOutboxMetrics(now: Date): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ pending: bigint; dead_letters: bigint; oldest_pending: Date | null }>>`
    SELECT
      COUNT(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::bigint AS pending,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::bigint AS dead_letters,
      MIN(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending
    FROM outbox_events
  `;
  const row = rows[0];
  pendingGauge.set(Number(row?.pending ?? 0));
  deadLetterGauge.set(Number(row?.dead_letters ?? 0));
  oldestPendingGauge.set(row?.oldest_pending ? Math.max(0, (now.getTime() - row.oldest_pending.getTime()) / 1000) : 0);
}

const allowedEvents = new Set<OrgEventType>([
  'attendance_changed', 'leave_changed', 'overtime_changed', 'remote_changed',
  'swap_changed', 'expense_changed', 'project_changed', 'shift_changed',
  'timesheet_changed',
]);

function notificationFromOutbox(value: unknown): NotifPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Outbox notification payload must be an object');
  const payload = value as Record<string, unknown>;
  for (const field of ['userId', 'orgId', 'type', 'title', 'body', 'actionType', 'actionId', 'dedupeKey']) {
    if (typeof payload[field] !== 'string' || !payload[field]) throw new Error(`Outbox notification is missing ${field}`);
  }
  if (payload.title!.toString().length > 200 || payload.body!.toString().length > 4000) throw new Error('Outbox notification exceeds length limits');
  return {
    userId: payload.userId as string,
    orgId: payload.orgId as string,
    type: payload.type as NotifPayload['type'],
    title: payload.title as string,
    body: payload.body as string,
    actionType: payload.actionType as string,
    actionId: payload.actionId as string,
    dedupeKey: payload.dedupeKey as string,
  };
}

/** Claim rows atomically; concurrent workers skip already-claimed rows. */
export async function publishOutboxBatch(limit = 100, now = new Date()): Promise<number> {
  const token = randomUUID();
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const rows = await prisma.$queryRaw<OutboxRow[]>`
    WITH picked AS (
      SELECT id FROM outbox_events
      WHERE published_at IS NULL AND dead_lettered_at IS NULL AND attempts < ${MAX_ATTEMPTS}
        AND next_attempt_at <= ${now} AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(1, Math.min(500, limit))}
    )
    UPDATE outbox_events AS event
    SET claimed_at = ${now}, claim_token = ${token}, attempts = event.attempts + 1
    FROM picked
    WHERE event.id = picked.id
      RETURNING event.id, event.org_id, event.event_type, event.entity_type, event.entity_id, event.payload, event.created_at, event.attempts, event.schema_version
  `;

  for (const event of rows) {
    try {
      if (event.event_type === 'notification_requested') {
        const queued = await createNotification(notificationFromOutbox(event.payload));
        if (!queued) throw new Error('Notification could not be queued; retrying outbox event');
      } else {
        if (!allowedEvents.has(event.event_type as OrgEventType)) throw new Error(`Unsupported outbox event: ${event.event_type}`);
        const eventType = event.event_type as OrgEventType;
        await publishOutboxOrgEvent(event.org_id, eventType, event.id, event.schema_version);
        await dispatchOrgWebhooks(event.org_id, eventType, event.id, event.created_at, event.schema_version);
      }
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, claim_token: token, published_at: null },
        data: { published_at: new Date(), claimed_at: null, claim_token: null, last_error: null },
      });
      publishedCounter.inc({ event_type: event.event_type });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2000) : 'Outbox processing failed';
      const deadLetter = event.attempts >= MAX_ATTEMPTS;
      const delayMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.max(0, event.attempts - 1)));
      const retryAt = new Date(now.getTime() + delayMs);
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, claim_token: token, published_at: null },
        data: { claimed_at: null, claim_token: null, last_error: message, next_attempt_at: retryAt, ...(deadLetter ? { dead_lettered_at: new Date() } : {}) },
      }).catch(updateError => jobLogger.error({ updateError, outbox_id: event.id }, 'could not release failed outbox claim'));
      failureCounter.inc({ event_type: event.event_type });
      jobLogger.error({ error, outbox_id: event.id, event: event.event_type, attempts: event.attempts, dead_letter: deadLetter, retry_at: deadLetter ? undefined : retryAt }, 'outbox publication failed');
    }
  }
  await refreshOutboxMetrics(now).catch(error => jobLogger.warn({ error }, 'could not refresh outbox metrics'));
  return rows.length;
}
