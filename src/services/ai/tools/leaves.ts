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

  const balances = await prisma.leaveBalance.findMany({
    where,
    include: { user: { select: { id: true, name: true, email: true } } },
  });

return balances.map(b => ({
    userId: b.user_id,
    userName: b.user?.name,
    email: b.user?.email,
    leaveType: b.leave_type,
    totalDays: Number(b.total_days ?? 0),
    usedDays: Number(b.used_days ?? 0),
    balance: Number(b.total_days ?? 0) - Number(b.used_days ?? 0),
  }));
}