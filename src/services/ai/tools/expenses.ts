// @ts-nocheck
import { PrismaClient } from '@prisma/client';

export interface ExpensesInput {
  userId?: string;
  start?: string; // ISO date string
  end?: string; // ISO date string
}

export async function expensesTool(
  prisma: PrismaClient,
  orgId: string,
  input: ExpensesInput
) {
  const { userId, start, end } = input;
  const where: any = { org_id: orgId, status: 'approved' };
  if (userId) where.user_id = userId;
  if (start || end) {
    where.date = {};
    if (start) where.date.gte = new Date(start);
    if (end) {
      const endDate = new Date(end);
      endDate.setDate(endDate.getDate() + 1);
      where.date.lte = endDate;
    }
  }

  const claims = await prisma.expense_claims.findMany({
    where,
    include: { user: { select: { id: true, name: true, department: true } } },
    orderBy: { date: 'desc' },
  });

  return claims.map(c => ({
    id: c.id,
    userId: c.user_id,
    userName: c.user?.name,
    department: c.user?.department,
    date: c.date,
    amount: c.amount,
    status: c.status,
    type: c.type,
  }));
}