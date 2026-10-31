import prisma from '../utils/prisma';
import { jobLogger } from '../utils/logger';
import { toZonedTime } from 'date-fns-tz';

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

/**
 * leave_balances.total_days/used_days are DECIMAL(6,2) — Prisma returns them
 * as Decimal objects (which serialize to strings). Normalize to a plain
 * number before any arithmetic or JSON response.
 */
export function toDays(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** New total after applying an increment to an existing balance, 2dp. */
export function accruedTotal(existingTotal: unknown, inc: number): number {
  return Math.round((toDays(existingTotal) + inc) * 100) / 100;
}

/** Remaining balance (total - used), 2dp — handles Decimal inputs. */
export function availableDays(total: unknown, used: unknown): number {
  return Math.round((toDays(total) - toDays(used)) * 100) / 100;
}

/** Days carried into a new year from last year's unused balance. */
export function carryOver(policy: AccrualPolicy, priorTotal: number, priorUsed: number): number {
  const unused = Math.max(0, priorTotal - priorUsed);
  const cap = policy.carry_over_max ?? 0;
  return Math.round(Math.min(unused, cap) * 100) / 100;
}

/**
 * Apply one monthly accrual per organization-local calendar period. A unique
 * (org, year, month) run row and the balance mutations share a transaction,
 * so duplicate schedulers either commit the full run once or roll back.
 */
export async function runMonthlyAccrual(
  now = new Date(),
  onlyOrgIds?: string[],
): Promise<{ orgs: number; balances: number; skipped: number }> {
  let orgsProcessed = 0;
  let balancesTouched = 0;
  let skipped = 0;

  const orgs = await prisma.organisation.findMany({
    where: { ...(onlyOrgIds?.length ? { id: { in: onlyOrgIds } } : {}) },
    select: { id: true, timezone: true, leave_accrual: true },
  });

  for (const org of orgs) {
    const config = parseAccrualConfig(org.leave_accrual);
    if (!config) continue;
    const localNow = toZonedTime(now, org.timezone || 'UTC');
    const year = localNow.getFullYear();
    const month = localNow.getMonth() + 1;

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Unique key is the durable idempotency key. Creating it and updating
        // balances in one transaction means a crash cannot leave a half-run.
        await tx.leaveAccrualRun.create({ data: { org_id: org.id, year, month } });
        const users = await tx.user.findMany({
          where: { org_id: org.id, is_active: true, deleted_at: null },
          select: { id: true },
        });
        let touched = 0;

        for (const user of users) {
          for (const [type, policy] of Object.entries(config)) {
            const inc = monthlyIncrement(policy);
            const existing = await tx.leaveBalance.findFirst({
              where: { user_id: user.id, leave_type: type, year },
            });

            if (existing) {
              // Atomic increment preserves concurrent HR adjustments.
              await tx.leaveBalance.update({
                where: { id: existing.id },
                data: { total_days: { increment: inc } },
              });
            } else {
              let seed = inc;
              if (month === 1) {
                const prior = await tx.leaveBalance.findFirst({
                  where: { user_id: user.id, leave_type: type, year: year - 1 },
                });
                if (prior) seed += carryOver(policy, toDays(prior.total_days), toDays(prior.used_days));
              }
              await tx.leaveBalance.create({
                data: {
                  user_id: user.id, org_id: org.id, leave_type: type, year,
                  total_days: Math.round(seed * 100) / 100, used_days: 0,
                },
              });
            }
            touched++;
          }
        }
        return touched;
      });
      orgsProcessed++;
      balancesTouched += result;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        skipped++;
        continue;
      }
      throw error;
    }
  }

  jobLogger.info({ orgs: orgsProcessed, balances: balancesTouched, skipped }, 'monthly leave accrual complete');
  return { orgs: orgsProcessed, balances: balancesTouched, skipped };
}
