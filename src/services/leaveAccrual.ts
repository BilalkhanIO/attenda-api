import prisma from '../utils/prisma';
import { jobLogger } from '../utils/logger';

export interface AccrualPolicy {
  days_per_year: number;
  carry_over_max?: number;
}

export type AccrualConfig = Record<string, AccrualPolicy>;

/** Parse and sanity-check an org's leave_accrual JSON; null when unusable. */
export function parseAccrualConfig(raw: unknown): AccrualConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: AccrualConfig = {};
  for (const [type, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const p = val as Record<string, unknown>;
    const perYear = Number(p.days_per_year);
    if (!Number.isFinite(perYear) || perYear <= 0 || perYear > 366) continue;
    const carry = p.carry_over_max === undefined ? undefined : Number(p.carry_over_max);
    out[type] = {
      days_per_year: perYear,
      ...(carry !== undefined && Number.isFinite(carry) && carry >= 0 ? { carry_over_max: carry } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

/** One month's accrual increment, rounded to 2dp (pro-rata of the annual rate). */
export function monthlyIncrement(policy: AccrualPolicy): number {
  return Math.round((policy.days_per_year / 12) * 100) / 100;
}

/** Days carried into a new year from last year's unused balance. */
export function carryOver(policy: AccrualPolicy, priorTotal: number, priorUsed: number): number {
  const unused = Math.max(0, priorTotal - priorUsed);
  const cap = policy.carry_over_max ?? 0;
  return Math.round(Math.min(unused, cap) * 100) / 100;
}

/**
 * Monthly accrual run (scheduled on the 1st). For each org with a policy,
 * for each active user and configured type:
 * - January: create this year's balance seeded with capped carry-over from
 *   last year, plus this month's increment.
 * - Other months: increment total_days on this year's row (creating it
 *   pro-rata-empty first if the user joined mid-year).
 * Idempotence: the scheduler's Redis tick-lock prevents double runs per
 * minute; the job itself runs once per month by schedule.
 */
export async function runMonthlyAccrual(now = new Date()): Promise<{ orgs: number; balances: number }> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  let orgsProcessed = 0;
  let balancesTouched = 0;

  const orgs = await prisma.organisation.findMany({
    where: { leave_accrual: { not: undefined } },
    select: { id: true, leave_accrual: true },
  });

  for (const org of orgs) {
    const config = parseAccrualConfig(org.leave_accrual);
    if (!config) continue;
    orgsProcessed++;

    const users = await prisma.user.findMany({
      where: { org_id: org.id, is_active: true, deleted_at: null },
      select: { id: true },
    });

    for (const user of users) {
      for (const [type, policy] of Object.entries(config)) {
        const inc = monthlyIncrement(policy);
        const existing = await prisma.leaveBalance.findFirst({
          where: { user_id: user.id, leave_type: type, year },
        });

        if (existing) {
          await prisma.leaveBalance.update({
            where: { id: existing.id },
            data: { total_days: Math.round((existing.total_days + inc) * 100) / 100 },
          });
        } else {
          let seed = inc;
          if (month === 1) {
            const prior = await prisma.leaveBalance.findFirst({
              where: { user_id: user.id, leave_type: type, year: year - 1 },
            });
            if (prior) seed += carryOver(policy, prior.total_days, prior.used_days);
          }
          await prisma.leaveBalance.create({
            data: {
              user_id: user.id, org_id: org.id, leave_type: type, year,
              total_days: Math.round(seed * 100) / 100, used_days: 0,
            },
          });
        }
        balancesTouched++;
      }
    }
  }

  jobLogger.info({ orgs: orgsProcessed, balances: balancesTouched }, 'monthly leave accrual complete');
  return { orgs: orgsProcessed, balances: balancesTouched };
}
