import { verifyQrCode } from '../../services/qrcode';
import { createHmac } from 'crypto';

const QR_SECRET = process.env.JWT_SECRET || 'qr-dev-secret';

function buildValidQr(orgId: string, offsetSeconds = 0): string {
  const ts        = Math.floor(Date.now() / 1000) + offsetSeconds;
  const expiresAt = ts + 86400;
  const data      = `attenda:${orgId}:${expiresAt}`;
  const sig       = createHmac('sha256', QR_SECRET).update(data).digest('hex').substring(0, 16);
  return `${data}:${sig}`;
}

describe('QR Code Service', () => {
  const orgId = 'org-123';

  describe('verifyQrCode', () => {
    it('returns valid for a correctly formed, unexpired QR code', () => {
      const qr     = buildValidQr(orgId);
      const result = verifyQrCode(qr, orgId);
      expect(result.valid).toBe(true);
    });

    it('rejects QR code for wrong org', () => {
      const qr     = buildValidQr('other-org');
      const result = verifyQrCode(qr, orgId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('different organisation');
    });

    it('rejects expired QR code', () => {
      // Build a QR that has already expired (timestamp in the past)
      const ts        = Math.floor(Date.now() / 1000) - 100; // expired 100s ago
      const data      = `attenda:${orgId}:${ts}`;
      const sig       = createHmac('sha256', QR_SECRET).update(data).digest('hex').substring(0, 16);
      const qr        = `${data}:${sig}`;
      const result    = verifyQrCode(qr, orgId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('rejects QR code with invalid signature', () => {
      const qr     = buildValidQr(orgId);
      const tampered = qr.slice(0, -4) + 'xxxx'; // corrupt last 4 chars of sig
      const result = verifyQrCode(tampered, orgId);
      expect(result.valid).toBe(false);
    });

    it('rejects malformed QR code', () => {
      const result = verifyQrCode('not:valid', orgId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid QR code format');
    });

    it('rejects empty string', () => {
      const result = verifyQrCode('', orgId);
      expect(result.valid).toBe(false);
    });
  });
});
