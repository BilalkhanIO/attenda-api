import { PrismaClient } from '@prisma/client';

export interface ShiftScheduleInput {
  userId?: string;
  start?: string; // ISO date string
  end?: string; // ISO date string
  department?: string;
}

export async function shiftScheduleTool(
  prisma: PrismaClient,
  orgId: string,
  input: ShiftScheduleInput
) {
  const { userId, start, end, department } = input;
  const where: any = { org_id: orgId };
  if (userId) where.user_id = userId;
  if (department) where.department = department;
  if (start || end) {
    where.date = {};
    if (start) where.date.gte = new Date(start);
    if (end) {
      const endDate = new Date(end);
      endDate.setDate(endDate.getDate() + 1);
      where.date.lte = endDate;
    }
  }

  const shifts = await prisma.shift.findMany({
    where: {
      ...where,
      active_days: { not: null },
    },
    include: {
      userAssignments: {
        include: { user: { select: { id: true, name: true, department: true } } },
      },
    },
    orderBy: { start_time: 'asc' },
  });

  return shifts.map(s => ({
    id: s.id,
    name: s.name,
    startTime: s.start_time,
    endTime: s.end_time,
    activeDays: s.active_days,
    assignments: s.userAssignments.map((ua: any) => ({
      userId: ua.user_id,
      userName: ua.user?.name,
      department: ua.user?.department,
    })),
  }));
};