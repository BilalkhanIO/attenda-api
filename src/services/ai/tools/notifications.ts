// @ts-nocheck
import { PrismaClient } from '@prisma/client';

export interface NotificationsInput {
  userId?: string;
  type?: string;
}

export async function notificationsTool(
  prisma: PrismaClient,
  orgId: string,
  input: NotificationsInput
) {
  const { userId, type } = input;
  const where: any = { org_id: orgId };
  if (userId) where.user_id = userId;
  if (type) where.type = type;

  const notifications = await prisma.in_app_notification.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  return notifications.map(n => ({
    id: n.id,
    userId: n.user_id,
    title: n.title,
    message: n.message,
    type: n.type,
    read: n.read,
    createdAt: n.created_at,
  }));
}