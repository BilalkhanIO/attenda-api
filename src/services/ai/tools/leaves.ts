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

  const balances = await prisma.leave_balance.findMany({
    where,
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  return balances.map(b => ({
    userId: b.user_id,
    userName: b.user?.name,
    email: b.user?.email,
    leaveType: b.leave_type,
    totalDays: b.total_days,
    usedDays: b.used_days,
    balance: b.total_days - b.used_days,
  }));
}