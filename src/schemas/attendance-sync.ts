import { z } from 'zod';

const eventSchema = z.object({
  sequence: z.number().int().min(1).max(2_147_483_647),
  idempotency_key: z.string().min(16).max(100),
  type: z.enum(['checkin', 'checkout', 'break_start', 'break_end']),
  payload: z.record(z.string(), z.unknown()),
});

export const attendanceSyncSchema = z.object({
  events: z.array(eventSchema).min(1).max(20),
}).superRefine(({ events }, context) => {
  const seen = new Set<number>();
  const seenKeys = new Set<string>();
  let last = 0;
  events.forEach((event, index) => {
    if (seen.has(event.sequence)) context.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'Sequence numbers must be unique in a sync batch' });
    if (event.sequence <= last) context.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'Events must be in strictly increasing sequence order' });
    seen.add(event.sequence);
    if (seenKeys.has(event.idempotency_key)) context.addIssue({ code: 'custom', path: ['events', index, 'idempotency_key'], message: 'Idempotency keys must be unique in a sync batch' });
    seenKeys.add(event.idempotency_key);
    last = event.sequence;
    if (JSON.stringify(event.payload).length > 32_768) context.addIssue({ code: 'custom', path: ['events', index, 'payload'], message: 'Each event payload must be at most 32 KiB' });
    if (event.payload.idempotency_key !== event.idempotency_key) context.addIssue({ code: 'custom', path: ['events', index, 'payload', 'idempotency_key'], message: 'Payload idempotency_key must match the event key' });
    if (event.payload.offline !== true) context.addIssue({ code: 'custom', path: ['events', index, 'payload', 'offline'], message: 'Offline sync events must be marked offline' });
    if (event.type === 'checkin' && (event.payload.type !== 'manual' || event.payload.qr_code !== undefined)) context.addIssue({ code: 'custom', path: ['events', index, 'payload'], message: 'Offline batch sync supports manual check-in only' });
  });
});
