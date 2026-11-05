import { createHash } from 'node:crypto';
import prisma from '../../utils/prisma';
import { AppError } from '../../utils/response';

function orgMonth(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Atomically reserves one request against the org's monthly quota. */
export async function reserveAiRequest(orgId: string) {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { ai_enabled: true, ai_monthly_request_limit: true, timezone: true } });
  if (!org?.ai_enabled) throw new AppError('AI is disabled by your organization administrator.', 403, 'AI_DISABLED');
  const periodStart = orgMonth(new Date(), org.timezone || 'UTC');
  const rows = await prisma.$queryRaw<Array<{ request_count: number }>>`
    INSERT INTO ai_usage_periods (id, org_id, period_start, request_count, prompt_tokens, completion_tokens, total_tokens, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${orgId}, ${periodStart}::date, 1, 0, 0, 0, NOW(), NOW())
    ON CONFLICT (org_id, period_start) DO UPDATE
    SET request_count = ai_usage_periods.request_count + 1, updated_at = NOW()
    WHERE ${org.ai_monthly_request_limit}::int IS NULL OR ai_usage_periods.request_count < ${org.ai_monthly_request_limit}::int
    RETURNING request_count
  `;
  if (!rows.length) throw new AppError('Your organization has reached its monthly AI request limit.', 429, 'AI_QUOTA_EXCEEDED');
  return { periodStart, requestCount: Number(rows[0].request_count) };
}

export async function addAiTokenUsage(orgId: string, periodStart: Date, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  if (!usage) return;
  const prompt = Math.max(0, Math.trunc(usage.prompt_tokens ?? 0));
  const completion = Math.max(0, Math.trunc(usage.completion_tokens ?? 0));
  const total = Math.max(0, Math.trunc(usage.total_tokens ?? prompt + completion));
  await prisma.aiUsagePeriod.update({ where: { org_id_period_start: { org_id: orgId, period_start: periodStart } }, data: {
    prompt_tokens: { increment: BigInt(prompt) }, completion_tokens: { increment: BigInt(completion) }, total_tokens: { increment: BigInt(total) },
  } });
}

export async function auditAiTool(input: { orgId: string; actorUserId: string; conversationId: string; toolName: string; args: unknown; success: boolean }) {
  const normalize = (value: unknown): unknown => Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]))
      : value;
  const canonical = JSON.stringify(normalize(input.args));
  await prisma.aiToolAudit.create({ data: {
    org_id: input.orgId,
    actor_user_id: input.actorUserId,
    on_behalf_of: input.actorUserId,
    conversation_id: input.conversationId,
    tool_name: input.toolName,
    arguments_hash: createHash('sha256').update(canonical ?? 'null').digest('hex'),
    success: input.success,
  } });
}

export async function getAiUsage(orgId: string) {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { ai_monthly_request_limit: true, timezone: true } });
  const current = orgMonth(new Date(), org?.timezone || 'UTC');
  const periods = await prisma.aiUsagePeriod.findMany({ where: { org_id: orgId }, orderBy: { period_start: 'desc' }, take: 12 });
  const thisMonth = periods.find(period => period.period_start.getTime() === current.getTime());
  return {
    current: { period_start: current.toISOString().slice(0, 10), requests: thisMonth?.request_count ?? 0, prompt_tokens: String(thisMonth?.prompt_tokens ?? 0), completion_tokens: String(thisMonth?.completion_tokens ?? 0), total_tokens: String(thisMonth?.total_tokens ?? 0), request_limit: org?.ai_monthly_request_limit ?? null },
    history: periods.map(period => ({ period_start: period.period_start.toISOString().slice(0, 10), requests: period.request_count, prompt_tokens: String(period.prompt_tokens), completion_tokens: String(period.completion_tokens), total_tokens: String(period.total_tokens) })),
  };
}
