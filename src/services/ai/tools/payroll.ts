import { PrismaClient } from '@prisma/client';

export interface PayrollSummaryInput {
  userId?: string;
  start?: string; // ISO date string
  end?: string; // ISO date string
}

export async function payrollSummaryTool(
  prisma: PrismaClient,
  orgId: string,
  input: PayrollSummaryInput
) {
  const { userId, start, end } = input;
  const where: any = { org_id: orgId, status: 'processed' };
  if (userId) where.user_id = userId;
  if (start) where.period_year = { gte: Number(start.split('-')[0]) };
  if (end) where.period_year = { ...where.period_year, lte: Number(end.split('-')[0]) };

  const records = await prisma.payrollRecord.findMany({
    where,
    include: { user: { select: { id: true, name: true, department: true } } },
    orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
  });

  return records.map(r => ({
    userId: r.user_id,
    userName: r.user?.name,
    department: r.user?.department,
    period: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    grossPay: Number(r.gross_pay),
    netPay: Number(r.net_pay),
    overtimeHours: Number(r.overtime_hours),
    regularHours: Number(r.regular_hours),
  }));
}