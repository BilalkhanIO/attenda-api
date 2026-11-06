import prisma from '../utils/prisma';

/**
 * Recalculate a goal from project tasks visible to the same organization.
 * Both sides are tenant-scoped: this prevents a malformed/stale task link
 * from changing another organization's goal or including its tasks.
 */
export async function refreshProjectGoalProgress(goalId: string, orgId: string): Promise<void> {
  const goal = await prisma.performanceGoal.findFirst({
    where: { id: goalId, user: { org_id: orgId } },
    select: { id: true },
  });
  if (!goal) return;

  const linkedTasks = await prisma.projectTask.findMany({
    where: { performance_goal_id: goal.id, project: { org_id: orgId } },
    select: { status: true },
  });
  const completion = linkedTasks.length
    ? Math.round(linkedTasks.filter(task => task.status === 'done').length * 100 / linkedTasks.length)
    : 0;

  // Keep the tenant condition on the write too; do not rely on the preceding
  // read as the only authorization boundary.
  await prisma.performanceGoal.updateMany({
    where: { id: goal.id, user: { org_id: orgId } },
    data: { completion },
  });
}
