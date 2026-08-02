// Announcements 2.0 service — audience filter, schedule gate, and the
// publish fan-out used by both POST /performance/announcements and the
// 5-minute publisher job. prisma/logger are mocked.

const prismaMock = {
  user:              { findMany: jest.fn() },
  inAppNotification: { createMany: jest.fn() },
  announcement:      { findMany: jest.fn(), update: jest.fn() },
};

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  logger:    { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  jobLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  announcementAudienceWhere,
  isScheduledForLater,
  publishAnnouncement,
  publishDueAnnouncements,
} from '../../services/announcements';

const NOW = new Date('2026-08-02T10:00:00.000Z');

describe('announcementAudienceWhere', () => {
  it('targets all active org users by default', () => {
    expect(announcementAudienceWhere('org-1')).toEqual({
      org_id: 'org-1', is_active: true, deleted_at: null,
    });
    expect(announcementAudienceWhere('org-1', null)).toEqual({
      org_id: 'org-1', is_active: true, deleted_at: null,
    });
  });

  it('narrows to one department when given', () => {
    expect(announcementAudienceWhere('org-1', 'dept-9')).toEqual({
      org_id: 'org-1', is_active: true, deleted_at: null, department_id: 'dept-9',
    });
  });
});

describe('isScheduledForLater', () => {
  it('is false for missing or past/now schedules (publish immediately)', () => {
    expect(isScheduledForLater(null, NOW)).toBe(false);
    expect(isScheduledForLater(undefined, NOW)).toBe(false);
    expect(isScheduledForLater(new Date('2026-08-02T09:00:00.000Z'), NOW)).toBe(false);
    expect(isScheduledForLater(NOW, NOW)).toBe(false);
  });

  it('is true only for future schedules', () => {
    expect(isScheduledForLater(new Date('2026-08-02T10:05:00.000Z'), NOW)).toBe(true);
  });
});

describe('publishAnnouncement', () => {
  const announcement = {
    id: 'ann-1', org_id: 'org-1',
    title: 'Office closed Friday', body: 'Public holiday.',
    department_id: null,
  };

  beforeEach(() => {
    prismaMock.inAppNotification.createMany.mockResolvedValue({ count: 2 });
    prismaMock.announcement.update.mockResolvedValue({});
  });

  it('fans out one notification per audience user and stamps published_at', async () => {
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);

    const count = await publishAnnouncement(announcement, NOW);

    expect(count).toBe(2);
    const rows = prismaMock.inAppNotification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      user_id: 'u1', org_id: 'org-1',
      type: 'announcement',
      title: 'Office closed Friday', body: 'Public holiday.',
      action_type: 'announcement', action_id: 'ann-1',
    });
    expect(prismaMock.announcement.update).toHaveBeenCalledWith({
      where: { id: 'ann-1' },
      data: { published_at: NOW },
    });
  });

  it('passes the department filter through to the audience query', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    await publishAnnouncement({ ...announcement, department_id: 'dept-9' }, NOW);
    expect(prismaMock.user.findMany.mock.calls[0][0].where).toMatchObject({ department_id: 'dept-9' });
  });

  it('still stamps published_at when the audience is empty', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    const count = await publishAnnouncement(announcement, NOW);
    expect(count).toBe(0);
    expect(prismaMock.inAppNotification.createMany).not.toHaveBeenCalled();
    expect(prismaMock.announcement.update).toHaveBeenCalled();
  });
});

describe('publishDueAnnouncements', () => {
  beforeEach(() => {
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1' }]);
    prismaMock.inAppNotification.createMany.mockResolvedValue({ count: 1 });
    prismaMock.announcement.update.mockResolvedValue({});
  });

  it('selects only unpublished announcements whose schedule has passed', async () => {
    prismaMock.announcement.findMany.mockResolvedValue([]);
    await publishDueAnnouncements(NOW);
    expect(prismaMock.announcement.findMany.mock.calls[0][0].where).toEqual({
      published_at: null,
      scheduled_for: { not: null, lte: NOW },
    });
  });

  it('publishes each due announcement and counts recipients', async () => {
    prismaMock.announcement.findMany.mockResolvedValue([
      { id: 'a1', org_id: 'org-1', title: 't1', body: 'b1', department_id: null },
      { id: 'a2', org_id: 'org-1', title: 't2', body: 'b2', department_id: 'dept-9' },
    ]);

    const result = await publishDueAnnouncements(NOW);
    expect(result).toEqual({ published: 2, recipients: 2 });
    expect(prismaMock.announcement.update).toHaveBeenCalledTimes(2);
  });

  it('keeps publishing after one announcement fails', async () => {
    prismaMock.announcement.findMany.mockResolvedValue([
      { id: 'a1', org_id: 'org-1', title: 't1', body: 'b1', department_id: null },
      { id: 'a2', org_id: 'org-1', title: 't2', body: 'b2', department_id: null },
    ]);
    prismaMock.announcement.update
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({});

    const result = await publishDueAnnouncements(NOW);
    expect(result.published).toBe(2); // both attempted
    expect(prismaMock.announcement.update).toHaveBeenCalledTimes(2);
  });
});
