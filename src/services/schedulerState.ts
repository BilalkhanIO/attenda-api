import prisma from '../utils/prisma';

const MARKER_LEASE_MS = 15 * 60_000;

export async function claimSchedulerMarker(input: { orgId: string; jobKey: string; subjectId: string; periodKey: string }): Promise<string | null> {
  const unique = { org_id_job_key_subject_id_period_key: { org_id: input.orgId, job_key: input.jobKey, subject_id: input.subjectId, period_key: input.periodKey } };
  const now = new Date();
  try {
    const marker = await prisma.schedulerJobMarker.create({ data: { org_id: input.orgId, job_key: input.jobKey, subject_id: input.subjectId, period_key: input.periodKey, status: 'processing', attempts: 1, locked_at: now } });
    return marker.id;
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
  const marker = await prisma.schedulerJobMarker.findUnique({ where: unique });
  if (!marker || marker.status === 'sent') return null;
  const acquired = await prisma.schedulerJobMarker.updateMany({
    where: { id: marker.id, status: { not: 'sent' }, OR: [{ status: { not: 'processing' } }, { locked_at: { lt: new Date(now.getTime() - MARKER_LEASE_MS) } }] },
    data: { status: 'processing', attempts: { increment: 1 }, locked_at: now, last_error: null },
  });
  return acquired.count === 1 ? marker.id : null;
}

export async function completeSchedulerMarker(id: string): Promise<void> {
  await prisma.schedulerJobMarker.updateMany({ where: { id, status: 'processing' }, data: { status: 'sent', sent_at: new Date(), last_error: null } });
}

export async function retrySchedulerMarker(id: string, error: unknown): Promise<void> {
  await prisma.schedulerJobMarker.updateMany({ where: { id, status: 'processing' }, data: { status: 'pending', locked_at: new Date(0), last_error: String(error).slice(0, 4000) } });
}

export function startSchedulerMarkerCleanup(): void {
  setInterval(() => {
    void prisma.schedulerJobMarker.deleteMany({ where: { created_at: { lt: new Date(Date.now() - 90 * 86_400_000) } } })
      .catch(error => console.error('[JOB] Scheduler marker cleanup failed:', error));
  }, 24 * 60 * 60_000).unref();
}
