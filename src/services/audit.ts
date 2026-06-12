import prisma from '../utils/prisma';
import { logger } from '../utils/logger';

interface AuditEntry {
  orgId: string;
  actorId: string;
  /** e.g. 'payroll.adjust', 'payroll.process', 'leave.balance.update', 'attendance.override' */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Append-only audit trail for pay-affecting mutations. Fire-and-forget:
 * auditing must never fail the business operation, but failures are logged
 * loudly because a silent audit gap is itself an incident.
 */
export function recordAudit(entry: AuditEntry): void {
  prisma.auditLog
    .create({
      data: {
        org_id: entry.orgId,
        actor_id: entry.actorId,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        before: entry.before === undefined ? undefined : JSON.parse(JSON.stringify(entry.before)),
        after: entry.after === undefined ? undefined : JSON.parse(JSON.stringify(entry.after)),
        reason: entry.reason ?? null,
      },
    })
    .catch(err => logger.error({ err, action: entry.action, entity: entry.entityId }, 'audit write failed'));
}
