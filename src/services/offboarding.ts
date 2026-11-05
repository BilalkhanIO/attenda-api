import prisma from '../utils/prisma';
import { dateOnlyInTz } from '../utils/shift';
import { revokeAllForUser } from './refreshTokens';
import { recordAudit } from './audit';
import { createNotification } from './notifications';
import { jobLogger } from '../utils/logger';

/** Revoke employee access at their last-working-day midnight in organization time. */
export async function processDueOffboardingCases(now = new Date()): Promise<void> {
  const organisations = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
  for (const org of organisations) {
    const localToday = dateOnlyInTz(now, org.timezone || 'UTC');
    const localDayStart = new Date(`${localToday.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const due = await prisma.offboardingCase.findMany({
      where: { org_id: org.id, status: { in: ['in_progress', 'access_revoked'] }, last_working_day: { lte: localDayStart }, sessions_revoked_at: null },
      select: { id: true, user_id: true, opened_by: true, status: true, last_working_day: true, subject: { select: { name: true, manager_id: true } } }, take: 100,
    });
    for (const item of due) {
      try {
        const changed = await prisma.$transaction(async tx => {
          const claim = await tx.offboardingCase.updateMany({ where: { id: item.id, status: { in: ['in_progress', 'access_revoked'] }, sessions_revoked_at: null }, data: { status: 'access_revoked', access_revoked_at: item.status === 'in_progress' ? now : undefined } });
          if (!claim.count) return false;
          await tx.user.updateMany({ where: { id: item.user_id, org_id: org.id, is_active: true }, data: { is_active: false, fcm_token: null, fcm_token_updated_at: null } });
          await tx.shiftAssignment.deleteMany({ where: { org_id: org.id, user_id: item.user_id, date: { gt: localDayStart } } });
          const successorId = item.subject.manager_id;
          await tx.user.updateMany({ where: { org_id: org.id, manager_id: item.user_id }, data: { manager_id: successorId } });
          if (successorId) await tx.projectTask.updateMany({ where: { org_id: org.id, assignee_id: item.user_id, status: { not: 'done' } }, data: { assignee_id: successorId } });
          return true;
        });
        if (!changed) continue;
        await revokeAllForUser(item.user_id);
        await prisma.offboardingCase.updateMany({ where: { id: item.id, status: 'access_revoked', sessions_revoked_at: null }, data: { sessions_revoked_at: now } });
        if (item.status === 'in_progress') {
          recordAudit({ orgId: org.id, actorId: item.opened_by, action: 'offboarding.access.revoke', entityType: 'offboarding_case', entityId: item.id, after: { automated: true, user_id: item.user_id, effective_date: localToday.toISOString().slice(0, 10) } });
          const managers = await prisma.user.findMany({ where: { org_id: org.id, is_active: true, role: { in: ['hr_admin', 'super_admin'] } }, select: { id: true } });
          await Promise.all(managers.map(manager => createNotification({ userId: manager.id, orgId: org.id, type: 'offboarding_access_revoked', title: 'Employee access revoked', body: `${item.subject.name}'s access was revoked on their last working day. Complete the remaining offboarding checklist and settlement.`, actionType: 'offboarding', actionId: item.id })));
        }
        jobLogger.info({ caseId: item.id, userId: item.user_id, orgId: org.id }, 'offboarding access revoked');
      } catch (error) {
        jobLogger.error({ err: error, caseId: item.id, orgId: org.id }, 'offboarding automation failed');
      }
    }
  }
}
