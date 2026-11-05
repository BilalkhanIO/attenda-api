import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';

type LedgerDb = typeof prisma | Prisma.TransactionClient;
type LedgerContext = { reason?: string; note?: string; refId?: string; actorId?: string; effectiveDate?: Date };

/** Set transaction-local metadata consumed by the LeaveBalance delta trigger. */
export async function setLeaveLedgerContext(tx: Prisma.TransactionClient, context: LedgerContext): Promise<void> {
  await tx.$queryRaw`
    SELECT set_config('app.leave_ledger_reason', ${context.reason ?? ''}, true),
           set_config('app.leave_ledger_note', ${context.note ?? ''}, true),
           set_config('app.leave_ledger_ref_id', ${context.refId ?? ''}, true),
           set_config('app.leave_ledger_actor_id', ${context.actorId ?? ''}, true),
           set_config('app.leave_ledger_effective_date', ${context.effectiveDate?.toISOString().slice(0, 10) ?? ''}, true)
  `;
}

export interface LeaveLedgerBalance {
  user_id: string;
  org_id: string;
  leave_type: string;
  year: number;
  total_days: number;
  used_days: number;
}

export async function getLeaveLedgerBalances(
  where: { userId?: string; orgId: string; year: number },
  db: LedgerDb = prisma,
): Promise<LeaveLedgerBalance[]> {
  const userClause = where.userId ? Prisma.sql`AND user_id = ${where.userId}` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ user_id: string; org_id: string; leave_type: string; year: number; total_days: Prisma.Decimal; used_days: Prisma.Decimal }>>`
    SELECT user_id, org_id, leave_type, year,
           COALESCE(SUM(total_delta), 0)::numeric AS total_days,
           COALESCE(SUM(used_delta), 0)::numeric AS used_days
    FROM leave_ledger_entries
    WHERE org_id = ${where.orgId} AND year = ${where.year} ${userClause}
    GROUP BY user_id, org_id, leave_type, year
    ORDER BY leave_type ASC
  `;
  return rows.map(row => ({ ...row, total_days: Number(row.total_days), used_days: Number(row.used_days) }));
}

export async function getLeaveLedgerBalance(
  userId: string, orgId: string, leaveType: string, year: number, db: LedgerDb = prisma,
): Promise<{ total_days: number; used_days: number } | null> {
  const rows = await getLeaveLedgerBalances({ userId, orgId, year }, db);
  const row = rows.find(balance => balance.leave_type === leaveType);
  return row ? { total_days: row.total_days, used_days: row.used_days } : null;
}
