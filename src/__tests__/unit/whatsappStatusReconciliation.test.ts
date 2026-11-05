const findUniqueMock = jest.fn();
const updateMock = jest.fn();

jest.mock('../../utils/prisma', () => ({
  __esModule: true,
  default: { whatsappLog: { findUnique: (...args: unknown[]) => findUniqueMock(...args), update: (...args: unknown[]) => updateMock(...args) } },
}));
jest.mock('../../services/whatsappUsage', () => ({ reserveWhatsAppAttempt: jest.fn() }));

import { reconcileWhatsAppStatuses } from '../../services/whatsapp';

const payload = (...statuses: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { statuses } }] }],
});

describe('WhatsApp provider status reconciliation', () => {
  beforeEach(() => { findUniqueMock.mockReset(); updateMock.mockReset(); });

  it('stores provider delivery and pricing metadata for a known sent message', async () => {
    findUniqueMock.mockResolvedValue({ id: 'log-1', provider_status: 'accepted', provider_status_at: null });
    updateMock.mockResolvedValue({});

    const count = await reconcileWhatsAppStatuses(payload({
      id: 'wamid.1', status: 'delivered', timestamp: '1793900000',
      pricing: { category: 'utility', type: 'regular', billable: true },
    }));

    expect(count).toBe(1);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'log-1' },
      data: expect.objectContaining({
        provider_status: 'delivered', pricing_category: 'utility', pricing_model: 'regular', pricing_billable: true,
      }),
    }));
  });

  it('ignores unknown messages and stale or regressive callbacks', async () => {
    findUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'log-1', provider_status: 'delivered', provider_status_at: new Date(1_793_900_000_000) })
      .mockResolvedValueOnce({ id: 'log-1', provider_status: 'delivered', provider_status_at: new Date(1_793_900_000_000) });

    const count = await reconcileWhatsAppStatuses(payload(
      { id: 'unknown', status: 'read', timestamp: '1793900001' },
      { id: 'wamid.1', status: 'sent', timestamp: '1793900001' },
      { id: 'wamid.1', status: 'read', timestamp: '1793899999' },
    ));

    expect(count).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
