import prisma from '../utils/prisma';
import { jobLogger } from '../utils/logger';

/**
 * Org-configurable late/absence policy, stored as organisations.late_policy:
 *
 *   {
 *     "absent_after_mins": 120,          // no check-in this long after shift start ⇒ absent
 *     "tiers": [                          // lateness severity → points
 *       { "after_mins": 5,  "points": 1 },
 *       { "after_mins": 30, "points": 2 },
 *       { "after_mins": 60, "points": 3 }
 *     ],
 *     "points_window_days": 30,           // rolling window for totals
 *     "alert_threshold_points": 6         // nightly scan alerts manager+HR at/over this
 *   }
 *
 * Grace before "late" stays where it already lives (shift.late_tolerance_mins,
 * org.late_threshold). Everything here is optional — orgs without a policy
 * keep today's behavior exactly.
 */

export interface LateTier {
  after_mins: number;
  points: number;
}

export interface LatePolicy {
  absent_after_mins?: number;
  tiers?: LateTier[];
  points_window_days?: number;
  alert_threshold_points?: number;
}

export const DEFAULT_ABSENT_AFTER_MINS = 120;
export const DEFAULT_POINTS_WINDOW_DAYS = 30;

/** Parse and sanity-check an org's late_policy JSON; null when unusable. */
export function parseLatePolicy(raw: unknown): LatePolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const out: LatePolicy = {};

  const absentAfter = Number(p.absent_after_mins);
  if (Number.isFinite(absentAfter) && absentAfter >= 30 && absentAfter <= 720) {
    out.absent_after_mins = absentAfter;
  }

  if (Array.isArray(p.tiers)) {
    const tiers = p.tiers
      .map(t => (t && typeof t === 'object' ? t as Record<string, unknown> : null))
      .filter((t): t is Record<string, unknown> => !!t)
      .map(t => ({ after_mins: Number(t.after_mins), points: Number(t.points) }))
      .filter(t => Number.isFinite(t.after_mins) && t.after_mins >= 1
                && Number.isFinite(t.points) && t.points > 0 && t.points <= 100)
      .sort((a, b) => a.after_mins - b.after_mins);
    if (tiers.length) out.tiers = tiers;
  }

  const windowDays = Number(p.points_window_days);
  if (Number.isFinite(windowDays) && windowDays >= 7 && windowDays <= 365) {
    out.points_window_days = windowDays;
  }

  const threshold = Number(p.alert_threshold_points);
  if (Number.isFinite(threshold) && threshold > 0) {
    out.alert_threshold_points = threshold;
  }

  return Object.keys(out).length ? out : null;
}

/** Points for one late arrival: the highest tier whose after_mins is reached. */
export function pointsForLateness(lateMins: number, tiers: LateTier[] | undefined): number {
  if (!tiers?.length || lateMins <= 0) return 0;
  let points = 0;
  for (const tier of tiers) {
    if (lateMins >= tier.after_mins) points = tier.points;
  }
  return points;
}

export interface LateSummaryRow {
  user_id: string;
  name: string;
  department: string | null;
  late_count: number;
  total_late_minutes: number;
  points: number;
}

/** Rolling late/points totals per user, computed from attendance records. */
export async function lateSummaryForOrg(
  orgId: string,
  policy: LatePolicy | null,
  windowDays = policy?.points_window_days ?? DEFAULT_POINTS_WINDOW_DAYS,
  userIds?: string[],
): Promise<LateSummaryRow[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const records = await prisma.attendanceRecord.findMany({
    where: {
      org_id: orgId,
      date: { gte: since },
      late_minutes: { gt: 0 },
      ...(userIds ? { user_id: { in: userIds } } : {}),
    },
    select: {
      user_id: true,
      late_minutes: true,
      user: { select: { name: true, department: true } },
    },
  });

  const byUser = new Map<string, LateSummaryRow>();
  for (const r of records) {
    const lateMins = r.late_minutes ?? 0;
    const row = byUser.get(r.user_id) ?? {
      user_id: r.user_id,
      name: r.user.name,
      department: r.user.department,
      late_count: 0,
      total_late_minutes: 0,
      points: 0,
    };
    row.late_count++;
    row.total_late_minutes += lateMins;
    row.points += pointsForLateness(lateMins, policy?.tiers);
    byUser.set(r.user_id, row);
  }
  return [...byUser.values()].sort((a, b) => b.points - a.points || b.late_count - a.late_count);
}

const ALERT_DEDUP_DAYS = 7;

/**
 * Nightly pattern scan: for each org with an alert threshold, compute the
 * rolling points per user and notify their manager + HR admins when the
 * threshold is met. Deduped per user via the notifications table (one
 * alert per ALERT_DEDUP_DAYS regardless of instance count).
 */
export async function runLatePatternScan(now = new Date()): Promise<{ orgs: number; alerts: number }> {
  let orgsScanned = 0;
  let alertsSent = 0;

  const orgs = await prisma.organisation.findMany({
    where: { late_policy: { not: undefined } },
    select: { id: true, late_policy: true },
  });

  for (const org of orgs) {
    const policy = parseLatePolicy(org.late_policy);
    if (!policy?.alert_threshold_points || !policy.tiers?.length) continue;
    orgsScanned++;

    const summary = await lateSummaryForOrg(org.id, policy);
    const flagged = summary.filter(row => row.points >= policy.alert_threshold_points!);
    if (!flagged.length) continue;

    const { createNotification } = await import('./notifications');
    const dedupSince = new Date(now.getTime() - ALERT_DEDUP_DAYS * 24 * 60 * 60 * 1000);

    for (const row of flagged) {
      const already = await prisma.inAppNotification.findFirst({
        where: {
          org_id: org.id,
          type: 'late_pattern',
          action_id: row.user_id,
          created_at: { gte: dedupSince },
        },
        select: { id: true },
      });
      if (already) continue;

      const user = await prisma.user.findUnique({
        where: { id: row.user_id },
        select: { manager_id: true },
      });
      const hrAdmins = await prisma.user.findMany({
        where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true, deleted_at: null },
        select: { id: true },
      });
      const recipients = new Set<string>(hrAdmins.map(a => a.id));
      if (user?.manager_id) recipients.add(user.manager_id);

      const windowDays = policy.points_window_days ?? DEFAULT_POINTS_WINDOW_DAYS;
      for (const recipientId of recipients) {
        await createNotification({
          userId: recipientId,
          orgId: org.id,
          type: 'late_pattern',
          title: 'Repeated lateness pattern',
          body: `${row.name} reached ${row.points} lateness points (${row.late_count} late arrivals in the last ${windowDays} days)`,
          actionType: 'attendance',
          actionId: row.user_id,
        }).catch(() => {});
        alertsSent++;
      }
    }
  }

  jobLogger.info({ orgs: orgsScanned, alerts: alertsSent }, 'late pattern scan complete');
  return { orgs: orgsScanned, alerts: alertsSent };
}
