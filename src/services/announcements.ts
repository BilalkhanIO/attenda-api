import prisma from '../utils/prisma';
import { jobLogger } from '../utils/logger';

/**
 * Announcements 2.0. An announcement is persisted first (model Announcement)
 * and "publishing" fans it out as in-app notifications to its audience —
 * the whole org, or one department when department_id is set. Publishing
 * happens inline on create, or later via the 5-minute publisher job when
 * scheduled_for is in the future.
 */

export interface PublishableAnnouncement {
  id: string;
  org_id: string;
  title: string;
  body: string;
  department_id: string | null;
}

/** Audience filter: active, non-deleted org users; optionally one department. */
export function announcementAudienceWhere(
  orgId: string,
  departmentId?: string | null,
): Record<string, unknown> {
  return {
    org_id: orgId,
    is_active: true,
    deleted_at: null,
    ...(departmentId ? { department_id: departmentId } : {}),
  };
}

/** true ⇒ hold the announcement for the publisher job instead of fanning out now. */
export function isScheduledForLater(
  scheduledFor: Date | null | undefined,
  now: Date,
): boolean {
  return !!scheduledFor && scheduledFor.getTime() > now.getTime();
}

/** Fan out the in-app notifications and stamp published_at. Returns audience size. */
export async function publishAnnouncement(
  announcement: PublishableAnnouncement,
  now = new Date(),
): Promise<number> {
  const users = await prisma.user.findMany({
    where: announcementAudienceWhere(announcement.org_id, announcement.department_id),
    select: { id: true },
  });

  if (users.length) {
    await prisma.inAppNotification.createMany({
      data: users.map(u => ({
        user_id: u.id,
        org_id: announcement.org_id,
        type: 'announcement',
        title: announcement.title,
        body: announcement.body,
        action_type: 'announcement',
        action_id: announcement.id,
      })),
    });
  }

  await prisma.announcement.update({
    where: { id: announcement.id },
    data: { published_at: now },
  });

  return users.length;
}

/** Publisher job body: publish every scheduled announcement that is now due. */
export async function publishDueAnnouncements(
  now = new Date(),
): Promise<{ published: number; recipients: number }> {
  const due = await prisma.announcement.findMany({
    where: { published_at: null, scheduled_for: { not: null, lte: now } },
    select: { id: true, org_id: true, title: true, body: true, department_id: true },
  });

  let recipients = 0;
  for (const announcement of due) {
    try {
      recipients += await publishAnnouncement(announcement, now);
    } catch (err) {
      jobLogger.error({ err, announcement_id: announcement.id }, 'announcement publish failed');
    }
  }

  if (due.length) {
    jobLogger.info({ published: due.length, recipients }, 'scheduled announcements published');
  }
  return { published: due.length, recipients };
}
