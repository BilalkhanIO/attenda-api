// @ts-nocheck
import { PrismaClient } from '@prisma/client';

export interface OvertimeInput {
  userId?: string;
  start?: string; // ISO date string
  end?: string; // ISO date string
}

export async function overtimeTool(
  prisma: PrismaClient,
  orgId: string,
  input: OvertimeInput
) {
  const { userId, start, end } = input;
  const where: any = { org_id: orgId, overtime_hours: { gt: 0 } };
  if (userId) where.user_id = userId;
  if (start || end) {
    where.attendanceRecord = {};
    if (start) where.attendanceRecord.gte = new Date(start);
    if (end) {
      const endDate = new Date(end);
      endDate.setDate(endDate.getDate() + 1);
      where.attendanceRecord.lte = endDate;
    }
  }

  const records = await prisma.attendanceRecord.findMany({
    where,
    include: { user: { select: { id: true, name: true, department: true } } },
    orderBy: { date: 'desc' },
  });

  return records.map(r => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user?.name,
    department: r.user?.department,
    date: r.date,
    overtimeHours: r.overtime_hours,
    status: r.status,
  }));
}