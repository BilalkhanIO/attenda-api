import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';

function previousDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() - 1));
}

export type PayRateBasis = 'hourly' | 'daily' | 'monthly';

/** Write an effective-dated rate while preserving a non-overlapping timeline. */
export async function setEffectivePayRate(input: {
  tx: Prisma.TransactionClient; orgId: string; userId: string; amount: number;
  basis: PayRateBasis; currency: string; effectiveFrom: Date; actorId: string;
}) {
  const { tx, orgId, userId, amount, basis, currency, effectiveFrom, actorId } = input;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${userId}))`;
  const sameDay = await tx.payRate.findUnique({ where: { user_id_effective_from: { user_id: userId, effective_from: effectiveFrom } } });
  const following = await tx.payRate.findFirst({
    where: { org_id: orgId, user_id: userId, effective_from: { gt: effectiveFrom } },
    orderBy: { effective_from: 'asc' }, select: { effective_from: true },
  });
  const effectiveTo = following ? previousDay(following.effective_from) : null;
  if (sameDay) return tx.payRate.update({ where: { id: sameDay.id }, data: { amount, basis, currency, effective_to: effectiveTo, source: 'manual', created_by: actorId } });

  const previous = await tx.payRate.findFirst({
    where: { org_id: orgId, user_id: userId, effective_from: { lt: effectiveFrom }, OR: [{ effective_to: null }, { effective_to: { gte: effectiveFrom } }] },
    orderBy: { effective_from: 'desc' },
  });
  if (previous) {
    const closeOn = previousDay(effectiveFrom);
    if (closeOn < previous.effective_from) throw new Error('Effective pay rate ranges cannot overlap.');
    await tx.payRate.update({ where: { id: previous.id }, data: { effective_to: closeOn } });
  }
  return tx.payRate.create({ data: {
    org_id: orgId, user_id: userId, amount, basis, currency,
    effective_from: effectiveFrom, effective_to: effectiveTo, created_by: actorId, source: 'manual',
  } });
}

/** Backwards-compatible helper for older callers that explicitly set hourly rates. */
export function setEffectiveHourlyRate(input: Omit<Parameters<typeof setEffectivePayRate>[0], 'basis'>) {
  return setEffectivePayRate({ ...input, basis: 'hourly' });
}

export async function getEffectiveHourlyRate(orgId: string, userId: string, at: Date, fallback: number) {
  const rate = await prisma.payRate.findFirst({
    where: { org_id: orgId, user_id: userId, effective_from: { lte: at }, OR: [{ effective_to: null }, { effective_to: { gte: at } }] },
    orderBy: { effective_from: 'desc' },
  });
  return { hourlyRate: rate ? Number(rate.amount) : fallback, rateId: rate?.id ?? null, currency: rate?.currency ?? null };
}
