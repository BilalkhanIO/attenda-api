// Document vault helpers — key building, mime/size gates, and the
// expiry-window matcher that drives the daily reminder scan.
// prisma/logger/s3 are mocked so importing the service stays side-effect free.

const prismaMock = {
  employeeDocument:  { findMany: jest.fn() },
  inAppNotification: { findFirst: jest.fn(), create: jest.fn() },
};

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  logger:    { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  jobLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../services/s3', () => ({
  S3Keys: {
    document: (orgId: string, userId: string, unique: string, fileName: string) =>
      `documents/${orgId}/${userId}/${unique}-${fileName}`,
  },
}));

import {
  MAX_DOCUMENT_BYTES,
  isAllowedDocumentMime,
  documentKeyPrefix,
  sanitizeFileName,
  buildDocumentKey,
  daysUntilExpiry,
  expiryWindowFor,
  runDocumentExpiryScan,
  DOCUMENT_EXPIRY_WINDOWS,
} from '../../services/documents';

describe('upload gates', () => {
  it('caps documents at 20MB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(20 * 1024 * 1024);
  });

  it('allows pdf, images, and office documents only', () => {
    for (const mime of [
      'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(isAllowedDocumentMime(mime)).toBe(true);
    }
    expect(isAllowedDocumentMime('application/zip')).toBe(false);
    expect(isAllowedDocumentMime('text/html')).toBe(false);
    expect(isAllowedDocumentMime('image/svg+xml')).toBe(false);
    expect(isAllowedDocumentMime('')).toBe(false);
  });
});

describe('key building', () => {
  it('sanitizes unsafe filename characters', () => {
    expect(sanitizeFileName('my contract (final).pdf')).toBe('my_contract_final_.pdf');
    expect(sanitizeFileName('résumé.pdf')).toBe('r_sum_.pdf');
    expect(sanitizeFileName('///')).toBe('file');
    expect(sanitizeFileName('')).toBe('file');
  });

  it('keeps the extension end of very long names', () => {
    const long = 'a'.repeat(300) + '.pdf';
    const safe = sanitizeFileName(long);
    expect(safe.length).toBe(120);
    expect(safe.endsWith('.pdf')).toBe(true);
  });

  it('builds keys under the org/user prefix', () => {
    const key = buildDocumentKey('org-1', 'user-1', 'visa copy.pdf', 'uuid-1');
    expect(key).toBe('documents/org-1/user-1/uuid-1-visa_copy.pdf');
    expect(key.startsWith(documentKeyPrefix('org-1', 'user-1'))).toBe(true);
    // Prefix check is what POST /documents relies on — a foreign user's key must not match.
    expect(key.startsWith(documentKeyPrefix('org-1', 'user-2'))).toBe(false);
    expect(key.startsWith(documentKeyPrefix('org-2', 'user-1'))).toBe(false);
  });

  it('generates a unique segment when none is given', () => {
    const a = buildDocumentKey('org-1', 'user-1', 'id.png');
    const b = buildDocumentKey('org-1', 'user-1', 'id.png');
    expect(a).not.toBe(b);
  });
});

describe('expiry-window matcher', () => {
  const now = new Date('2026-08-02T03:00:00.000Z');

  it('measures whole days on UTC dates, ignoring time of day', () => {
    expect(daysUntilExpiry(new Date('2026-09-01T00:00:00.000Z'), now)).toBe(30);
    expect(daysUntilExpiry(new Date('2026-08-09T00:00:00.000Z'), new Date('2026-08-02T23:59:59.000Z'))).toBe(7);
    expect(daysUntilExpiry(new Date('2026-08-01T00:00:00.000Z'), now)).toBe(-1);
  });

  it('matches only the exact 30- and 7-day marks', () => {
    expect(DOCUMENT_EXPIRY_WINDOWS).toEqual([30, 7]);
    expect(expiryWindowFor(new Date('2026-09-01T00:00:00.000Z'), now)).toBe(30);
    expect(expiryWindowFor(new Date('2026-08-09T00:00:00.000Z'), now)).toBe(7);
    expect(expiryWindowFor(new Date('2026-08-31T00:00:00.000Z'), now)).toBeNull(); // 29 days
    expect(expiryWindowFor(new Date('2026-08-10T00:00:00.000Z'), now)).toBeNull(); // 8 days
    expect(expiryWindowFor(new Date('2026-08-02T00:00:00.000Z'), now)).toBeNull(); // today
    expect(expiryWindowFor(null, now)).toBeNull();
    expect(expiryWindowFor(undefined, now)).toBeNull();
  });
});

describe('runDocumentExpiryScan', () => {
  const now = new Date('2026-08-02T03:00:00.000Z');
  const baseDoc = {
    id: 'doc-1', org_id: 'org-1', user_id: 'owner-1', uploaded_by: 'hr-1',
    title: 'Work visa', category: 'visa',
    expires_at: new Date('2026-09-01T00:00:00.000Z'), // exactly 30 days out
  };

  beforeEach(() => {
    prismaMock.inAppNotification.create.mockResolvedValue({});
  });

  it('queries the two exact target dates', async () => {
    prismaMock.employeeDocument.findMany.mockResolvedValue([]);
    await runDocumentExpiryScan(now);
    const where = prismaMock.employeeDocument.findMany.mock.calls[0][0].where;
    expect(where.deleted_at).toBeNull();
    expect(where.expires_at.in).toEqual([
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-08-09T00:00:00.000Z'),
    ]);
  });

  it('notifies owner and uploader once each', async () => {
    prismaMock.employeeDocument.findMany.mockResolvedValue([baseDoc]);
    prismaMock.inAppNotification.findFirst.mockResolvedValue(null);

    const result = await runDocumentExpiryScan(now);

    expect(result).toEqual({ scanned: 1, notified: 2 });
    expect(prismaMock.inAppNotification.create).toHaveBeenCalledTimes(2);
    const recipients = prismaMock.inAppNotification.create.mock.calls.map(c => c[0].data.user_id);
    expect(recipients.sort()).toEqual(['hr-1', 'owner-1']);
    const first = prismaMock.inAppNotification.create.mock.calls[0][0].data;
    expect(first.type).toBe('document_expiring');
    expect(first.body).toContain('30 days');
    expect(first.body).toContain('2026-09-01');
    expect(first.action_id).toBe('doc-1');
  });

  it('collapses owner === uploader into a single notification', async () => {
    prismaMock.employeeDocument.findMany.mockResolvedValue([
      { ...baseDoc, uploaded_by: 'owner-1' },
    ]);
    prismaMock.inAppNotification.findFirst.mockResolvedValue(null);

    const result = await runDocumentExpiryScan(now);
    expect(result.notified).toBe(1);
    expect(prismaMock.inAppNotification.create).toHaveBeenCalledTimes(1);
  });

  it('dedupes documents already alerted recently', async () => {
    prismaMock.employeeDocument.findMany.mockResolvedValue([baseDoc]);
    prismaMock.inAppNotification.findFirst.mockResolvedValue({ id: 'notif-1' });

    const result = await runDocumentExpiryScan(now);
    expect(result).toEqual({ scanned: 1, notified: 0 });
    expect(prismaMock.inAppNotification.create).not.toHaveBeenCalled();
  });
});
