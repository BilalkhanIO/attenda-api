import { PrismaClient } from '@prisma/client';
import { Request, Response } from 'express';

export interface AttendanceToolInput {
  userId?: string;
  start?: string; // ISO date string
  end?: string; // ISO date string
  type?: 'check-in' | 'check-out' | 'leave';
}

export async function attendanceTool(
  prisma: PrismaClient,
  orgId: string,
  user: { id: string; org_id: string },
  input: AttendanceToolInput
) {
  const { userId, start, end, type } = input;
  const where: any = { org_id: orgId };
  if (userId) where.user_id = userId;
  if (start) where.date = { gte: new Date(start) };
  if (end) {
    const endDate = new Date(end);
    endDate.setDate(endDate.getDate() + 1); // inclusive end
    where.date = { ...where.date, lte: endDate };
  }
  if (type) where.status = type;

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
    status: r.status,
    checkIn: r.check_in_at,
    checkOut: r.check_out_at,
    hoursWorked: r.hours_worked,
    overtimeHours: r.overtime_hours,
  }));
}