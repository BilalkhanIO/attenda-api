// Outbound webhook delivery — signature helper, auto-disable threshold, and
// success/failure bookkeeping (prisma + fetch mocked).

const updateMock = jest.fn();
const findManyMock = jest.fn();

jest.mock('../../utils/prisma', () => ({
  __esModule: true,
  default: {
    orgWebhook: {
      update: (...args: unknown[]) => updateMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

import { createHmac } from 'crypto';
import {
  AUTO_DISABLE_THRESHOLD,
  WEBHOOK_EVENT_TYPES,
  deliverToWebhook,
  dispatchOrgWebhooks,
  generateWebhookSecret,
  shouldAutoDisable,
  signWebhookPayload,
} from '../../services/webhookDelivery';

const hook = { id: 'wh-1', url: 'https://example.com/hook', secret: 's3cret', failure_count: 0 };

describe('generateWebhookSecret', () => {
  it('returns 64 hex chars (32 random bytes) and never repeats', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('signWebhookPayload', () => {
  it('produces the hex HMAC-SHA256 of the raw body under the secret', () => {
    const body = JSON.stringify({ event: 'leave_changed', org_id: 'o1', timestamp: 'now' });
    const expected = createHmac('sha256', 'topsecret').update(body).digest('hex');
    expect(signWebhookPayload('topsecret', body)).toBe(expected);
  });

  it('changes when either the secret or the body changes', () => {
    const sig = signWebhookPayload('a', 'body');
    expect(signWebhookPayload('b', 'body')).not.toBe(sig);
    expect(signWebhookPayload('a', 'body2')).not.toBe(sig);
  });
});

describe('shouldAutoDisable', () => {
  it('stays active below the threshold', () => {
    expect(shouldAutoDisable(0)).toBe(false);
    expect(shouldAutoDisable(AUTO_DISABLE_THRESHOLD - 1)).toBe(false);
  });

  it('disables at and beyond 20 consecutive failures', () => {
    expect(AUTO_DISABLE_THRESHOLD).toBe(20);
    expect(shouldAutoDisable(20)).toBe(true);
    expect(shouldAutoDisable(21)).toBe(true);
  });
});

describe('deliverToWebhook', () => {
  beforeEach(() => {
    updateMock.mockResolvedValue({});
  });

  it('signs the payload, and on 2xx resets the failure streak', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const delivered = await deliverToWebhook(hook, 'leave_changed', 'org-1');
    expect(delivered).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(hook.url);
    const body = init.body as string;
    expect(JSON.parse(body)).toMatchObject({ event: 'leave_changed', org_id: 'org-1' });
    expect((init.headers as Record<string, string>)['X-Attenda-Signature'])
      .toBe(signWebhookPayload(hook.secret, body));

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: hook.id },
      data: expect.objectContaining({ failure_count: 0, last_success_at: expect.any(Date) }),
    }));
    fetchMock.mockRestore();
  });

  it('on failure increments the streak without disabling below the cap', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const delivered = await deliverToWebhook({ ...hook, failure_count: 3 }, 'swap_changed', 'org-1');
    expect(delivered).toBe(false);

    const data = updateMock.mock.calls[0][0].data;
    expect(data.failure_count).toBe(4);
    expect(data.last_failure_at).toBeInstanceOf(Date);
    expect(data.is_active).toBeUndefined();
    fetchMock.mockRestore();
  });

  it('auto-disables on the 20th consecutive failure (non-ok responses count)', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response);
    await deliverToWebhook({ ...hook, failure_count: 19 }, 'expense_changed', 'org-1');

    const data = updateMock.mock.calls[0][0].data;
    expect(data.failure_count).toBe(20);
    expect(data.is_active).toBe(false);
    fetchMock.mockRestore();
  });

  it('never throws when even the bookkeeping write fails', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));
    updateMock.mockRejectedValue(new Error('db down'));
    await expect(deliverToWebhook(hook, 'leave_changed', 'org-1')).resolves.toBe(false);
    fetchMock.mockRestore();
  });
});

describe('dispatchOrgWebhooks', () => {
  it('loads only active hooks of the org subscribed to the event type', async () => {
    findManyMock.mockResolvedValue([]);
    await dispatchOrgWebhooks('org-9', 'attendance_changed');
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { org_id: 'org-9', is_active: true, events: { has: 'attendance_changed' } },
    }));
  });
});

describe('WEBHOOK_EVENT_TYPES', () => {
  it('covers exactly the six subscribable org event types', () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual([
      'attendance_changed', 'expense_changed', 'leave_changed',
      'overtime_changed', 'remote_changed', 'swap_changed',
    ]);
  });
});
