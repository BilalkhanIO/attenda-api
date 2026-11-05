import { PrismaClient } from '@prisma/client';

export interface LeaveBalancesInput {
  userId?: string;
  leaveType?: string;
}

export async function leaveBalancesTool(
  prisma: PrismaClient,
  orgId: string,
  input: LeaveBalancesInput
) {
  const { userId, leaveType } = input;
  const where: any = { org_id: orgId };
  if (userId) where.user_id = userId;
  if (leaveType) where.leave_type = leaveType;
  const balances = await prisma.leaveLedgerEntry.groupBy({
    by: ['user_id', 'leave_type', 'year'],
    where,
    _sum: { total_delta: true, used_delta: true },
  });
  const users = await prisma.user.findMany({ where: { org_id: orgId, id: { in: [...new Set(balances.map(b => b.user_id))] } }, select: { id: true, name: true, email: true } });
  const userById = new Map(users.map(user => [user.id, user]));
  return balances.map(balance => {
    const totalDays = Number(balance._sum.total_delta ?? 0);
    const usedDays = Number(balance._sum.used_delta ?? 0);
    const user = userById.get(balance.user_id);
    return {
      userId: balance.user_id,
      userName: user?.name,
      email: user?.email,
      leaveType: balance.leave_type,
      year: balance.year,
      totalDays,
      usedDays,
      balance: Math.round((totalDays - usedDays) * 100) / 100,
    };
  });
}
