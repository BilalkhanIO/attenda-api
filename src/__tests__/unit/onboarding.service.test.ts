// Onboarding materialization — pure helpers (assignee resolution, due-date
// math, progress calc) plus the materialize/auto-assign flows with prisma,
// logger, and notifications mocked.

const prismaMock = {
  onboardingTemplate: { findFirst: jest.fn() },
  onboardingTask:     { count: jest.fn(), createMany: jest.fn() },
  user:               { findFirst: jest.fn() },
};

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  logger:    { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  jobLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const createNotificationMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/notifications', () => ({
  __esModule: true,
  createNotification: (payload: unknown) => createNotificationMock(payload),
}));

import {
  resolveItemAssignee,
  dueDateFor,
  onboardingProgress,
  isOnboardingComplete,
  materializeOnboardingTasks,
  autoAssignDefaultTemplate,
} from '../../services/onboarding';
import { logger } from '../../utils/logger';
import { NotFoundError } from '../../utils/response';

describe('resolveItemAssignee', () => {
  it('gives employee items to the hire', () => {
    expect(resolveItemAssignee('employee', 'hire-1', 'mgr-1')).toBe('hire-1');
    expect(resolveItemAssignee(null, 'hire-1', 'mgr-1')).toBe('hire-1');
    expect(resolveItemAssignee(undefined, 'hire-1', 'mgr-1')).toBe('hire-1');
  });

  it('gives manager items to the manager', () => {
    expect(resolveItemAssignee('manager', 'hire-1', 'mgr-1')).toBe('mgr-1');
  });

  it('falls back to the hire when there is no manager', () => {
    expect(resolveItemAssignee('manager', 'hire-1', null)).toBe('hire-1');
    expect(resolveItemAssignee('manager', 'hire-1', undefined)).toBe('hire-1');
  });
});

describe('dueDateFor', () => {
  const assignedAt = new Date('2026-08-02T18:45:30.000Z');

  it('returns null when the item has no due_days', () => {
    expect(dueDateFor(null, assignedAt)).toBeNull();
    expect(dueDateFor(undefined, assignedAt)).toBeNull();
  });

  it('adds due_days to the start of the assignment UTC day', () => {
    expect(dueDateFor(0, assignedAt)).toEqual(new Date('2026-08-02T00:00:00.000Z'));
    expect(dueDateFor(7, assignedAt)).toEqual(new Date('2026-08-09T00:00:00.000Z'));
  });

  it('rolls over month boundaries', () => {
    expect(dueDateFor(30, assignedAt)).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });
});

describe('onboardingProgress / isOnboardingComplete', () => {
  it('counts done and skipped as progress', () => {
    const tasks = [
      { status: 'done' }, { status: 'skipped' }, { status: 'pending' },
    ];
    expect(onboardingProgress(tasks)).toEqual({ done: 2, total: 3 });
    expect(isOnboardingComplete(tasks)).toBe(false);
  });

  it('is complete only when every task is terminal', () => {
    expect(isOnboardingComplete([{ status: 'done' }, { status: 'skipped' }])).toBe(true);
    expect(onboardingProgress([])).toEqual({ done: 0, total: 0 });
    // An empty checklist is never "complete" — there is nothing to celebrate.
    expect(isOnboardingComplete([])).toBe(false);
  });
});

describe('materializeOnboardingTasks', () => {
  const now = new Date('2026-08-02T10:00:00.000Z');
  const template = {
    id: 'tpl-1', org_id: 'org-1', name: 'New hire basics',
    items: [
      { title: 'Sign contract', description: 'HR docs', due_days: 3, sort_order: 0, assignee_role: 'employee' },
      { title: 'Prepare laptop', description: null, due_days: 1, sort_order: 1, assignee_role: 'manager' },
      { title: 'Read handbook', description: null, due_days: null, sort_order: 2, assignee_role: 'employee' },
    ],
  };

  beforeEach(() => {
    prismaMock.onboardingTemplate.findFirst.mockResolvedValue(template);
    prismaMock.user.findFirst.mockResolvedValue({ id: 'hire-1', name: 'New Hire', manager_id: 'mgr-1' });
    prismaMock.onboardingTask.count.mockResolvedValue(0);
    prismaMock.onboardingTask.createMany.mockResolvedValue({ count: 3 });
    createNotificationMock.mockClear();
  });

  it('creates one task per item with resolved assignees and due dates', async () => {
    const result = await materializeOnboardingTasks('org-1', 'hire-1', 'tpl-1', now);

    expect(result).toEqual({ created: 3, skipped: false, assignee_ids: ['hire-1', 'mgr-1'] });
    const rows = prismaMock.onboardingTask.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      expect.objectContaining({
        org_id: 'org-1', user_id: 'hire-1', item_title: 'Sign contract',
        item_description: 'HR docs', assignee_id: 'hire-1',
        due_date: new Date('2026-08-05T00:00:00.000Z'), template_id: 'tpl-1',
      }),
      expect.objectContaining({
        item_title: 'Prepare laptop', assignee_id: 'mgr-1',
        due_date: new Date('2026-08-03T00:00:00.000Z'),
      }),
      expect.objectContaining({ item_title: 'Read handbook', assignee_id: 'hire-1', due_date: null }),
    ]);
  });

  it('notifies each distinct assignee once', async () => {
    await materializeOnboardingTasks('org-1', 'hire-1', 'tpl-1', now);

    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    const payloads = createNotificationMock.mock.calls.map(c => c[0]);
    expect(payloads.map(p => p.userId).sort()).toEqual(['hire-1', 'mgr-1']);
    for (const p of payloads) expect(p.type).toBe('onboarding_assigned');
  });

  it('skips when tasks from the template already exist for the user', async () => {
    prismaMock.onboardingTask.count.mockResolvedValue(2);

    const result = await materializeOnboardingTasks('org-1', 'hire-1', 'tpl-1', now);

    expect(result).toEqual({ created: 0, skipped: true, assignee_ids: [] });
    expect(prismaMock.onboardingTask.createMany).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('routes manager items to the hire when they have no manager', async () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: 'hire-1', name: 'New Hire', manager_id: null });

    const result = await materializeOnboardingTasks('org-1', 'hire-1', 'tpl-1', now);

    expect(result.assignee_ids).toEqual(['hire-1']);
    const rows = prismaMock.onboardingTask.createMany.mock.calls[0][0].data;
    expect(rows.every((r: { assignee_id: string }) => r.assignee_id === 'hire-1')).toBe(true);
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('404s on a missing template or hire', async () => {
    prismaMock.onboardingTemplate.findFirst.mockResolvedValue(null);
    await expect(materializeOnboardingTasks('org-1', 'hire-1', 'tpl-x', now))
      .rejects.toThrow(NotFoundError);

    prismaMock.onboardingTemplate.findFirst.mockResolvedValue(template);
    prismaMock.user.findFirst.mockResolvedValue(null);
    await expect(materializeOnboardingTasks('org-1', 'ghost', 'tpl-1', now))
      .rejects.toThrow(NotFoundError);
  });
});

describe('autoAssignDefaultTemplate', () => {
  beforeEach(() => {
    createNotificationMock.mockClear();
  });

  it('materializes the default template when one exists', async () => {
    prismaMock.onboardingTemplate.findFirst
      .mockResolvedValueOnce({ id: 'tpl-default' }) // default lookup
      .mockResolvedValueOnce({                       // materialize's template load
        id: 'tpl-default', org_id: 'org-1', name: 'Defaults',
        items: [{ title: 'Say hi', description: null, due_days: null, sort_order: 0, assignee_role: 'employee' }],
      });
    prismaMock.user.findFirst.mockResolvedValue({ id: 'hire-1', name: 'New Hire', manager_id: null });
    prismaMock.onboardingTask.count.mockResolvedValue(0);
    prismaMock.onboardingTask.createMany.mockResolvedValue({ count: 1 });

    await autoAssignDefaultTemplate('org-1', 'hire-1');

    expect(prismaMock.onboardingTask.createMany).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the org has no default template', async () => {
    prismaMock.onboardingTemplate.findFirst.mockResolvedValue(null);

    await autoAssignDefaultTemplate('org-1', 'hire-1');

    expect(prismaMock.onboardingTask.createMany).not.toHaveBeenCalled();
  });

  it('never throws — failures are logged instead', async () => {
    prismaMock.onboardingTemplate.findFirst.mockRejectedValue(new Error('db down'));

    await expect(autoAssignDefaultTemplate('org-1', 'hire-1')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
