jest.mock('../../utils/prisma', () => ({
  __esModule: true,
  default: {
    performanceGoal: { findFirst: jest.fn(), updateMany: jest.fn() },
    projectTask: { findMany: jest.fn() },
  },
}));

import prisma from '../../utils/prisma';
import { refreshProjectGoalProgress } from '../../services/projectGoalProgress';

const db = prisma as unknown as {
  performanceGoal: { findFirst: jest.Mock; updateMany: jest.Mock };
  projectTask: { findMany: jest.Mock };
};

describe('refreshProjectGoalProgress tenant boundaries', () => {
  const tx = db as unknown as Parameters<typeof refreshProjectGoalProgress>[0];
  beforeEach(() => jest.clearAllMocks());

  it('does not read tasks or write when the goal belongs to another organization', async () => {
    db.performanceGoal.findFirst.mockResolvedValue(null);

    await refreshProjectGoalProgress(tx, 'goal-from-org-b', 'org-a');

    expect(db.performanceGoal.findFirst).toHaveBeenCalledWith({
      where: { id: 'goal-from-org-b', user: { org_id: 'org-a' } },
      select: { id: true },
    });
    expect(db.projectTask.findMany).not.toHaveBeenCalled();
    expect(db.performanceGoal.updateMany).not.toHaveBeenCalled();
  });

  it('counts only same-organization tasks and keeps the tenant predicate on update', async () => {
    db.performanceGoal.findFirst.mockResolvedValue({ id: 'goal-a' });
    db.projectTask.findMany.mockResolvedValue([{ status: 'done' }, { status: 'todo' }]);
    db.performanceGoal.updateMany.mockResolvedValue({ count: 1 });

    await refreshProjectGoalProgress(tx, 'goal-a', 'org-a');

    expect(db.projectTask.findMany).toHaveBeenCalledWith({
      where: { performance_goal_id: 'goal-a', project: { org_id: 'org-a' } },
      select: { status: true },
    });
    expect(db.performanceGoal.updateMany).toHaveBeenCalledWith({
      where: { id: 'goal-a', user: { org_id: 'org-a' } },
      data: { completion: 50 },
    });
  });
});
